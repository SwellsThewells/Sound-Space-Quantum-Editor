'use strict';

// Web only: an auto mapper that keeps learning from every map you import, in the editor or the map player.
// What it learns is stored in the browser (IndexedDB, see customassets.js):
//  - how far and in which direction the next note goes, depending on the time gap and on the previous move
//    (so streams, jumps, back-and-forths and spirals come out the way the imported maps do them)
//  - how dense the maps are (notes per second) and how close notes get
// To map, it finds the hits in the song (spectral flux onsets), keeps as many as the learned density asks for,
// snaps them to the BPM when the map has timing points, and walks the learned movement model to place them.
window.SSQEAutoMapper = (function () {
    const KEY = 'mapperModel';
    const STEP = 0.25; // positions are learned on a quarter-cell lattice
    const GAP_EDGES = [90, 160, 260, 420, 700];
    const MAX_SEEN = 5000;

    const gapBucket = gap => {
        let i = 0;
        while (i < GAP_EDGES.length && gap >= GAP_EDGES[i])
            i++;
        return i;
    };
    const q = v => Math.round(v / STEP);
    const dirClass = (dx, dy) => {
        if (!dx && !dy)
            return 's';
        return String(Math.round(Math.atan2(dy, dx) / (Math.PI / 4) + 8) % 8);
    };
    const magClass = (dx, dy) => {
        const d = Math.hypot(dx, dy) * STEP;
        return d < 0.6 ? 0 : d < 1.3 ? 1 : 2;
    };
    const contextKeys = (gap, prev) => {
        const g = `g${gapBucket(gap)}`;
        return prev ? [`${g}|${dirClass(prev[0], prev[1])}${magClass(prev[0], prev[1])}`, g] : [`${g}|start`, g];
    };

    function emptyModel() {
        return { version: 1, maps: 0, notes: 0, durationMs: 0, seen: [], gaps: {}, trans: {} };
    }

    let model = null;
    let loading = null;
    function load() {
        if (model)
            return Promise.resolve(model);
        if (!loading)
            loading = (window.SSQECustom ? SSQECustom.get(KEY) : Promise.resolve(null))
                .then(m => model = m && m.version === 1 ? m : emptyModel())
                .catch(() => model = emptyModel());
        return loading;
    }

    let saving = Promise.resolve();
    function save() {
        if (!window.SSQECustom)
            return Promise.resolve();
        saving = saving.then(() => SSQECustom.put(KEY, model)).catch(() => { });
        return saving;
    }

    function fingerprint(notes) {
        let h = 2166136261;
        const text = `${notes.length}|` + notes.map(n => `${n.x},${n.y},${n.ms}`).join(';');
        for (let i = 0; i < text.length; i++)
            h = Math.imul(h ^ text.charCodeAt(i), 16777619);
        return (h >>> 0).toString(36);
    }

    // notes: [{ x, y, ms }] in editor coordinates (0..2). Returns true when the map taught it something new.
    async function learn(notes) {
        await load();
        notes = notes.filter(n => Number.isFinite(n.x) && Number.isFinite(n.y) && Number.isFinite(n.ms))
            .sort((a, b) => a.ms - b.ms);
        if (notes.length < 20)
            return false;
        const id = fingerprint(notes);
        if (model.seen.includes(id))
            return false;

        // one note per timestamp: the auto mapper doesn't make stacks
        const list = notes.filter((n, i) => i === 0 || n.ms !== notes[i - 1].ms);
        let prevMove = null;
        for (let i = 1; i < list.length; i++) {
            const a = list[i - 1], b = list[i];
            const gap = b.ms - a.ms;
            const move = [q(b.x) - q(a.x), q(b.y) - q(a.y)];
            const dKey = `${move[0]},${move[1]}`;
            for (const k of contextKeys(gap, prevMove)) {
                const t = model.trans[k] || (model.trans[k] = {});
                t[dKey] = (t[dKey] || 0) + 1;
            }
            const gk = Math.min(300, Math.round(gap / 10));
            model.gaps[gk] = (model.gaps[gk] || 0) + 1;
            prevMove = move;
        }

        model.maps++;
        model.notes += list.length;
        model.durationMs += Math.max(1, list[list.length - 1].ms - list[0].ms);
        model.seen.push(id);
        if (model.seen.length > MAX_SEEN)
            model.seen.splice(0, model.seen.length - MAX_SEEN);
        await save();
        return true;
    }

    async function stats() {
        await load();
        return { maps: model.maps, notes: model.notes };
    }

    function statsSync() {
        return model ? { maps: model.maps, notes: model.notes } : null;
    }

    async function reset() {
        model = emptyModel();
        await save();
    }

    // ------------------------------------------------ generating

    // what was learned about density: notes per second and the shortest usual gap
    function density() {
        let nps = 4, minGap = 120;
        if (model.notes > 50 && model.durationMs > 0)
            nps = model.notes / (model.durationMs / 1000);
        const entries = Object.entries(model.gaps).map(([k, c]) => [+k * 10, c]).sort((a, b) => a[0] - b[0]);
        const total = entries.reduce((n, e) => n + e[1], 0);
        if (total > 50) {
            let acc = 0;
            for (const [gap, c] of entries) {
                acc += c;
                if (acc >= total * 0.05) {
                    minGap = gap;
                    break;
                }
            }
        }
        return { nps: Math.min(Math.max(nps, 0.5), 20), minGap: Math.min(Math.max(minGap, 30), 400) };
    }

    // built in movement for gaps nothing was learned about: grid moves, longer for longer gaps
    function prior(gap) {
        const pref = [0.4, 0.7, 1, 1.25, 1.45, 1.6][gapBucket(gap)];
        const out = {};
        for (let dx = -2; dx <= 2; dx++)
            for (let dy = -2; dy <= 2; dy++) {
                const d = Math.hypot(dx, dy);
                out[`${dx / STEP},${dy / STEP}`] = Math.exp(-((d - pref) ** 2) / 0.5) + (d === 0 ? 0.02 : 0);
            }
        return out;
    }

    // difficulty 1..10 (5 = like the learned maps): above 5 favours bigger jumps, below favours small moves
    function pickMove(gap, prevMove, pos, random, difficulty = 5) {
        const k = (difficulty - 5) * 0.25;
        let dist = null;
        for (const k of contextKeys(gap, prevMove)) {
            const t = model.trans[k];
            if (t && Object.values(t).reduce((a, b) => a + b, 0) >= 8) {
                dist = t;
                break;
            }
        }
        dist = dist || prior(gap);

        const options = [];
        let total = 0;
        for (const [key, weight] of Object.entries(dist)) {
            const [dx, dy] = key.split(',').map(Number);
            const x = pos[0] + dx, y = pos[1] + dy;
            if (x < 0 || y < 0 || x > 8 || y > 8)
                continue;
            const w = weight * Math.pow(1 + Math.hypot(dx, dy) * STEP, k);
            options.push([dx, dy, w]);
            total += w;
        }
        if (!options.length)
            return [4 - pos[0], 4 - pos[1]];
        let r = random() * total;
        for (const o of options) {
            r -= o[2];
            if (r <= 0)
                return [o[0], o[1]];
        }
        return options[options.length - 1].slice(0, 2);
    }

    // in-place radix-2 FFT
    function fft(re, im) {
        const n = re.length;
        for (let i = 1, j = 0; i < n; i++) {
            let bit = n >> 1;
            for (; j & bit; bit >>= 1)
                j ^= bit;
            j ^= bit;
            if (i < j) {
                [re[i], re[j]] = [re[j], re[i]];
                [im[i], im[j]] = [im[j], im[i]];
            }
        }
        for (let len = 2; len <= n; len <<= 1) {
            const ang = -2 * Math.PI / len;
            const wr = Math.cos(ang), wi = Math.sin(ang);
            for (let i = 0; i < n; i += len) {
                let cr = 1, ci = 0;
                for (let k = 0; k < len / 2; k++) {
                    const a = i + k, b = a + len / 2;
                    const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
                    re[b] = re[a] - tr; im[b] = im[a] - ti;
                    re[a] += tr; im[a] += ti;
                    const nr = cr * wr - ci * wi;
                    ci = cr * wi + ci * wr;
                    cr = nr;
                }
            }
        }
    }

    // spectral flux onsets between startMs and endMs: [{ ms, strength }], plus .level(ms) for how much is going on
    async function onsets(buffer, startMs, endMs) {
        const sr = buffer.sampleRate, N = 1024, hop = Math.round(sr / 100);
        const s0 = Math.max(0, Math.floor(startMs / 1000 * sr) - N / 2);
        const s1 = Math.min(buffer.length, Math.ceil(endMs / 1000 * sr));
        const frames = Math.floor((s1 - s0 - N) / hop);
        if (frames < 3)
            return Object.assign([], { level: () => 0 });
        const chans = [];
        for (let c = 0; c < buffer.numberOfChannels; c++)
            chans.push(buffer.getChannelData(c));
        const win = new Float32Array(N).map((_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
        const re = new Float32Array(N), im = new Float32Array(N);
        let prev = new Float32Array(N / 2), cur = new Float32Array(N / 2);
        const flux = new Float32Array(frames), rms = new Float32Array(frames);

        for (let f = 0; f < frames; f++) {
            const o = s0 + f * hop;
            let e = 0;
            for (let i = 0; i < N; i++) {
                let v = 0;
                for (const ch of chans)
                    v += ch[o + i];
                v /= chans.length;
                e += v * v;
                re[i] = v * win[i];
                im[i] = 0;
            }
            rms[f] = Math.sqrt(e / N);
            fft(re, im);
            let sum = 0;
            for (let k = 1; k < N / 2; k++) {
                cur[k] = Math.log1p(100 * Math.hypot(re[k], im[k]));
                const d = cur[k] - prev[k];
                if (d > 0)
                    sum += d;
            }
            flux[f] = f ? sum : 0;
            [prev, cur] = [cur, prev];
            // keep the page responsive on long songs
            if (f % 2000 === 1999)
                await new Promise(r => setTimeout(r));
        }

        const sorted = Array.from(flux).sort((a, b) => a - b);
        const scale = sorted[Math.floor(sorted.length * 0.95)] || 1;
        const loud = Array.from(rms).sort((a, b) => a - b)[Math.floor(frames * 0.9)] || 1;
        const out = [];
        const W = 25;
        let windowSum = 0;
        for (let f = 0; f < Math.min(frames, W); f++)
            windowSum += flux[f];
        for (let f = 0; f < frames; f++) {
            if (f + W < frames)
                windowSum += flux[f + W];
            if (f - W - 1 >= 0)
                windowSum -= flux[f - W - 1];
            const count = Math.min(frames - 1, f + W) - Math.max(0, f - W) + 1;
            const threshold = windowSum / count * 1.15 + scale * 0.05;
            let peak = flux[f] > threshold;
            for (let k = Math.max(0, f - 3); peak && k <= Math.min(frames - 1, f + 3); k++)
                if (flux[k] > flux[f])
                    peak = false;
            if (!peak || rms[f] < loud * 0.03)
                continue;
            const ms = (s0 + f * hop + N / 2) / sr * 1000;
            if (ms >= startMs && ms <= endMs)
                out.push({ ms, strength: (flux[f] - threshold) / scale });
        }
        out.level = ms => {
            const f = Math.round(((ms / 1000 * sr) - s0 - N / 2) / hop);
            let best = 0;
            for (let k = Math.max(0, f - 2); k <= Math.min(frames - 1, f + 2); k++)
                best = Math.max(best, flux[k]);
            return best / scale;
        };
        return out;
    }

    // opts: { buffer (AudioBuffer), startMs, endMs, density (1 = as learned), difficulty (1..10, 5 = as learned),
    //         snap (ms => ms, optional),
    //         before: the notes just before startMs (to carry on their flow), avoid: times already used }
    async function generate(opts) {
        await load();
        const difficulty = Math.min(10, Math.max(1, opts.difficulty || 5));
        // Difficulty sets how dense the map is, on a fixed scale: 1 is about 1.5 notes a second, 5 about 5.5 and
        // 10 about 30 with streams down to ~15ms apart (like Tasukete maps such as RAVE GIRLS or Wall of Death).
        // What was learned decides the movement.
        const nps = 1.5 * Math.pow(20, (difficulty - 1) / 9);
        const minGap = Math.max(12, 450 / nps);
        const found = await onsets(opts.buffer, opts.startMs, opts.endMs);
        const target = Math.round(nps * (opts.density || 1) * (opts.endMs - opts.startMs) / 1000);

        const avoid = (opts.avoid || []).slice();
        const taken = [];
        const free = ms => taken.every(t => Math.abs(t - ms) >= minGap) && avoid.every(t => Math.abs(t - ms) >= minGap);
        for (const o of found.sort((a, b) => b.strength - a.strength)) {
            if (taken.length >= target)
                break;
            let ms = Math.round(o.ms);
            if (opts.snap)
                ms = Math.round(opts.snap(ms));
            if (ms < opts.startMs || ms > opts.endMs || !free(ms))
                continue;
            taken.push(ms);
        }
        // dense maps have more notes than the song has clear hits (streams): fill in on the beat grid where the song is busiest
        if (opts.snap && taken.length < target) {
            const grid = [];
            let last = null;
            for (let ms = opts.startMs; ms <= opts.endMs; ms += 5) {
                const g = Math.round(opts.snap(ms));
                if (g !== last && g >= opts.startMs && g <= opts.endMs) {
                    grid.push(g);
                    last = g;
                }
            }
            const scored = [...new Set(grid)].map(ms => ({ ms, level: found.level(ms) })).filter(g => g.level > 0.15)
                .sort((a, b) => b.level - a.level);
            for (const g of scored) {
                if (taken.length >= target)
                    break;
                if (free(g.ms))
                    taken.push(g.ms);
            }
        }
        taken.sort((a, b) => a - b);

        // still short (no BPM, or a coarse beat divisor): stream between the hits where the song is busy, evenly spaced
        if (taken.length < target && taken.length) {
            const spacing = Math.max(minGap, (opts.endMs - opts.startMs) / target);
            const points = [opts.startMs, ...taken, opts.endMs];
            const gaps = [];
            for (let i = 0; i + 1 < points.length; i++) {
                const a = points[i], b = points[i + 1];
                const level = Math.max(found.level(a + (b - a) / 3), found.level((a + b) / 2), found.level(b - (b - a) / 3));
                if (b - a >= spacing * 1.6 && level > 0.08)
                    gaps.push({ a, b, level, edgeA: i === 0, edgeB: i + 2 === points.length });
            }
            // busiest parts first
            gaps.sort((x, y) => y.level - x.level);
            const extra = [];
            for (const g of gaps) {
                if (taken.length + extra.length >= target)
                    break;
                const count = Math.min(Math.round((g.b - g.a) / spacing) - 1, target - taken.length - extra.length);
                for (let k = 1; k <= count; k++) {
                    let ms = Math.round(g.a + (g.b - g.a) * k / (count + 1));
                    if (opts.snap) {
                        const snapped = Math.round(opts.snap(ms));
                        if (Math.abs(snapped - ms) < spacing / 3)
                            ms = snapped;
                    }
                    if ((g.edgeA && ms - g.a < minGap) || (g.edgeB && g.b - ms < minGap))
                        continue;
                    if (avoid.every(t => Math.abs(t - ms) >= minGap))
                        extra.push(ms);
                }
            }
            taken.push(...extra);
            taken.sort((a, b) => a - b);
            for (let i = taken.length - 1; i > 0; i--)
                if (taken[i] - taken[i - 1] < minGap * 0.8)
                    taken.splice(i, 1);
        }

        // place them
        const random = Math.random;
        const before = (opts.before || []).slice(-2);
        let pos = before.length ? [q(before[before.length - 1].x), q(before[before.length - 1].y)] : [4, 4];
        pos = pos.map(v => Math.min(8, Math.max(0, v)));
        let prevMove = before.length === 2 ? [q(before[1].x) - q(before[0].x), q(before[1].y) - q(before[0].y)] : null;
        let lastMs = before.length ? before[before.length - 1].ms : null;
        const notes = [];
        for (const ms of taken) {
            if (lastMs !== null) {
                const move = pickMove(ms - lastMs, prevMove, pos, random, difficulty);
                pos = [pos[0] + move[0], pos[1] + move[1]];
                prevMove = move;
            }
            notes.push({ x: pos[0] * STEP, y: pos[1] * STEP, ms });
            lastMs = ms;
        }
        return notes;
    }

    // Bulk learning: reads every map file (.sspm, .rhm, .txt, .osu) and learns from it.
    // report(text, isError) shows progress. Resolves to { learned, known, failed }.
    async function learnFiles(files, report = () => { }) {
        const maps = files.filter(f => /\.(sspm|rhm|txt|osu)$/i.test(f.name));
        if (!maps.length) {
            report('PICK .SSPM, .RHM, .TXT OR .OSU MAPS', true);
            return { learned: 0, known: 0, failed: 0 };
        }
        let learned = 0, known = 0, failed = 0;
        for (let i = 0; i < maps.length; i++) {
            const f = maps[i];
            report(`LEARNING FROM MAP ${i + 1} OF ${maps.length}...`);
            await new Promise(r => setTimeout(r, 20));
            try {
                const map = new SSQE.Map();
                const name = f.name.toLowerCase();
                if (name.endsWith('.sspm'))
                    SSQE.Formats.readSspm(map, await f.arrayBuffer());
                else if (name.endsWith('.rhm'))
                    await SSQE.Formats.readRhm(map, await f.arrayBuffer(), f.name);
                else if (name.endsWith('.osu'))
                    SSQE.Formats.readOsu(map, await f.text());
                else
                    SSQE.Formats.readTxt(map, await f.text());
                const notes = map.notes.items.map(n => ({ x: n.x, y: n.y, ms: n.ms }));
                if (notes.length < 20)
                    failed++;
                else if (await learn(notes))
                    learned++;
                else
                    known++;
            } catch (err) {
                console.warn(`Couldn't learn from ${f.name}`, err);
                failed++;
            }
        }
        const parts = [`LEARNED FROM ${learned} OF ${maps.length} MAPS`];
        if (known)
            parts.push(`${known} ALREADY LEARNED`);
        if (failed)
            parts.push(`${failed} UNREADABLE OR TOO SHORT`);
        report(parts.join(' - '), !learned && failed > 0);
        return { learned, known, failed };
    }

    load();
    return { learn, learnFiles, stats, statsSync, reset, generate, onsets };
})();
