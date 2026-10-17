'use strict';

// Mapping together (web and desktop, on online.js's Supabase project), up to 5 people: COLLABORATE in the menu lists
// everyone logged in; an invite pops up in the corner for the other person (unless they've turned invites off), and
// when they accept, the one who invited (the host) picks the song on the create screen. The song goes to everyone
// (in pieces, over the same connection), all the editors open the same map, and from then on everything is live,
// with no delay held back: notes added, moved and deleted, timing points, bookmarks and extra objects. Each person has
// a colour: you see where the others are in the song (a line on the track and the timeline), their mouse when
// they're in the part of the song you're looking at, what they've selected and what they've just placed. The host
// can invite more people from the editor (INVITE on the bar at the bottom), and they join the map as it is.
//
// Notes are kept in step as changes: each side sends what's been added and removed since what all last agreed on, so
// people editing at once don't overwrite each other, and nobody's selection is touched by what the others do. The host
// also sends a fingerprint of the notes every few seconds; if someone's doesn't match twice running (a lost message),
// the host sends them the whole map again.
window.SSQECollab = (function () {
    const O = () => window.SSQEOnline;
    const CHUNK = 96 * 1024;
    const SEND_EVERY = 33;
    const MAX_PEOPLE = 5;
    const COLORS = [[255, 160, 0], [0, 200, 255], [130, 255, 90], [255, 90, 200]];

    let app = null, s = null;
    const invites = new Map(); // id -> { room, state: 'sent' | 'declined', at }

    const toast = (text, kind = 'other') => app && app.editor ? app.editor.toast(text, kind) : null;
    const rid = () => Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);

    // ------------------------------------------------------------ the notes as keys
    const r3 = v => Math.round(v * 1000) / 1000;
    const keyOf = n => `${r3(n.x)}|${r3(n.y)}|${Math.round(n.ms)}${n.enableEasing ? `|${n.style}|${n.direction}` : ''}`;
    const noteOf = k => {
        const [x, y, ms, st, dir] = k.split('|');
        return new SSQE.Note(+x, +y, +ms, st !== undefined, +(st || 0), +(dir || 0));
    };
    const countKeys = notes => {
        const m = new Map();
        for (const n of notes) {
            const k = keyOf(n);
            m.set(k, (m.get(k) || 0) + 1);
        }
        return m;
    };
    // (a quick fingerprint, the same whatever order the notes are in)
    const hashNotes = notes => {
        let h = notes.length | 0;
        for (const n of notes) {
            let k = (Math.round(n.x * 1000) * 73856093) ^ (Math.round(n.y * 1000) * 19349663) ^ (Math.round(n.ms) * 83492791);
            if (n.enableEasing)
                k ^= (n.style + 1) * 2654435761 ^ (n.direction + 1) * 40503;
            k = Math.imul(k ^ (k >>> 15), 2246822507);
            h = (h + (k ^ (k >>> 13))) | 0;
        }
        return h;
    };
    const extraOf = map => JSON.stringify({
        timings: map.timingPoints.map(t => [t.bpm, t.ms]),
        bookmarks: map.bookmarks.map(b => [b.text, b.ms, b.endMs]),
        vfxObjects: map.vfxObjects.items.map(o => `${o.id}|${o.toString()}`),
        specialObjects: map.specialObjects.items.map(o => `${o.id}|${o.toString()}`),
        exportOffset: map.props.exportOffset,
    });

    // ------------------------------------------------------------ invites

    // (the host and everyone already in, plus invites still waiting for an answer: no more than 5 people)
    const people = () => s ? 1 + s.peers.size : 1;
    const waiting = () => [...invites.values()].filter(v => v.state === 'sent' && Date.now() - v.at < 35000).length;
    const full = () => people() + waiting() >= MAX_PEOPLE;

    async function invite(u) {
        if (s && s.role !== 'host') {
            app.dialogs.message(`Only ${s.host.name}, who started this, can invite people.`);
            return;
        }
        if (full()) {
            app.dialogs.message(`${MAX_PEOPLE} people is the most that can map together.`);
            return;
        }
        if (u.noInvites) {
            app.dialogs.message(`${u.name} has collab invites turned off.`);
            return;
        }
        const room = s ? s.room : rid();
        invites.set(u.id, { room, state: 'sent', at: Date.now() });
        const ok = await O().sendTo(u.id, { type: 'invite', room });
        if (!ok) {
            invites.delete(u.id);
            app.dialogs.message(`Couldn't reach ${u.name}. Try again in a moment.`);
        }
    }
    const inviteState = id => invites.has(id) ? invites.get(id).state : '';

    function onInbox(m) {
        if (!m || !m.from)
            return;
        if (m.type === 'invite') {
            // (invites turned off, or already mapping with someone: a no, without bothering them)
            if (app.settings.allowInvites === false || s) {
                O().sendTo(m.from, { type: 'reply', room: m.room, accept: false, busy: !!s });
                return;
            }
            app.dialogs.invitePopup(m.room, `${m.name} wants to map with you.`, accept => {
                accept = accept && !s;
                O().sendTo(m.from, { type: 'reply', room: m.room, accept });
                if (accept)
                    start('guest', m.room, { id: m.from, name: m.name });
            });
        } else if (m.type === 'reply') {
            const inv = invites.get(m.from);
            if (!inv || inv.room !== m.room)
                return;
            if (m.accept && (!s || s.room === m.room)) {
                invites.delete(m.from);
                if (!s)
                    start('host', m.room, null);
                else
                    toast(`${m.name.toUpperCase()} ACCEPTED - JOINING`);
            } else {
                inv.state = 'declined';
                if (m.busy)
                    toast(`${m.name.toUpperCase()} IS ALREADY MAPPING WITH SOMEONE`, 'warn');
            }
        }
    }

    // ------------------------------------------------------------ a session

    function start(role, room, host) {
        const ch = O().room(room);
        if (!ch)
            return;
        s = {
            role, room, host, ch, ready: false, me: O().userId(), phase: role === 'host' ? 'song' : 'wait',
            peers: new Map(), colorAt: 0,
            // the song (the host's, to send; a guest's, coming in)
            song: null, songBytes: null, songMeta: null, early: null,
            // what all last agreed on, and what was last sent
            map: null, synced: new Map(), hash: 0, extra: '', lastP: '', lastSel: '', lastSend: 0, lastSum: 0, lastLocal: 0, misses: 0,
            started: performance.now(),
        };
        O().setBusy(true);
        ch.on('broadcast', { event: 'c' }, ({ payload }) => {
            try {
                receive(payload);
            } catch (e) {
                console.warn('collab', e);
            }
        });
        ch.subscribe(status => {
            if (status !== 'SUBSCRIBED' || !s || s.ch !== ch)
                return;
            s.ready = true;
            send({ k: 'hi', role });
        });
        // (out of whatever they were doing: a map in the editor is kept, as going back to the menu keeps it)
        if (app.spectating) {
            app.spectating.stop();
            O().unwatch();
            app.spectating = null;
        }
        if (app.editor)
            app.backToMenu();
        if (role === 'host')
            app.openCreate();
        else
            app.showScreen('collabwait');
    }

    function send(p) {
        if (s && s.ready)
            s.ch.send({ type: 'broadcast', event: 'c', payload: { ...p, f: s.me, nm: O().username() } });
    }

    function peerOf(id, name) {
        let p = s.peers.get(id);
        if (!p) {
            p = { id, name, color: COLORS[s.colorAt++ % COLORS.length], other: null, heard: performance.now() };
            s.peers.set(id, p);
        }
        p.name = name || p.name;
        p.heard = performance.now();
        return p;
    }
    function dropPeer(id) {
        const p = s && s.peers.get(id);
        if (!p)
            return;
        s.peers.delete(id);
        if (s.map)
            for (const n of s.map.notes.items)
                if (n.peerSel === p.color)
                    n.peerSel = null;
    }

    function leave(quiet = false) {
        if (!s)
            return;
        if (!quiet)
            send({ k: 'bye' });
        const ch = s.ch, ed = app.editor;
        setTimeout(() => O().closeRoom(ch), 300);
        if (ed) {
            ed.peers = [];
            ed.afterRender = null;
            for (const n of ed.map.notes.items)
                n.peerSel = null;
        }
        const inv = app.dialogs.windows && app.dialogs.windows['collab-invite'];
        if (inv)
            inv.close();
        detachInput();
        s = null;
        O().setBusy(false);
        if (document.body.dataset.screen === 'collabwait')
            app.showMenu();
    }

    // the host has picked the song (the create screen's CREATE MAP)
    async function songChosen(file, id) {
        if (!s || s.role !== 'host' || s.phase !== 'song')
            return;
        s.phase = 'mapping';
        s.map = app.editor && app.editor.map;
        attachEditor();
        const bytes = new Uint8Array(await file.arrayBuffer());
        s.songBytes = bytes;
        s.songMeta = { k: 'song', id, name: file.name, type: file.type || '', size: bytes.length, n: Math.ceil(bytes.length / CHUNK) };
        await sendSong();
    }
    // (the whole song, to everyone waiting for it, or to one person who's just joined)
    async function sendSong(to) {
        if (!s || !s.songMeta)
            return;
        send({ ...s.songMeta, to });
        for (let i = 0; i < s.songMeta.n && s; i++) {
            sendChunk(i, to);
            // (about 20 pieces a second: well within what the connection allows)
            await new Promise(r => setTimeout(r, 50));
        }
    }
    function sendChunk(i, to) {
        if (!s || !s.songBytes)
            return;
        const part = s.songBytes.subarray(i * CHUNK, (i + 1) * CHUNK);
        let bin = '';
        for (let q = 0; q < part.length; q += 0x8000)
            bin += String.fromCharCode.apply(null, part.subarray(q, q + 0x8000));
        send({ k: 'chunk', i, d: btoa(bin), to });
    }

    // the whole map, from the host
    const snapshot = to => ({ k: 'snap', to, notes: s.map.notes.items.map(keyOf), extra: extraOf(s.map) });

    async function receive(p) {
        if (!s || !p.f || p.f === s.me || (p.to && p.to !== s.me))
            return;
        if (p.k === 'bye') {
            const name = (s.peers.get(p.f) || {}).name || p.nm || 'Someone';
            if (s.role === 'guest' && p.f === s.host.id) {
                leave(true);
                if (app.editor)
                    app.editor.toast(`${name.toUpperCase()} ENDED THE COLLAB - THE MAP STAYS WITH YOU`, 'warn');
                else
                    app.dialogs.message(`${name} ended the collab.`);
            } else {
                dropPeer(p.f);
                toast(`${name.toUpperCase()} LEFT`, 'warn');
            }
            return;
        }
        const peer = peerOf(p.f, p.nm);
        switch (p.k) {
            case 'hi':
                // (someone's connected: the host sends them the song and, once their editor's open, the map)
                if (s.role === 'host' && s.songMeta) {
                    if (s.peers.size > MAX_PEOPLE - 1) {
                        send({ k: 'full', to: p.f });
                        dropPeer(p.f);
                        break;
                    }
                    sendSong(p.f);
                }
                break;
            case 'full':
                leave(true);
                app.dialogs.message(`That collab is full (${MAX_PEOPLE} people).`);
                break;
            case 'song':
                if (s.role !== 'guest' || s.song)
                    break;
                s.song = { ...p, parts: new Array(p.n), got: 0 };
                s.phase = 'receiving';
                s.lastChunk = performance.now();
                // (pieces that came before it)
                for (const [i, d] of s.early || [])
                    if (i < p.n && !s.song.parts[i]) {
                        s.song.parts[i] = d;
                        s.song.got++;
                    }
                s.early = null;
                if (s.song.got === s.song.n)
                    await songArrived();
                break;
            case 'chunk':
                if (s.role !== 'guest' || s.phase === 'mapping' || s.phase === 'opening')
                    break;
                // (a piece of a song whose details went missing: kept, and the details asked for again)
                if (!s.song) {
                    (s.early = s.early || new Map()).set(p.i, p.d);
                    if (performance.now() - (s.askedMeta || 0) > 2000) {
                        s.askedMeta = performance.now();
                        send({ k: 'hi', role: s.role });
                    }
                    break;
                }
                if (s.song.parts[p.i])
                    break;
                s.song.parts[p.i] = p.d;
                s.song.got++;
                s.lastChunk = performance.now();
                if (s.song.got === s.song.n)
                    await songArrived();
                break;
            case 'need':
                if (s.role === 'host')
                    for (const i of p.i || [])
                        sendChunk(i, p.f);
                break;
            case 'ready':
                // (their editor is open: the map as it is now)
                if (s.role === 'host' && s.map) {
                    send(snapshot(p.f));
                    toast(`${peer.name.toUpperCase()} JOINED`);
                }
                break;
            case 'snap':
                if (s.map)
                    applySnapshot(p);
                break;
            case 'd':
                if (s.map)
                    applyDiff(p.a || [], p.r || [], peer);
                break;
            case 'x':
                if (s.map)
                    applyExtra(p.x);
                break;
            case 'p':
                peer.other = { ...(peer.other || {}), ...p, at: performance.now() };
                if (p.sel !== undefined)
                    markSelection(peer, p.sel);
                break;
            case 'sum':
                // (a mismatch twice running, with nothing of this side's on the way: the whole map again)
                if (s.role === 'guest' && s.map && s.phase === 'mapping') {
                    if (p.h !== hashNotes(s.map.notes.items) && performance.now() - s.lastLocal > 1500) {
                        if (++s.misses >= 2) {
                            send({ k: 'resync' });
                            s.misses = 0;
                        }
                    } else
                        s.misses = 0;
                }
                break;
            case 'resync':
                if (s.role === 'host' && s.map)
                    send(snapshot(p.f));
                break;
        }
    }

    // a guest: the song is here, so the same map opens
    async function songArrived() {
        const g = s.song;
        s.phase = 'opening';
        const bytes = new Uint8Array(g.size);
        let o = 0;
        for (const part of g.parts) {
            const bin = atob(part);
            for (let q = 0; q < bin.length; q++)
                bytes[o++] = bin.charCodeAt(q);
        }
        const file = new File([bytes], g.name, { type: g.type });
        await app.storage.putAudio(g.id, file);
        const map = new SSQE.Map();
        map.soundId = g.id;
        await app.openNewMap(map, null);
        if (!s)
            return;
        s.map = app.editor && app.editor.map;
        attachEditor();
        s.phase = 'mapping';
        send({ k: 'ready' });
    }

    // ------------------------------------------------------------ applying the others' changes
    // (never touching this side's selection: what's selected here stays selected, and notes someone else moves
    // while they're selected here stay selected where they've gone)

    function rebuildSynced() {
        s.synced = countKeys(s.map.notes.items);
        s.hash = hashNotes(s.map.notes.items);
    }

    function remark() {
        for (const peer of s.peers.values())
            if (peer.sel)
                markSelection(peer, peer.sel);
    }

    function applySnapshot(p) {
        const map = s.map;
        const sel = new Set(map.notes.selected.map(keyOf));
        map.notes.items = (p.notes || []).map(noteOf);
        map.notes.sort();
        map.notes.selected = map.notes.items.filter(n => sel.has(keyOf(n)));
        applyExtra(p.extra);
        rebuildSynced();
        map.changed();
        remark();
    }

    function applyDiff(adds, removes, peer) {
        const map = s.map;
        const now = performance.now();
        const gone = [];
        if (removes.length) {
            const want = new Map();
            for (const k of removes)
                want.set(k, (want.get(k) || 0) + 1);
            for (const n of map.notes.items) {
                const k = keyOf(n), c = want.get(k);
                if (c) {
                    gone.push(n);
                    want.set(k, c - 1);
                }
            }
        }
        const added = adds.map(k => {
            const n = noteOf(k);
            n.peerAt = now;
            n.peerColor = peer.color;
            return n;
        });
        const selected = new Set(map.notes.selected);
        const lost = gone.filter(n => selected.has(n));
        if (gone.length) {
            const goneSet = new Set(gone);
            map.notes._selected = map.notes._selected.filter(n => !goneSet.has(n));
            map.notes.items = map.notes.items.filter(n => !goneSet.has(n));
        }
        map.notes.items.push(...added);
        // (notes moved by someone else that were selected here: still selected, where they are now; each paired
        // with the new note nearest it in time and place)
        if (lost.length && added.length >= lost.length) {
            const free = added.slice();
            for (const n of lost) {
                let bi = -1, bd = Infinity;
                free.forEach((m, i) => {
                    const d = Math.abs(m.ms - n.ms) / 100 + Math.hypot(m.x - n.x, m.y - n.y);
                    if (d < bd) {
                        bd = d;
                        bi = i;
                    }
                });
                if (bi >= 0)
                    map.notes._selected.push(free.splice(bi, 1)[0]);
            }
        }
        if (added.length)
            map.notes.sort();
        map.notes.updateSelection();
        // (what all agree on now, so these don't go straight back)
        for (const k of removes) {
            const c = s.synced.get(k) || 0;
            if (c > 1)
                s.synced.set(k, c - 1);
            else
                s.synced.delete(k);
        }
        for (const k of adds)
            s.synced.set(k, (s.synced.get(k) || 0) + 1);
        s.hash = hashNotes(map.notes.items);
        map.changed();
        remark();
    }

    function applyExtra(x) {
        if (!x || x === s.extra)
            return;
        const map = s.map;
        // (what's selected here, kept through it)
        const sel = map.notes.selected.slice();
        const point = map.selectedPoint ? [map.selectedPoint.bpm, map.selectedPoint.ms] : null;
        const spSel = new Set(map.specialObjects.selected.map(o => `${o.id}|${o.toString()}`));
        const vfxSel = new Set(map.vfxObjects.selected.map(o => `${o.id}|${o.toString()}`));
        try {
            SSQE.Formats.readIni(map, x);
        } catch { /* what could be read stays */ }
        map.notes.selected = sel.filter(n => map.notes.items.includes(n));
        map.specialObjects.selected = map.specialObjects.items.filter(o => spSel.has(`${o.id}|${o.toString()}`));
        map.vfxObjects.selected = map.vfxObjects.items.filter(o => vfxSel.has(`${o.id}|${o.toString()}`));
        if (point)
            map.selectedPoint = map.timingPoints.find(t => t.bpm === point[0] && t.ms === point[1]) || null;
        s.extra = extraOf(map);
        map.changed();
    }

    function markSelection(peer, keys) {
        peer.sel = keys;
        const want = new Set(Array.isArray(keys) ? keys : []);
        for (const n of s.map ? s.map.notes.items : []) {
            if (want.has(keyOf(n)))
                n.peerSel = peer.color;
            else if (n.peerSel === peer.color)
                n.peerSel = null;
        }
    }

    // ------------------------------------------------------------ sending this side's changes (every 33 ms)

    function tick() {
        if (!s)
            return;
        const ed = app.editor;
        const now = performance.now();
        // (the host went back without choosing a song: off)
        if (s.role === 'host' && s.phase === 'song' && document.body.dataset.screen !== 'create' && now - s.started > 1500) {
            leave();
            return;
        }
        // (back to the menu, or another map opened: done)
        if (s.map && (!ed || ed.map !== s.map)) {
            leave();
            return;
        }
        // (someone who's gone quiet for 20 seconds has gone)
        for (const p of [...s.peers.values()])
            if (now - p.heard > 20000)
                dropPeer(p.id);
        // (a guest waiting for a song that's stopped coming: ask again for what's missing)
        if (s.role === 'guest' && s.song && s.phase === 'receiving' && now - s.lastChunk > 3000) {
            const missing = [];
            for (let i = 0; i < s.song.n && missing.length < 40; i++)
                if (!s.song.parts[i])
                    missing.push(i);
            send({ k: 'need', i: missing });
            s.lastChunk = now;
        }
        if (!s.map || s.phase !== 'mapping')
            return;
        const map = s.map;
        // the notes: what's been added and removed since all last agreed
        const h = hashNotes(map.notes.items);
        if (h !== s.hash) {
            const cur = countKeys(map.notes.items);
            const a = [], r = [];
            for (const [k, c] of cur) {
                const was = s.synced.get(k) || 0;
                for (let q = was; q < c; q++)
                    a.push(k);
            }
            for (const [k, c] of s.synced) {
                const is = cur.get(k) || 0;
                for (let q = is; q < c; q++)
                    r.push(k);
            }
            if (a.length || r.length) {
                send({ k: 'd', a, r });
                s.lastLocal = now;
            }
            s.synced = cur;
            s.hash = h;
        }
        // timing points, bookmarks and extra objects (a few times a second is plenty)
        if (now - (s.lastExtra || 0) > 200) {
            s.lastExtra = now;
            const x = extraOf(map);
            if (x !== s.extra) {
                s.extra = x;
                send({ k: 'x', x });
                s.lastLocal = now;
            }
        }
        // where this side is: the mouse, the song position and playing, the selection when it changes
        const c = ed.canvas, w = c.clientWidth || window.innerWidth, hgt = c.clientHeight || window.innerHeight;
        const p = { k: 'p', x: r3(ed.mouse.x / w), y: r3(ed.mouse.y / hgt), t: Math.round(map.currentTime), pl: ed.music && ed.music.isPlaying ? 1 : 0, b: (ed.mouse.left ? 1 : 0) | (ed.mouse.right ? 2 : 0) };
        const sig = `${p.x},${p.y},${p.t},${p.pl},${p.b}`;
        const sel = map.notes.selected.length <= 2000 ? map.notes.selected.map(keyOf) : [];
        const selSig = `${sel.length}:${sel.slice(0, 3).join()}:${sel.slice(-3).join()}`;
        if (selSig !== s.lastSel) {
            p.sel = sel;
            s.lastSel = selSig;
        }
        if ((sig !== s.lastP || p.sel) && now - s.lastSend >= SEND_EVERY || now - s.lastSend > 2000) {
            send(p);
            s.lastP = sig;
            s.lastSend = now;
        }
        // (the host: a fingerprint every 3 seconds, so a lost change gets put right)
        if (s.role === 'host' && now - s.lastSum > 3000) {
            s.lastSum = now;
            send({ k: 'sum', h: hashNotes(map.notes.items) });
        }
        // the others, for the editor to draw: where they are in the song
        const tempo = (ed.music && ed.music.tempo) || 1;
        ed.peers = [...s.peers.values()].filter(pr => pr.other && pr.other.t !== undefined)
            .map(pr => ({ id: pr.id, name: pr.name, color: pr.color, time: pr.other.pl ? pr.other.t + (now - pr.other.at) * tempo : pr.other.t }));
    }

    // ------------------------------------------------------------ drawing the others, and the bar

    let barButtons = [], inputOn = false;
    const shown = new Map();
    function attachEditor() {
        const ed = app.editor;
        if (!ed)
            return;
        rebuildSynced();
        s.extra = extraOf(s.map);
        ed.afterRender = (ctx, W, H) => drawOver(ed, ctx, W, H);
        if (!inputOn) {
            window.addEventListener('mousedown', onDown, true);
            inputOn = true;
        }
    }
    function detachInput() {
        if (inputOn)
            window.removeEventListener('mousedown', onDown, true);
        inputOn = false;
        barButtons = [];
    }
    function onDown(e) {
        if (!s || e.target !== (app.editor && app.editor.canvas))
            return;
        for (const b of barButtons)
            if (e.clientX >= b.x && e.clientX <= b.x + b.w && e.clientY >= b.y && e.clientY <= b.y + b.h) {
                e.stopImmediatePropagation();
                e.preventDefault();
                b.on();
                return;
            }
    }
    function openInvites() {
        const list = O().onlineUsers().filter(u => !s.peers.has(u.id));
        app.dialogs.collabInvite(list, inviteState, u => invite(u), full());
    }

    function drawCursor(ed, ctx, x, y, k, color, name, buttons) {
        const c = 22 * k, rgb = `rgb(${color.join(',')})`;
        if (buttons) {
            ctx.beginPath();
            ctx.arc(x, y, 14 * k, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(${color.join(',')},0.4)`;
            ctx.fill();
        }
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x, y + c);
        ctx.lineTo(x + c * 0.28, y + c * 0.75);
        ctx.lineTo(x + c * 0.48, y + c * 1.15);
        ctx.lineTo(x + c * 0.62, y + c * 1.08);
        ctx.lineTo(x + c * 0.43, y + c * 0.7);
        ctx.lineTo(x + c * 0.75, y + c * 0.7);
        ctx.closePath();
        ctx.fillStyle = rgb;
        ctx.fill();
        ctx.lineWidth = Math.max(1, 1.5 * k);
        ctx.strokeStyle = '#000';
        ctx.stroke();
        ed.text(name, x + c * 0.8, y + c * 1.1, 20 * k, rgb);
    }

    function drawOver(ed, ctx, W, H) {
        if (!s)
            return;
        const k = H / 1080, now = performance.now();
        // (the part of the song on this screen's track: someone's mouse shows only while they're in it too)
        const total = ed.totalTime || 1;
        const from = ed.trackStartRel * total, to = ed.trackEndRel * total;
        for (const p of ed.peers || []) {
            const pr = s.peers.get(p.id);
            const o = pr && pr.other;
            if (!o || !(o.x >= 0) || now - o.at > 10000 || p.time < from || p.time > to) {
                shown.delete(p.id);
                continue;
            }
            // (eased toward where it was last heard: smooth, and only a frame or two behind)
            const tx = o.x * W, ty = o.y * H, was = shown.get(p.id);
            const at = was ? { x: was.x + (tx - was.x) * 0.5, y: was.y + (ty - was.y) * 0.5 } : { x: tx, y: ty };
            shown.set(p.id, at);
            drawCursor(ed, ctx, at.x, at.y, k, p.color, p.name, o.b);
        }
        // the bar: who with, and INVITE (the host) and LEAVE
        const names = [...s.peers.values()].map(p => p.name);
        const what = names.length ? `MAPPING WITH ${names.join(', ')}` : s.role === 'host' ? 'WAITING FOR THEM TO JOIN' : 'CONNECTING...';
        const bw = 760 * k, bh = 46 * k, bx = (W - bw) / 2, by = 884 * k;
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.fillRect(bx, by, bw, bh);
        ctx.strokeStyle = 'rgba(255,160,0,0.6)';
        ctx.lineWidth = Math.max(1, 2 * k);
        ctx.strokeRect(bx, by, bw, bh);
        ed.text(what.slice(0, 46), bx + 14 * k, by + bh / 2, 20 * k, '#fff', 'left', 'middle');
        barButtons = [];
        const button = (label, w, x, on) => {
            const ly = by + 6 * k, lh = bh - 12 * k;
            ctx.fillStyle = 'rgba(255,255,255,0.12)';
            ctx.fillRect(x, ly, w, lh);
            ed.text(label, x + w / 2, ly + lh / 2, 20 * k, '#fff', 'center', 'middle');
            barButtons.push({ x, y: ly, w, h: lh, on });
        };
        const lw = 110 * k;
        button('LEAVE', lw, bx + bw - lw - 6 * k, () => app.dialogs.confirm(
            s.role === 'host' ? 'End the collab for everyone? The map stays with all of you.' : 'Leave the collab? The map stays with you.',
            [['Leave', 'yes'], ['Stay', 'no']]).then(a => a === 'yes' && leave()));
        if (s.role === 'host')
            button('INVITE', lw, bx + bw - 2 * lw - 12 * k, openInvites);
    }

    // ------------------------------------------------------------ for the screens

    function status() {
        if (!s)
            return '';
        const n = s.host ? s.host.name : '';
        if (s.phase === 'wait')
            return `Mapping with ${n}.\n\nWaiting for ${n} to choose the song...`;
        if ((s.phase === 'receiving' || s.phase === 'opening') && s.song)
            return `Mapping with ${n}.\n\nGetting the song (${s.song.name})... ${Math.floor(100 * s.song.got / s.song.n)}%`;
        return `Mapping with ${n}...`;
    }
    const choosingFor = () => s && s.role === 'host' && s.phase === 'song'
        ? ([...s.peers.values()].map(p => p.name).join(', ') || 'your invite') : '';

    function attach(theApp) {
        app = theApp;
        if (!O() || !O().configured())
            return;
        O().onInbox(onInbox);
        setInterval(() => {
            try {
                tick();
            } catch (e) {
                console.warn('collab', e);
            }
        }, SEND_EVERY);
    }

    return { attach, invite, inviteState, leave, songChosen, status, choosingFor, active: () => !!s, full };
})();
