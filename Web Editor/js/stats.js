// Stats for the STATS page: counters kept in the browser (shared by the editor and the map player, which can be open
// at once, so every change reads the latest numbers before writing them back).
'use strict';

window.SSQEStats = (function () {
    const KEY = 'ssqe-plus-stats';

    function read() {
        try {
            const s = JSON.parse(localStorage.getItem(KEY) || '{}');
            return s && typeof s === 'object' ? s : {};
        } catch {
            return {};
        }
    }

    function write(s) {
        try {
            localStorage.setItem(KEY, JSON.stringify(s));
        } catch { /* storage full or blocked: stats just don't count */ }
    }

    function change(fn) {
        const s = read();
        fn(s);
        write(s);
    }

    // adds n to a counter
    function add(key, n = 1) {
        if (!n)
            return;
        change(s => s[key] = (Number(s[key]) || 0) + n);
    }

    // keeps the bigger of the two
    function best(key, value) {
        change(s => s[key] = Math.max(Number(s[key]) || 0, value));
    }

    // a new session: the first day it was used, how many days it's been used on
    function session() {
        change(s => {
            const today = new Date().toISOString().slice(0, 10);
            s.sessions = (Number(s.sessions) || 0) + 1;
            s.firstUsed = s.firstUsed || today;
            if (s.lastDay !== today) {
                s.daysUsed = (Number(s.daysUsed) || 0) + 1;
                s.lastDay = today;
            }
        });
    }

    // a finished run in the map player (or a playtest): { hits, misses, maxCombo, mode, seconds }
    function recordPlay(r) {
        change(s => {
            s.timePlaying = (Number(s.timePlaying) || 0) + Math.max(0, Math.round(r.seconds || 0));
            if (r.mode !== 'play') {
                s.watched = (Number(s.watched) || 0) + 1;
                return;
            }
            const notes = (r.hits || 0) + (r.misses || 0);
            s.plays = (Number(s.plays) || 0) + 1;
            s.notesHit = (Number(s.notesHit) || 0) + (r.hits || 0);
            s.notesMissed = (Number(s.notesMissed) || 0) + (r.misses || 0);
            s.bestCombo = Math.max(Number(s.bestCombo) || 0, r.maxCombo || 0);
            // accuracy only counts a real attempt (not quitting after a few notes)
            if (notes >= 20) {
                const acc = r.hits / notes * 100;
                s.bestAccuracy = Math.max(Number(s.bestAccuracy) || 0, acc);
                s.accuracySum = (Number(s.accuracySum) || 0) + acc;
                s.accuracyRuns = (Number(s.accuracyRuns) || 0) + 1;
                if (!r.misses)
                    s.fullCombos = (Number(s.fullCombos) || 0) + 1;
            }
        });
    }

    // counts time while the page is on screen: in the app, and in the editor
    let ticking = false;
    function tick(isEditing) {
        if (ticking)
            return;
        ticking = true;
        setInterval(() => {
            if (document.visibilityState !== 'visible')
                return;
            change(s => {
                s.timeInApp = (Number(s.timeInApp) || 0) + 5;
                if (isEditing())
                    s.timeEditing = (Number(s.timeEditing) || 0) + 5;
            });
        }, 5000);
    }

    // text for the page
    const number = n => Math.round(Number(n) || 0).toLocaleString('en-US');
    function duration(seconds) {
        const s = Math.round(Number(seconds) || 0);
        if (s < 60)
            return `${s}s`;
        const m = Math.floor(s / 60), h = Math.floor(m / 60);
        return h ? `${h}h ${m % 60}m` : `${m}m`;
    }

    return { KEY, read, add, best, session, recordPlay, tick, number, duration };
})();
