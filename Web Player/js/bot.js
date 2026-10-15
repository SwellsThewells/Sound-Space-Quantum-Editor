'use strict';

// Web only: a bot that plays maps the way people do, and learns how from the .sspre replays you load.
// From each replay (lined up with its map) it learns:
//  - the movement curve between notes: how far along the cursor is at each moment of the gap (people get to a note
//    early and wait on it for slow notes, and arrive just in time in streams), for short, medium and long gaps
//  - how far from the middle of a note the cursor is when the note arrives (aim spread)
//  - how much the path bows sideways, and the small shake on top of it
//  - how often notes are missed, depending on how fast the cursor has to move to reach them
// The bot is judged like a player: it only gets a hit if its cursor is on the note.
window.SSQEBot = (function () {
    const KEY = 'botProfile';
    const SAMPLES = 11;
    const GAP_EDGES = [200, 450];
    const SPEED_EDGES = [3, 6, 10, 16];
    const MAX_SEEN = 2000;

    const gapBucket = gap => gap < GAP_EDGES[0] ? 0 : gap < GAP_EDGES[1] ? 1 : 2;
    const speedBucket = speed => {
        let i = 0;
        while (i < SPEED_EDGES.length && speed >= SPEED_EDGES[i])
            i++;
        return i;
    };

    // minimum-jerk curves until replays say otherwise; the longer the gap, the earlier the cursor settles
    function defaultCurve(bucket) {
        const settle = [1, 0.85, 0.65][bucket];
        return Array.from({ length: SAMPLES }, (_, i) => {
            const t = Math.min(1, i / (SAMPLES - 1) / settle);
            return t * t * t * (10 - 15 * t + 6 * t * t);
        });
    }

    function emptyProfile() {
        return {
            version: 2, replays: 0, notes: 0, seen: [],
            curves: [0, 1, 2].map(() => ({ sum: new Array(SAMPLES).fill(0), n: 0 })),
            aim: { x: 0, y: 0, xx: 0, yy: 0, n: 0 },
            lateral: { sq: 0, n: 0 },
            jitter: { sq: 0, n: 0 },
            misses: SPEED_EDGES.concat([Infinity]).map(() => ({ hits: 0, misses: 0 })),
        };
    }

    let profile = null;
    let loading = null;
    function load() {
        if (profile)
            return Promise.resolve(profile);
        if (!loading)
            loading = (window.SSQECustom ? SSQECustom.get(KEY) : Promise.resolve(null))
                .then(p => profile = p && p.version === 2 ? p : emptyProfile())
                .catch(() => profile = emptyProfile());
        return loading;
    }

    function save() {
        return window.SSQECustom ? SSQECustom.put(KEY, profile).catch(() => { }) : Promise.resolve();
    }

    // cursor: [{ X, Y, Ms }] in note coordinates (0..2) and song time, notes: [{ X, Y, Ms }]
    // id: something that identifies the replay so it's only learned once. Returns true when it learned something.
    async function learn(cursor, notes, id, opts = {}) {
        await load();
        if (profile.seen.includes(id) || cursor.length < 10 || notes.length < 10)
            return false;
        const hw = opts.hitWindow || 55;
        const half = (opts.hitbox || 1.14) / 2 + 0.13;

        // cursor position at a song time (binary search + lerp)
        let hint = 0;
        const at = ms => {
            if (ms <= cursor[0].Ms)
                return [cursor[0].X, cursor[0].Y];
            if (ms >= cursor[cursor.length - 1].Ms)
                return [cursor[cursor.length - 1].X, cursor[cursor.length - 1].Y];
            if (cursor[hint].Ms > ms)
                hint = 0;
            let lo = hint, hi = cursor.length - 1;
            while (hi - lo > 1) {
                const mid = (lo + hi) >> 1;
                if (cursor[mid].Ms <= ms)
                    lo = mid;
                else
                    hi = mid;
            }
            hint = lo;
            const a = cursor[lo], b = cursor[hi];
            const t = b.Ms === a.Ms ? 1 : (ms - a.Ms) / (b.Ms - a.Ms);
            return [a.X + (b.X - a.X) * t, a.Y + (b.Y - a.Y) * t];
        };
        const hitAt = n => {
            for (let ms = n.Ms - hw; ms <= n.Ms + hw; ms += 4) {
                const p = at(ms);
                if (Math.abs(p[0] - n.X) <= half && Math.abs(p[1] - n.Y) <= half)
                    return true;
            }
            return false;
        };

        const first = cursor[0].Ms, last = cursor[cursor.length - 1].Ms;
        const inRange = notes.filter(n => n.Ms >= first + 200 && n.Ms <= last - 200);
        if (inRange.length < 10)
            return false;

        let learned = 0;
        for (let i = 0; i < inRange.length; i++) {
            const n = inRange[i];
            const hit = hitAt(n);
            const prev = i > 0 ? inRange[i - 1] : null;
            const gap = prev ? n.Ms - prev.Ms : Infinity;
            const dist = prev ? Math.hypot(n.X - prev.X, n.Y - prev.Y) : 0;
            const speed = prev && gap > 0 ? dist / (gap / 1000) : 0;
            const m = profile.misses[speedBucket(speed)];
            hit ? m.hits++ : m.misses++;
            if (!hit)
                continue;
            learned++;

            // aim: the closest the cursor came to the note's middle while it could be hit
            let p = at(n.Ms), best = Infinity;
            for (let ms = n.Ms - hw; ms <= n.Ms + hw; ms += 4) {
                const c = at(ms);
                const d = Math.hypot(c[0] - n.X, c[1] - n.Y);
                if (d < best) {
                    best = d;
                    p = c;
                }
            }
            const a = profile.aim;
            const dx = p[0] - n.X, dy = p[1] - n.Y;
            a.x += dx; a.y += dy; a.xx += dx * dx; a.yy += dy * dy; a.n++;

            // movement curve along the move from the previous note
            if (prev && dist >= 0.5 && gap >= 60 && gap <= 1500) {
                const ux = (n.X - prev.X) / dist, uy = (n.Y - prev.Y) / dist;
                const c = profile.curves[gapBucket(gap)];
                for (let k = 0; k < SAMPLES; k++) {
                    const q = at(prev.Ms + gap * k / (SAMPLES - 1));
                    const along = ((q[0] - prev.X) * ux + (q[1] - prev.Y) * uy) / dist;
                    const side = (-(q[0] - prev.X) * uy + (q[1] - prev.Y) * ux) / dist;
                    c.sum[k] += Math.min(1.5, Math.max(-0.5, along));
                    if (k === (SAMPLES - 1) / 2) {
                        profile.lateral.sq += Math.min(1, side * side);
                        profile.lateral.n++;
                    }
                }
                c.n++;
            }
        }

        // shake: how far each sample is from the average of its neighbours
        for (let i = 1; i + 1 < cursor.length; i += 3) {
            const a = cursor[i - 1], b = cursor[i], c = cursor[i + 1];
            if (c.Ms - a.Ms > 40 || c.Ms === a.Ms)
                continue;
            const t = (b.Ms - a.Ms) / (c.Ms - a.Ms);
            const ex = a.X + (c.X - a.X) * t, ey = a.Y + (c.Y - a.Y) * t;
            const d2 = (b.X - ex) ** 2 + (b.Y - ey) ** 2;
            if (d2 < 0.04) {
                profile.jitter.sq += d2;
                profile.jitter.n++;
            }
        }

        if (!learned)
            return false;
        profile.replays++;
        profile.notes += learned;
        profile.seen.push(id);
        if (profile.seen.length > MAX_SEEN)
            profile.seen.splice(0, profile.seen.length - MAX_SEEN);
        await save();
        return true;
    }

    async function stats() {
        await load();
        return { replays: profile.replays, notes: profile.notes };
    }

    function statsSync() {
        return profile ? { replays: profile.replays, notes: profile.notes } : null;
    }

    async function reset() {
        profile = emptyProfile();
        await save();
    }

    // ------------------------------------------------ playing

    function gauss(random) {
        return Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
    }

    // What the bot will do, decided up front for a map. skill: 1 = as learned, higher = steadier and fewer misses.
    class Driver {
        constructor(notes, skill = 1) {
            const p = profile || emptyProfile();
            const random = Math.random;
            const s = Math.max(0.1, skill);

            this.curves = p.curves.map((c, i) => c.n >= 5
                ? c.sum.map(v => v / c.n)
                : defaultCurve(i));
            // the curve starts on the last note and ends on the next
            for (const c of this.curves) {
                c[0] = 0;
                c[SAMPLES - 1] = 1;
            }

            const a = p.aim;
            const aim = a.n >= 20
                ? { mx: a.x / a.n, my: a.y / a.n, sx: Math.sqrt(Math.max(0, a.xx / a.n - (a.x / a.n) ** 2)), sy: Math.sqrt(Math.max(0, a.yy / a.n - (a.y / a.n) ** 2)) }
                : { mx: 0, my: 0, sx: 0.12, sy: 0.12 };
            const lateral = p.lateral.n >= 20 ? Math.sqrt(p.lateral.sq / p.lateral.n) : 0.08;
            this.jitter = (p.jitter.n >= 50 ? Math.sqrt(p.jitter.sq / p.jitter.n) : 0.004) / s;
            const defaultMiss = [0.002, 0.006, 0.015, 0.035, 0.08];
            const missRate = b => {
                const m = p.misses[b];
                const n = m.hits + m.misses;
                // with few samples, lean on the built in rate
                const rate = (m.misses + defaultMiss[b] * 20) / (n + 20);
                return Math.min(0.9, rate / (s * s));
            };

            this.notes = notes;
            this.targets = notes.map((n, i) => {
                const prev = i > 0 ? notes[i - 1] : null;
                const gap = prev ? n.Ms - prev.Ms : Infinity;
                const speed = prev && gap > 0 ? Math.hypot(n.X - prev.X, n.Y - prev.Y) / (gap / 1000) : 0;
                let x = n.X + (aim.mx + gauss(random) * aim.sx) / s;
                let y = n.Y + (aim.my + gauss(random) * aim.sy) / s;
                // keep ordinary aim error on the note: only decided misses leave it
                x = Math.min(n.X + 0.42, Math.max(n.X - 0.42, x));
                y = Math.min(n.Y + 0.42, Math.max(n.Y - 0.42, y));
                if (random() < missRate(speedBucket(speed))) {
                    const ang = random() * Math.PI * 2;
                    const off = 0.85 + random() * 0.35;
                    x = n.X + Math.cos(ang) * off;
                    y = n.Y + Math.sin(ang) * off;
                }
                return { x, y, ms: n.Ms, side: gauss(random) * lateral / s };
            });
            this.phase = [random() * 100, random() * 100, random() * 100, random() * 100];
            this.index = 0;
        }

        curve(bucket, t) {
            const c = this.curves[bucket];
            const f = Math.min(1, Math.max(0, t)) * (SAMPLES - 1);
            const i = Math.min(SAMPLES - 2, Math.floor(f));
            return c[i] + (c[i + 1] - c[i]) * (f - i);
        }

        // cursor position (note coordinates) at a song time
        position(ms) {
            const T = this.targets;
            if (!T.length)
                return [1, 1];
            while (this.index < T.length && T[this.index].ms <= ms)
                this.index++;
            while (this.index > 0 && T[this.index - 1].ms > ms)
                this.index--;

            let x, y;
            if (this.index === 0) {
                const b = T[0];
                const t = 1 - (b.ms - ms) / 600;
                const k = this.curve(2, t);
                x = 1 + (b.x - 1) * k;
                y = 1 + (b.y - 1) * k;
            } else if (this.index >= T.length) {
                const a = T[T.length - 1];
                x = a.x;
                y = a.y;
            } else {
                const a = T[this.index - 1], b = T[this.index];
                const gap = b.ms - a.ms;
                const t = gap <= 0 ? 1 : (ms - a.ms) / gap;
                const k = this.curve(gapBucket(gap), t);
                const dx = b.x - a.x, dy = b.y - a.y;
                const d = Math.hypot(dx, dy) || 1;
                const bow = b.side * Math.sin(Math.PI * Math.min(1, Math.max(0, t))) * d;
                x = a.x + dx * k - dy / d * bow;
                y = a.y + dy * k + dx / d * bow;
            }

            // smooth shake
            const ph = this.phase, j = this.jitter * 1.6;
            x += j * (Math.sin(ms * 0.031 + ph[0]) + 0.6 * Math.sin(ms * 0.077 + ph[1]));
            y += j * (Math.sin(ms * 0.029 + ph[2]) + 0.6 * Math.sin(ms * 0.083 + ph[3]));
            return [x, y];
        }
    }

    load();
    return { learn, stats, statsSync, reset, load, Driver };
})();
