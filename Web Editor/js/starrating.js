// Star rating (SR) and ranked points (RP), as Rhythia rates a map.
//
// online(rawMap): asks Rhythia's server, like the CALCULATE SR/RP button of the original editor (2.3.2.3): the map's
// text ('audioId,x|y|ms,...') goes to rhythia.com's getRawStarRating, which answers with the star rating and the
// ranked points a play of it would give. The desktop app asks from its main process (no browser rules in the way);
// a browser asks directly, which only works if the server lets this page read its answer. null when it can't.
//
// rate(notes): the same star rating, worked out here (a port of Rhythia's StarRating: osu! standard aim strain at
// circle size 2 with Relax, the grid scaled to 50 px a cell, a note closer than 1.25 cells to the note kept before it
// left out, as the game plays it). Instant and offline: what the auto mapper aims its maps at.
(function () {
    'use strict';

    const API = 'https://development.rhythia.com/api/getRawStarRating';

    const SCALE = 0.71, RADIUS = 64 * SCALE, NORM = 50, MIN_DT = 25, SECTION = 400, DECAY_W = 0.9;
    const AIM_MULT = 23.55, AIM_DECAY = 0.15, WIDE_M = 1.5, ACUTE_M = 1.95, VC_M = 0.75, DIFF_M = 0.0675, PERF_M = 1.14;
    const MERGE = 1.25;

    // (notes the game counts: one closer than 1.25 cells to the one kept before it is part of it)
    function siteFilter(ns) {
        ns = ns.slice();
        const out = [];
        let i = 0;
        while (i < ns.length - 1) {
            const a = ns[i], b = ns[i + 1];
            if (Math.hypot(b.x - a.x, b.y - a.y) < MERGE) {
                ns.splice(i + 1, 1);
                continue;
            }
            out.push(a);
            i++;
        }
        return out;
    }

    const wideF = a => Math.pow(Math.sin(0.75 * (Math.min(Math.max(a, Math.PI / 6), 5 / 6 * Math.PI) - Math.PI / 6)), 2);

    function aimValue(d, st, jump, ang) {
        if (d <= 1)
            return 0;
        const cv = jump[d] / st[d], pv = jump[d - 1] / st[d - 1];
        let wide = 0, acute = 0, vc = 0;
        if (Math.max(st[d], st[d - 1]) < 1.25 * Math.min(st[d], st[d - 1]) && ang[d] >= 0 && ang[d - 1] >= 0 && ang[d - 2] >= 0) {
            const ab = Math.min(cv, pv);
            wide = wideF(ang[d]);
            acute = 1 - wide;
            if (st[d] > 100)
                acute = 0;
            else {
                acute *= 1 - wideF(ang[d - 1]);
                acute *= Math.min(ab, 125 / st[d]);
                acute *= Math.pow(Math.sin(Math.PI / 2 * Math.min(1, (100 - st[d]) / 25)), 2);
                acute *= Math.pow(Math.sin(Math.PI / 2 * (Math.min(Math.max(jump[d], 50), 100) - 50) / 50), 2);
            }
            wide *= ab * (1 - Math.min(wide, Math.pow(wideF(ang[d - 1]), 3)));
            acute *= 0.5 + 0.5 * (1 - Math.min(acute, Math.pow(1 - wideF(ang[d - 2]), 3)));
        }
        if (Math.max(pv, cv) !== 0) {
            const dr = Math.pow(Math.sin(Math.PI / 2 * Math.abs(pv - cv) / Math.max(pv, cv)), 2);
            const ob = Math.min(125 / Math.min(st[d], st[d - 1]), Math.abs(pv - cv));
            vc = ob * dr * Math.pow(Math.min(st[d], st[d - 1]) / Math.max(st[d], st[d - 1]), 2);
        }
        return cv + Math.max(acute * ACUTE_M, wide * WIDE_M + vc * VC_M);
    }

    // notes: [{ x, y, ms }] -> the star rating (0 for fewer than two notes)
    function rate(notesIn) {
        const notes = notesIn.map((n, i) => ({ x: +n.x, y: +n.y, ms: +n.ms, i })).sort((a, b) => a.ms - b.ms || a.i - b.i);
        // (the game's beatmap template starts with one circle of its own)
        let objs = [{ x: 256, y: 192, t: 24202 }];
        for (const n of siteFilter(notes))
            objs.push({ x: Math.floor(n.x * 50 + 0.5), y: Math.floor(n.y * 50 + 0.5), t: n.ms });
        objs = objs.map((o, i) => ({ ...o, i })).sort((a, b) => a.t - b.t || a.i - b.i);
        if (objs.length < 3)
            return 0;
        const sf = NORM / RADIUS;
        const count = objs.length - 1;
        const delta = [], start = [], st = [], jump = [], ang = [];
        for (let i = 1; i < objs.length; i++) {
            const d = i - 1;
            delta[d] = objs[i].t - objs[i - 1].t;
            start[d] = objs[i].t;
            st[d] = Math.max(delta[d], MIN_DT);
            jump[d] = Math.hypot((objs[i].x - objs[i - 1].x) * sf, (objs[i].y - objs[i - 1].y) * sf);
            ang[d] = -1;
            if (i > 1) {
                const v1 = [objs[i - 2].x - objs[i - 1].x, objs[i - 2].y - objs[i - 1].y];
                const v2 = [objs[i].x - objs[i - 1].x, objs[i].y - objs[i - 1].y];
                ang[d] = Math.abs(Math.atan2(v1[0] * v2[1] - v1[1] * v2[0], v1[0] * v2[0] + v1[1] * v2[1]));
            }
        }
        const peaks = [];
        let peak = 0, end = Math.ceil(start[0] / SECTION) * SECTION, strain = 0;
        for (let d = 0; d < count; d++) {
            while (start[d] > end) {
                peaks.push(peak);
                const ps = d > 0 ? start[d - 1] : 0;
                peak = strain * Math.pow(AIM_DECAY, (end - ps) / 1000);
                end += SECTION;
            }
            strain *= Math.pow(AIM_DECAY, delta[d] / 1000);
            strain += aimValue(d, st, jump, ang) * AIM_MULT;
            peak = Math.max(strain, peak);
        }
        peaks.push(peak);
        const strains = peaks.filter(p => p > 0).sort((a, b) => b - a);
        for (let i = 0; i < Math.min(strains.length, 10); i++)
            strains[i] *= 0.75 + 0.25 * Math.log(1 + 9 * Math.min(Math.max(i / 10, 0), 1)) / Math.log(10);
        strains.sort((a, b) => b - a);
        let diff = 0, w = 1;
        for (const s of strains) {
            diff += s * w;
            w *= DECAY_W;
        }
        diff *= 1.06;
        const aim = Math.sqrt(diff) * DIFF_M * 0.9;
        const baseAim = Math.pow(5 * Math.max(1, aim / 0.0675) - 4, 3) / 100000;
        const basePerf = Math.pow(Math.pow(baseAim, 1.1) + Math.pow(1 / 100000, 1.1), 1 / 1.1);
        return basePerf <= 0.00001 ? 0 : Math.pow(PERF_M, 1 / 3) * 0.027 * (Math.pow(100000 / Math.pow(2, 1 / 1.1) * basePerf, 1 / 3) + 4);
    }

    // rawMap: the map's text -> { sr, rp: { name: points } } from Rhythia's server, or null (offline, refused...)
    async function online(rawMap) {
        const body = JSON.stringify({ rawMap, session: '' });
        try {
            let json;
            if (window.ssqeDesktop && window.ssqeDesktop.starRating) {
                const res = await window.ssqeDesktop.starRating(body);
                if (!res || !res.ok)
                    return null;
                json = JSON.parse(res.text);
            } else {
                // (as plain text, like the original editor sends it: a simple request, no preflight)
                const res = await fetch(API, { method: 'POST', body, headers: { 'Content-Type': 'text/plain;charset=UTF-8' } });
                if (!res.ok)
                    return null;
                json = await res.json();
            }
            const b = json && json.beatmap;
            if (!b || !(b.starRating > 0))
                return null;
            return { sr: +b.starRating, rp: b.rp && typeof b.rp === 'object' ? b.rp : {} };
        } catch {
            return null;
        }
    }

    window.SSQEStarRating = { rate, online };
})();
