'use strict';

// Mapping together (web and desktop, on online.js's Supabase project): COLLABORATE in the menu lists everyone logged
// in; an invite pops up for the other person, and when they accept, the one who invited (the host) picks the song on
// the create screen. The song goes to the guest (in pieces, over the same connection), both editors open the same
// map, and from then on everything is live, with no delay held back: notes added, moved and deleted, timing points,
// bookmarks and extra objects; and each sees where the other is in the song (a line on the track and the timeline),
// their mouse, what they've selected and what they've just placed (in orange).
//
// Notes are kept in step as changes: each side sends what's been added and removed since what both last agreed on, so
// two people editing at once don't overwrite each other. The host also sends a fingerprint of the notes every few
// seconds; if the guest's doesn't match (a lost message), the host sends the whole map again.
window.SSQECollab = (function () {
    const O = () => window.SSQEOnline;
    const CHUNK = 96 * 1024;
    const SEND_EVERY = 33;

    let app = null, s = null;
    const invites = new Map(); // id -> { room, state: 'sent' | 'declined' }

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

    async function invite(u) {
        if (s) {
            app.dialogs.message(`You're already mapping with ${s.peer.name}. Leave first.`);
            return;
        }
        const room = rid();
        invites.set(u.id, { room, state: 'sent' });
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
            if (s) {
                O().sendTo(m.from, { type: 'reply', room: m.room, accept: false, busy: true });
                return;
            }
            app.dialogs.confirm(`${m.name} wants to map with you.\n\nThey'll pick the song, then you both map it at the same time and see each other's edits live.`,
                [['Accept', 'yes'], ['Decline', 'no']]).then(answer => {
                const accept = answer === 'yes' && !s;
                O().sendTo(m.from, { type: 'reply', room: m.room, accept });
                if (accept)
                    start('guest', m.room, { id: m.from, name: m.name });
            });
        } else if (m.type === 'reply') {
            const inv = invites.get(m.from);
            if (!inv || inv.room !== m.room)
                return;
            if (m.accept && !s) {
                invites.delete(m.from);
                start('host', m.room, { id: m.from, name: m.name });
            } else {
                inv.state = 'declined';
                if (m.busy)
                    app.dialogs.message(`${m.name} is already mapping with someone.`);
            }
        }
    }

    // ------------------------------------------------------------ a session

    function start(role, roomId, peer) {
        const ch = O().room(roomId);
        if (!ch)
            return;
        s = {
            role, peer, ch, ready: false, phase: role === 'host' ? 'song' : 'wait',
            // the song coming in (guest)
            song: null, got: 0,
            // what both last agreed on, and what was last sent
            map: null, synced: new Map(), hash: 0, extra: '', lastP: '', lastSel: '', lastSend: 0, lastSum: 0,
            // the other person, as last heard
            other: null, heard: performance.now(), started: performance.now(),
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
            s.ch.send({ type: 'broadcast', event: 'c', payload: p });
    }

    function leave(quiet = false) {
        if (!s)
            return;
        if (!quiet)
            send({ k: 'bye' });
        const ch = s.ch, ed = app.editor, peer = s.peer;
        setTimeout(() => O().closeRoom(ch), 300);
        if (ed) {
            ed.peers = [];
            ed.afterRender = null;
            for (const n of ed.map.notes.items)
                n.peerSel = false;
        }
        detachInput();
        s = null;
        O().setBusy(false);
        if (document.body.dataset.screen === 'collabwait')
            app.showMenu();
        return peer;
    }

    // the host has picked the song (the create screen's CREATE MAP)
    async function songChosen(file, id) {
        if (!s || s.role !== 'host' || s.phase !== 'song')
            return;
        s.phase = 'sending';
        s.map = app.editor && app.editor.map;
        attachEditor();
        const bytes = new Uint8Array(await file.arrayBuffer());
        s.songBytes = bytes;
        s.songMeta = { k: 'song', id, name: file.name, type: file.type || '', size: bytes.length, n: Math.ceil(bytes.length / CHUNK) };
        send(s.songMeta);
        for (let i = 0; i < s.songMeta.n && s; i++) {
            sendChunk(i);
            // (about 20 pieces a second: well within what the connection allows)
            await new Promise(r => setTimeout(r, 50));
        }
        toast(`SENT THE SONG TO ${s ? s.peer.name.toUpperCase() : ''}`);
    }
    function sendChunk(i) {
        if (!s || !s.songBytes)
            return;
        const part = s.songBytes.subarray(i * CHUNK, (i + 1) * CHUNK);
        let bin = '';
        for (let q = 0; q < part.length; q += 0x8000)
            bin += String.fromCharCode.apply(null, part.subarray(q, q + 0x8000));
        send({ k: 'chunk', i, d: btoa(bin) });
    }

    // the whole map, from the host
    function snapshot() {
        const map = s.map;
        return { k: 'snap', notes: map.notes.items.map(keyOf), extra: extraOf(map), dur: map.duration };
    }

    async function receive(p) {
        if (!s)
            return;
        s.heard = performance.now();
        switch (p.k) {
            case 'hi':
                // (the other side is connected: the host sends what's there so far)
                if (s.role === 'host' && s.phase === 'mapping')
                    send(snapshot());
                if (s.role === 'host' && s.songMeta && s.phase !== 'song')
                    send(s.songMeta);
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
                // (a piece of a song whose details went missing: kept, and the details asked for again)
                if (!s.song && s.role === 'guest') {
                    (s.early = s.early || new Map()).set(p.i, p.d);
                    if (performance.now() - (s.askedMeta || 0) > 2000) {
                        s.askedMeta = performance.now();
                        send({ k: 'hi', role: s.role });
                    }
                    break;
                }
                if (!s.song || s.song.parts[p.i])
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
                        sendChunk(i);
                break;
            case 'ready':
                // (the guest's editor is open: the map as it is now)
                if (s.role === 'host') {
                    s.phase = 'mapping';
                    send(snapshot());
                    toast(`${s.peer.name.toUpperCase()} JOINED`);
                }
                break;
            case 'snap':
                if (s.map)
                    applySnapshot(p);
                break;
            case 'd':
                if (s.map)
                    applyDiff(p.a || [], p.r || []);
                break;
            case 'x':
                if (s.map)
                    applyExtra(p.x);
                break;
            case 'p':
                s.other = { ...(s.other || {}), ...p, at: performance.now() };
                if (p.sel !== undefined)
                    markSelection(p.sel);
                break;
            case 'sum':
                if (s.role === 'guest' && s.map && s.phase === 'mapping' && p.h !== hashNotes(s.map.notes.items))
                    send({ k: 'resync' });
                break;
            case 'resync':
                if (s.role === 'host' && s.map)
                    send(snapshot());
                break;
            case 'bye': {
                const name = s.peer.name;
                leave(true);
                if (app.editor)
                    app.editor.toast(`${name.toUpperCase()} LEFT - THE MAP STAYS WITH YOU`, 'warn');
                else
                    app.dialogs.message(`${name} left.`);
                break;
            }
        }
    }

    // the guest: the song is here, so the same map opens
    async function songArrived() {
        const g = s.song;
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

    // ------------------------------------------------------------ applying the other side's changes

    function rebuildSynced() {
        s.synced = countKeys(s.map.notes.items);
        s.hash = hashNotes(s.map.notes.items);
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
    }

    function applyDiff(adds, removes) {
        const map = s.map;
        if (removes.length) {
            const want = new Map();
            for (const k of removes)
                want.set(k, (want.get(k) || 0) + 1);
            const gone = [];
            for (const n of map.notes.items) {
                const k = keyOf(n), c = want.get(k);
                if (c) {
                    gone.push(n);
                    want.set(k, c - 1);
                }
            }
            map.notes.removeAll(gone);
            if (gone.length && map.notes.selected.some(n => gone.includes(n)))
                map.notes.selected = map.notes.selected.filter(n => !gone.includes(n));
        }
        const now = performance.now();
        for (const k of adds) {
            const n = noteOf(k);
            n.peerAt = now;
            map.notes.items.push(n);
        }
        if (adds.length)
            map.notes.sort();
        // (what both agree on now, so these don't go straight back)
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
        if (s.otherSel)
            markSelection(s.otherSel);
    }

    function applyExtra(x) {
        if (!x || x === s.extra)
            return;
        const map = s.map;
        const sel = map.notes.selected.slice();
        try {
            SSQE.Formats.readIni(map, x);
        } catch { /* what could be read stays */ }
        map.notes.selected = sel.filter(n => map.notes.items.includes(n));
        s.extra = extraOf(map);
        map.changed();
    }

    function markSelection(keys) {
        s.otherSel = keys;
        const want = new Set(Array.isArray(keys) ? keys : []);
        for (const n of s.map ? s.map.notes.items : [])
            n.peerSel = want.has(keyOf(n));
    }

    // ------------------------------------------------------------ sending this side's changes (every 33 ms)

    function tick() {
        if (!s)
            return;
        const ed = app.editor;
        // (the host went back without choosing a song: off)
        if (s.role === 'host' && s.phase === 'song' && document.body.dataset.screen !== 'create' && performance.now() - s.started > 1500) {
            leave();
            return;
        }
        // (back to the menu, or another map opened: done)
        if (s.map && (!ed || ed.map !== s.map)) {
            leave();
            return;
        }
        // (the guest waiting for a song that's stopped coming: ask again for what's missing)
        if (s.role === 'guest' && s.song && s.song.got < s.song.n && performance.now() - s.lastChunk > 3000) {
            const missing = [];
            for (let i = 0; i < s.song.n && missing.length < 40; i++)
                if (!s.song.parts[i])
                    missing.push(i);
            send({ k: 'need', i: missing });
            s.lastChunk = performance.now();
        }
        if (!s.map || s.phase !== 'mapping' && s.phase !== 'sending')
            return;
        const map = s.map, now = performance.now();
        // the notes: what's been added and removed since both last agreed
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
            if (a.length || r.length)
                send({ k: 'd', a, r });
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
        if (s.role === 'host' && s.phase === 'mapping' && now - s.lastSum > 3000) {
            s.lastSum = now;
            send({ k: 'sum', h: hashNotes(map.notes.items) });
        }
        // the other person, for the editor to draw
        const o = s.other;
        ed.peers = o && o.t !== undefined ? [{ name: s.peer.name, time: o.pl ? o.t + (now - o.at) * ((ed.music && ed.music.tempo) || 1) : o.t }] : [];
    }

    // ------------------------------------------------------------ drawing the other person, and LEAVE

    let leaveRect = null, inputOn = false, shown = null;
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
        leaveRect = null;
    }
    function onDown(e) {
        const r = leaveRect;
        if (!r || !s || e.target !== (app.editor && app.editor.canvas))
            return;
        if (e.clientX >= r.x && e.clientX <= r.x + r.w && e.clientY >= r.y && e.clientY <= r.y + r.h) {
            e.stopImmediatePropagation();
            e.preventDefault();
            app.dialogs.confirm(`Stop mapping with ${s.peer.name}? The map stays with you.`, [['Leave', 'yes'], ['Stay', 'no']])
                .then(a => a === 'yes' && leave());
        }
    }

    function drawOver(ed, ctx, W, H) {
        if (!s)
            return;
        const k = H / 1080, o = s.other, now = performance.now();
        // their mouse (eased toward where it was last heard: smooth, and only a frame or two behind)
        if (o && o.x >= 0 && now - o.at < 10000) {
            const tx = o.x * W, ty = o.y * H;
            shown = shown ? { x: shown.x + (tx - shown.x) * 0.5, y: shown.y + (ty - shown.y) * 0.5 } : { x: tx, y: ty };
            const x = shown.x, y = shown.y, c = 22 * k;
            if (o.b) {
                ctx.beginPath();
                ctx.arc(x, y, 14 * k, 0, Math.PI * 2);
                ctx.fillStyle = 'rgba(255,160,0,0.4)';
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
            ctx.fillStyle = 'rgb(255,160,0)';
            ctx.fill();
            ctx.lineWidth = Math.max(1, 1.5 * k);
            ctx.strokeStyle = '#000';
            ctx.stroke();
            ed.text(s.peer.name, x + c * 0.8, y + c * 1.1, 20 * k, 'rgb(255,160,0)');
        }
        // the bar: who with, how it's going, and the way out
        const bw = 640 * k, bh = 46 * k, bx = (W - bw) / 2, by = 884 * k;
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.fillRect(bx, by, bw, bh);
        ctx.strokeStyle = 'rgba(255,160,0,0.6)';
        ctx.lineWidth = Math.max(1, 2 * k);
        ctx.strokeRect(bx, by, bw, bh);
        const quiet = now - s.heard > 8000;
        const what = s.phase === 'sending' && s.role === 'host' ? ' - sending them the song' : quiet ? ' - not hearing from them' : '';
        ed.text(`MAPPING WITH ${s.peer.name}${what}`.slice(0, 48), bx + 14 * k, by + bh / 2, 20 * k, quiet ? '#f88' : '#fff', 'left', 'middle');
        const lw = 120 * k, lx = bx + bw - lw - 6 * k, ly = by + 6 * k, lh = bh - 12 * k;
        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        ctx.fillRect(lx, ly, lw, lh);
        ed.text('LEAVE', lx + lw / 2, ly + lh / 2, 20 * k, '#fff', 'center', 'middle');
        leaveRect = { x: lx, y: ly, w: lw, h: lh };
    }

    // ------------------------------------------------------------ for the screens

    function status() {
        if (!s)
            return '';
        const n = s.peer.name;
        if (s.phase === 'wait')
            return `Mapping with ${n}.\n\nWaiting for ${n} to choose the song...`;
        if (s.phase === 'receiving' && s.song)
            return `Mapping with ${n}.\n\nGetting the song (${s.song.name})... ${Math.floor(100 * s.song.got / s.song.n)}%`;
        return `Mapping with ${n}...`;
    }
    const choosingFor = () => s && s.role === 'host' && s.phase === 'song' ? s.peer.name : '';

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

    return { attach, invite, inviteState, leave, songChosen, status, choosingFor, active: () => !!s };
})();
