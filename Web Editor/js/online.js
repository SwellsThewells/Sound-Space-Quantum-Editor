'use strict';

// Online (web and desktop): accounts and spectating, on a Supabase project (vendor/supabase.js).
//
// Accounts are a username and a password, nothing else: Supabase keeps them (passwords hashed, never stored here),
// and each username stands for its own internal address (name@users.ssqeplus.app), which is never mailed, so the
// project has "Confirm email" turned off.
//
// Spectating: someone logged in with a map open in the editor, and 'Let Others Watch Me Map' on (Settings, or the
// account window), shows on a live list (a Realtime presence channel everyone online joins). While someone watches,
// their editor sends what it shows on their own channel (see sharing below), and the watcher's screen becomes a copy
// of their editor, mouse and all (spectator.js), held back 5 seconds and played out then, so it runs smoothly instead
// of jumping with every hiccup in the connection. Watching needs no account; the song's audio stays with the mapper.
window.SSQEOnline = (function () {
    // the Supabase project: its URL and public (anon) key, which are meant to be in apps
    const SUPABASE_URL = 'https://areubmqbmfxveqzzuadn.supabase.co';
    const SUPABASE_KEY = 'sb_publishable_z9_WtnWtQPNjt5blIHeVSg_HI4nekTV';
    const DOMAIN = 'users.ssqeplus.app';
    const DELAY = 5000;
    const SEND_EVERY = 500;
    const SAMPLE_EVERY = 50;
    const NAME = /^[A-Za-z0-9_]{3,20}$/;

    let client = null, user = null, app = null;

    const configured = () => !!(SUPABASE_URL && SUPABASE_KEY && window.supabase && window.supabase.createClient);
    function sb() {
        if (!client && configured()) {
            client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
                auth: { persistSession: true, autoRefreshToken: true, storageKey: 'ssqe-plus-auth' },
            });
            client.auth.onAuthStateChange((_, session) => {
                user = session ? session.user : null;
            });
            client.auth.getSession().then(({ data }) => {
                user = data && data.session ? data.session.user : null;
            });
        }
        return client;
    }
    const nameOf = u => !u ? '' : (u.user_metadata && u.user_metadata.username) || (u.email || '').split('@')[0];

    // ------------------------------------------------------------ accounts

    const friendly = error => {
        const m = (error && error.message) || String(error);
        if (/already registered|already exists/i.test(m))
            return new Error('That username is taken.');
        if (/invalid login credentials/i.test(m))
            return new Error('Wrong username or password.');
        if (/password/i.test(m) && /least|short|characters/i.test(m))
            return new Error('The password needs at least 6 characters.');
        if (/failed to fetch|network/i.test(m))
            return new Error('Couldn\'t reach the server. Check your connection.');
        return new Error(m);
    };
    const check = (name, password) => {
        if (!configured())
            throw new Error('Online features aren\'t set up in this version yet.');
        if (!NAME.test(name || ''))
            throw new Error('Usernames are 3-20 letters, numbers or _.');
        if (!password || password.length < 6)
            throw new Error('The password needs at least 6 characters.');
    };

    async function signUp(name, password) {
        check(name, password);
        const { data, error } = await sb().auth.signUp({ email: `${name.toLowerCase()}@${DOMAIN}`, password, options: { data: { username: name } } });
        if (error)
            throw friendly(error);
        if (!data.session)
            throw new Error('The account was made, but the server is waiting for an email confirmation. Its owner needs to turn off "Confirm email" in Supabase.');
        user = data.session.user;
        return nameOf(user);
    }

    async function logIn(name, password) {
        check(name, password);
        const { data, error } = await sb().auth.signInWithPassword({ email: `${name.toLowerCase()}@${DOMAIN}`, password });
        if (error)
            throw friendly(error);
        user = data.user;
        return nameOf(user);
    }

    async function logOut() {
        stopSharing();
        if (sb())
            await client.auth.signOut();
        user = null;
    }

    // ------------------------------------------------------------ the live list (presence)

    let live = null, liveReady = false, tracked = null;
    const mappers = new Map(); // id -> { id, name, map, since }
    function joinLive() {
        if (live || !sb())
            return live;
        live = client.channel('ssqe-live', { config: { presence: { key: Math.random().toString(36).slice(2) } } });
        live.on('presence', { event: 'sync' }, () => {
            mappers.clear();
            for (const metas of Object.values(live.presenceState()))
                for (const m of metas)
                    if (m && m.id && m.name)
                        mappers.set(m.id, { id: m.id, name: m.name, map: m.map || '', since: m.since || 0 });
        });
        live.subscribe(status => {
            liveReady = status === 'SUBSCRIBED';
        });
        return live;
    }
    const liveMappers = () => [...mappers.values()].filter(m => !user || m.id !== user.id).sort((a, b) => a.name.localeCompare(b.name));

    // ------------------------------------------------------------ sharing (the mapper's side)

    // While someone is watching (a watcher says hello when it starts and every 10 seconds), the editor sends what
    // it shows twice a second on its own channel: the mouse, where in the song it is and whether it's playing, 20
    // times a second (the spectator plays them back smoothly); the zoom, divisor, panels and selection; the map
    // whenever it changes, and the settings that change how the editor looks. Nobody watching: nothing is sent.
    let mine = null, mineReady = false, since = 0, timer = null, sampler = null;
    let watchedUntil = 0, fullAsked = true, lastFull = 0, lastMapKey = '', lastSelKey = '', lastSetKey = '';
    let samples = [];
    const shareAllowed = () => !!(user && app && app.settings.allowSpectators !== false);
    const r3 = v => Math.round(v * 1000) / 1000;
    const hash = text => {
        let h = 0;
        for (let i = 0; i < text.length; i++)
            h = (h * 31 + text.charCodeAt(i)) | 0;
        return h;
    };

    // the map, sorted by time (the map itself isn't touched), as text, with the order for the selection
    function mapText(map) {
        const sorted = map.notes.items.map((n, i) => ({ n, i })).sort((a, b) => a.n.ms - b.n.ms || a.i - b.i).map(o => o.n);
        const notes = sorted.map(n => `${+n.x.toFixed(3)}|${+n.y.toFixed(3)}|${Math.round(n.ms)}`).join(',');
        const noteData = [];
        sorted.forEach((n, i) => n.enableEasing && noteData.push([i, n.style, n.direction]));
        const extra = JSON.stringify({
            timings: map.timingPoints.map(t => [t.bpm, t.ms]),
            bookmarks: map.bookmarks.map(b => [b.text, b.ms, b.endMs]),
            vfxObjects: map.vfxObjects.items.map(o => `${o.id}|${o.toString()}`),
            specialObjects: map.specialObjects.items.map(o => `${o.id}|${o.toString()}`),
            noteData, exportOffset: map.props.exportOffset,
        });
        return { sorted, notes, extra };
    }
    // which of a list are selected, as ranges of their places in it ('3-7,12')
    function ranges(list, selected) {
        if (!selected.length)
            return '';
        const at = new Map(list.map((o, i) => [o, i]));
        const idx = selected.map(o => at.get(o)).filter(i => i !== undefined).sort((a, b) => a - b);
        const out = [];
        for (let i = 0; i < idx.length; i++) {
            let j = i;
            while (j + 1 < idx.length && idx[j + 1] === idx[j] + 1)
                j++;
            out.push(j > i ? `${idx[i]}-${idx[j]}` : `${idx[i]}`);
            i = j;
        }
        return out.join(',');
    }
    // the settings that change what the editor shows (not keybinds or anything private)
    const SKIP = new Set(['keybinds', 'gridKeys', 'patterns', 'masterVolume', 'sfxVolume', 'lastRightNav', 'lastLeftNav']);
    const shownSettings = s => Object.fromEntries(Object.entries(s).filter(([k]) => !SKIP.has(k) && !/^autoMap|^allowSpectators/.test(k)));

    function stopSharing() {
        if (tracked && live) {
            live.untrack();
            tracked = null;
        }
        if (mine) {
            client.removeChannel(mine);
            mine = null;
            mineReady = false;
        }
        samples = [];
    }

    // what the editor's on: 'editor', 'playtest' (the map player on top) or 'away' (another screen)
    function screenOf(ed) {
        if (!ed.running)
            return 'playtest';
        return document.body.dataset.screen === 'editor' ? 'editor' : 'away';
    }

    function sample() {
        const ed = app && app.editor;
        if (!ed || !mineReady || Date.now() > watchedUntil)
            return;
        const c = ed.canvas, w = c.clientWidth || window.innerWidth, h = c.clientHeight || window.innerHeight;
        samples.push([Date.now(), r3(ed.mouse.x / w), r3(ed.mouse.y / h), (ed.mouse.left ? 1 : 0) | (ed.mouse.right ? 2 : 0),
            Math.round(ed.map.currentTime * 10) / 10, ed.music && ed.music.isPlaying ? 1 : 0]);
        if (samples.length > 40)
            samples.shift();
    }

    function tick() {
        onlineTick();
        const ed = app && app.editor;
        if (!shareAllowed() || !ed || !configured()) {
            stopSharing();
            return;
        }
        const map = ed.map, name = nameOf(user);
        const title = map.fileId || map.soundId || 'Untitled';
        joinLive();
        if (liveReady && (!tracked || tracked.map !== title)) {
            if (!tracked)
                since = Date.now();
            tracked = { id: user.id, name, map: title, since };
            live.track(tracked);
        }
        if (!mine) {
            mine = client.channel(`ssqe-pov-${user.id}`, { config: { broadcast: { self: false } } });
            mine.on('broadcast', { event: 'hello' }, () => {
                fullAsked = true;
                watchedUntil = Date.now() + 30000;
            });
            mine.subscribe(status => {
                mineReady = status === 'SUBSCRIBED';
            });
        }
        if (!mineReady || Date.now() > watchedUntil) {
            samples = [];
            return;
        }
        const now = Date.now();
        const out = {
            st: now, name, title, dur: Math.round(map.duration || 0),
            s: samples.map(x => [x[0] - now, ...x.slice(1)]),
            v: {
                zoom: map.zoom, div: map.beatDivisor, tempo: map.tempoSlider, rm: map.renderMode, om: map.objectMode,
                sel: ed.selecting ? Math.round(ed.selectMsStart) : null, scr: screenOf(ed), dlg: !!(app.dialogOpen && app.dialogOpen()),
                rate: (ed.music && ed.music.tempo) || 1,
            },
        };
        samples = [];
        const full = fullAsked || now - lastFull > 20000;
        // (the map: when it changes, notes moved or added, or anything else; the selection with it)
        const t = mapText(map);
        const mapKey = `${t.notes.length}:${hash(t.notes)}:${hash(t.extra)}`;
        if (full || mapKey !== lastMapKey) {
            out.map = { notes: t.notes, extra: t.extra };
            lastMapKey = mapKey;
        }
        const sel = `${ranges(t.sorted, map.notes.selected)}/${ranges(map.specialObjects.items, map.specialObjects.selected)}/${ranges(map.vfxObjects.items, map.vfxObjects.selected)}`;
        if (full || out.map || sel !== lastSelKey) {
            out.sel = sel;
            lastSelKey = sel;
        }
        const shown = shownSettings(app.settings);
        shown.leftNav = app.settings.lastLeftNav;
        shown.rightNav = app.settings.lastRightNav;
        const setKey = JSON.stringify(shown);
        if (full || setKey !== lastSetKey) {
            out.set = shown;
            lastSetKey = setKey;
        }
        if (full) {
            fullAsked = false;
            lastFull = now;
        }
        mine.send({ type: 'broadcast', event: 'pov', payload: out });
    }

    // ------------------------------------------------------------ watching (the spectator's side)

    // watch(id, onPayload): everything that mapper's editor sends, as it comes in (spectator.js plays it back 5
    // seconds later), with the time it came in
    let watching = null;
    function watch(id, onPayload) {
        unwatch();
        if (!sb())
            return;
        const ch = client.channel(`ssqe-pov-${id}`, { config: { broadcast: { self: false } } });
        const hello = () => ch.send({ type: 'broadcast', event: 'hello', payload: {} });
        watching = { id, ch, timer: null };
        ch.on('broadcast', { event: 'pov' }, ({ payload }) => onPayload(payload, Date.now()));
        ch.subscribe(status => {
            if (status === 'SUBSCRIBED' && watching && watching.ch === ch) {
                hello();
                clearInterval(watching.timer);
                watching.timer = setInterval(hello, 10000);
            }
        });
    }
    function unwatch() {
        if (watching) {
            clearInterval(watching.timer);
            if (client)
                client.removeChannel(watching.ch);
        }
        watching = null;
    }

    // ------------------------------------------------------------ everyone online, and invites (collab.js)

    // Everyone logged in is on a second presence list (whether or not they're mapping), and listens on their own
    // inbox channel for invites and answers to them.
    let everyone = null, everyoneReady = false, meOnline = null, inbox = null, inboxFor = '', busy = false;
    const people = new Map(); // id -> { id, name, busy }
    const inboxHandlers = [];
    function onlineTick() {
        if (!sb())
            return;
        if (!user) {
            if (meOnline && everyone) {
                everyone.untrack();
                meOnline = null;
            }
            if (inbox) {
                client.removeChannel(inbox);
                inbox = null;
                inboxFor = '';
            }
            return;
        }
        if (!everyone) {
            everyone = client.channel('ssqe-online', { config: { presence: { key: Math.random().toString(36).slice(2) } } });
            everyone.on('presence', { event: 'sync' }, () => {
                people.clear();
                for (const metas of Object.values(everyone.presenceState()))
                    for (const m of metas)
                        if (m && m.id && m.name)
                            people.set(m.id, { id: m.id, name: m.name, busy: !!m.busy });
            });
            everyone.subscribe(status => {
                everyoneReady = status === 'SUBSCRIBED';
            });
        }
        if (everyoneReady && (!meOnline || meOnline.id !== user.id || meOnline.busy !== busy)) {
            meOnline = { id: user.id, name: nameOf(user), busy };
            everyone.track(meOnline);
        }
        if (inboxFor !== user.id) {
            if (inbox)
                client.removeChannel(inbox);
            inboxFor = user.id;
            inbox = client.channel(`ssqe-inbox-${user.id}`, { config: { broadcast: { self: false } } });
            inbox.on('broadcast', { event: 'msg' }, ({ payload }) => {
                for (const fn of inboxHandlers)
                    try {
                        fn(payload);
                    } catch (e) {
                        console.warn(e);
                    }
            });
            inbox.subscribe(() => { });
        }
    }
    const onlineUsers = () => [...people.values()].filter(u => !user || u.id !== user.id).sort((a, b) => a.name.localeCompare(b.name));
    const onInbox = fn => inboxHandlers.push(fn);
    // a message to someone's inbox (with who it's from)
    function sendTo(id, payload) {
        return new Promise(resolve => {
            if (!sb() || !user)
                return resolve(false);
            const ch = client.channel(`ssqe-inbox-${id}`, { config: { broadcast: { self: false } } });
            let done = false;
            const finish = ok => {
                if (done)
                    return;
                done = true;
                setTimeout(() => client.removeChannel(ch), 2000);
                resolve(ok);
            };
            ch.subscribe(status => {
                if (status === 'SUBSCRIBED') {
                    ch.send({ type: 'broadcast', event: 'msg', payload: { ...payload, from: user.id, name: nameOf(user) } });
                    finish(true);
                } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT')
                    finish(false);
            });
            setTimeout(() => finish(false), 10000);
        });
    }
    // a channel for two people mapping together
    const room = id => sb() ? client.channel(`ssqe-collab-${id}`, { config: { broadcast: { self: false } } }) : null;
    const closeRoom = ch => ch && client && client.removeChannel(ch);

    // ------------------------------------------------------------ start

    function attach(theApp) {
        app = theApp;
        if (!configured())
            return;
        sb();
        clearInterval(timer);
        timer = setInterval(() => {
            try {
                tick();
            } catch { /* never in the way of mapping */ }
        }, SEND_EVERY);
        clearInterval(sampler);
        sampler = setInterval(() => {
            try {
                sample();
            } catch { /* never in the way of mapping */ }
        }, SAMPLE_EVERY);
    }

    return {
        attach, configured, signUp, logIn, logOut, joinLive, liveMappers, watch, unwatch,
        username: () => nameOf(user), loggedIn: () => !!user, sharing: () => !!(tracked && mineReady),
        watched: () => Date.now() < watchedUntil, DELAY,
        onlineUsers, onInbox, sendTo, room, closeRoom, setBusy: b => busy = !!b, userId: () => user && user.id,
    };
})();
