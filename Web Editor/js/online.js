'use strict';

// Online (web and desktop): accounts and spectating, on a Supabase project (vendor/supabase.js).
//
// Accounts are a username and a password, nothing else: Supabase keeps them (passwords hashed, never stored here),
// and each username stands for its own internal address (name@users.ssqeplus.app), which is never mailed, so the
// project has "Confirm email" turned off.
//
// Spectating: someone logged in with a map open in the editor, and 'Let Others Watch Me Map' on (Settings, or the
// account window), shows on a live list (a Realtime presence channel everyone online joins). Their editor sends what
// it has twice a second on their own channel: where in the song they are and whether it's playing, and the notes
// whenever they change (and to anyone who joins). People watching hold everything back 5 seconds and play it out
// then, so the view runs smoothly instead of jumping with every hiccup in the connection. Watching needs no account;
// the song's audio stays with the mapper.
window.SSQEOnline = (function () {
    // the Supabase project: its URL and public (anon) key, which are meant to be in apps
    const SUPABASE_URL = '';
    const SUPABASE_KEY = '';
    const DOMAIN = 'users.ssqeplus.app';
    const DELAY = 5000;
    const SEND_EVERY = 500;
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

    let mine = null, mineReady = false, lastKey = '', fullAsked = true, lastFull = 0, since = 0, timer = null;
    const shareAllowed = () => !!(user && app && app.settings.allowSpectators !== false);

    // the notes as text (x|y|ms,...) and a quick fingerprint of them, to send only when they change
    const notesKey = notes => {
        let h = notes.length;
        for (const n of notes)
            h = (h * 31 + Math.round(n.x * 100) * 7 + Math.round(n.y * 100) * 13 + Math.round(n.ms)) | 0;
        return `${notes.length}:${h}`;
    };
    const notesText = notes => notes.map(n => `${+n.x.toFixed(3)}|${+n.y.toFixed(3)}|${Math.round(n.ms)}`).join(',');

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
    }

    function tick() {
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
            mine = client.channel(`ssqe-map-${user.id}`, { config: { broadcast: { self: false } } });
            mine.on('broadcast', { event: 'hello' }, () => {
                fullAsked = true;
            });
            mine.subscribe(status => {
                mineReady = status === 'SUBSCRIBED';
            });
        }
        if (!mineReady)
            return;
        const notes = map.notes.items;
        const key = notesKey(notes);
        const music = ed.music;
        const state = {
            time: Math.round(map.currentTime), playing: !!(music && music.isPlaying), rate: (music && music.tempo) || 1,
            duration: Math.round(map.duration || 0), title, name,
        };
        // (the notes when they've changed, when someone has just joined, and every 20 seconds anyway)
        if (key !== lastKey || fullAsked || Date.now() - lastFull > 20000) {
            state.notes = notesText(notes);
            lastKey = key;
            fullAsked = false;
            lastFull = Date.now();
        }
        mine.send({ type: 'broadcast', event: 'state', payload: state });
    }

    // ------------------------------------------------------------ watching (the spectator's side)

    // watch(id): what that mapper did 5 seconds ago, as { name, title, notes, time, playing, duration } (view())
    let watching = null;
    function watch(id) {
        unwatch();
        if (!sb())
            return;
        const ch = client.channel(`ssqe-map-${id}`, { config: { broadcast: { self: false } } });
        watching = { id, ch, queue: [], shown: null, notes: [], at: 0, lastHeard: 0 };
        const w = watching;
        ch.on('broadcast', { event: 'state' }, ({ payload }) => {
            w.queue.push({ due: performance.now() + DELAY, p: payload });
            w.lastHeard = performance.now();
        });
        ch.subscribe(status => {
            if (status === 'SUBSCRIBED')
                ch.send({ type: 'broadcast', event: 'hello', payload: {} });
        });
    }
    function unwatch() {
        if (watching && client)
            client.removeChannel(watching.ch);
        watching = null;
    }
    function view() {
        const w = watching;
        if (!w)
            return null;
        const now = performance.now();
        while (w.queue.length && w.queue[0].due <= now) {
            const { due, p } = w.queue.shift();
            if (p.notes !== undefined)
                w.notes = p.notes ? p.notes.split(',').map(s => {
                    const [x, y, ms] = s.split('|');
                    return { x: +x, y: +y, ms: +ms };
                }) : [];
            w.shown = p;
            w.at = due;
        }
        const s = w.shown;
        if (!s)
            return { waiting: true, quiet: now - (w.lastHeard || now) };
        const time = s.playing ? s.time + (now - w.at) * (s.rate || 1) : s.time;
        return { name: s.name, title: s.title, notes: w.notes, time: Math.min(time, s.duration || Infinity), playing: s.playing, duration: s.duration, quiet: now - w.lastHeard };
    }

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
    }

    return {
        attach, configured, signUp, logIn, logOut, joinLive, liveMappers, watch, unwatch, view,
        username: () => nameOf(user), loggedIn: () => !!user, sharing: () => !!(tracked && mineReady), DELAY,
    };
})();
