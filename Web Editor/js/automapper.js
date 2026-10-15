'use strict';

// Web only: an auto mapper that learns from the maps you import (in the editor or the map player).
//
// It keeps the maps themselves (note positions and timing), not averages: to place notes it copies whole runs of
// notes from them (8-16 at a time), picked because their rhythm matches the new notes' rhythm and because they carry
// on from where the last note is, turned or mirrored to fit. So the patterns that come out are patterns someone
// actually mapped - with one map learned, the result follows that map's design.
//
// Timing comes from the song: drum-like hits (the bass and the high end, which leaves most of the vocals out), lined
// up on the beat (the map's BPM, or one it works out), with more notes and bigger moves where the song is intense
// (drops) and fewer where it's calm.
//
// What it learns is stored in the browser (IndexedDB, see customassets.js).
window.SSQEAutoMapper = (function () {
    const KEY = 'mapperModel';
    const VERSION = 2;
    const MAX_NOTES = 250000;
    const GRID = [0, 2];
    const QUANTUM = [-0.5, 2.5];

    // the 8 ways to turn or mirror the 3x3 grid around its middle (1, 1); INV[k] undoes SYM[k]
    const SYM = [
        (x, y) => [x, y], (x, y) => [2 - x, y], (x, y) => [x, 2 - y], (x, y) => [2 - x, 2 - y],
        (x, y) => [y, x], (x, y) => [2 - y, x], (x, y) => [y, 2 - x], (x, y) => [2 - y, 2 - x],
    ];
    const INV = [0, 1, 2, 3, 4, 6, 5, 7];

    const isWhole = v => Math.abs(v - Math.round(v)) < 1e-4;
    const posKey = (x, y) => `${Math.round(x * 20)},${Math.round(y * 20)}`;

    // ------------------------------------------------ storage

    function emptyModel() {
        return { version: VERSION, maps: [], seen: [] };
    }

    let model = null;
    let loading = null;
    function load() {
        if (model)
            return Promise.resolve(model);
        if (!loading)
            loading = (window.SSQECustom ? SSQECustom.get(KEY) : Promise.resolve(null))
                .then(m => model = m && m.version === VERSION ? m : emptyModel())
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

    // sorted, one note per timestamp, as a library entry { x, y, t, quantum }
    function toEntry(notes, name = '') {
        const list = notes.filter(n => Number.isFinite(n.x) && Number.isFinite(n.y) && Number.isFinite(n.ms))
            .sort((a, b) => a.ms - b.ms)
            .filter((n, i, a) => i === 0 || n.ms !== a[i - 1].ms);
        const r = v => Math.round(v * 1000) / 1000;
        return {
            name,
            x: Float32Array.from(list, n => r(n.x)),
            y: Float32Array.from(list, n => r(n.y)),
            t: Float64Array.from(list, n => Math.round(n.ms)),
            quantum: list.some(n => !isWhole(n.x) || !isWhole(n.y) || n.x < 0 || n.x > 2 || n.y < 0 || n.y > 2),
        };
    }

    // notes: [{ x, y, ms }] in editor coordinates (0..2). Returns true when the map is new to it.
    async function learn(notes, name = '') {
        await load();
        if (notes.length < 20)
            return false;
        const id = fingerprint([...notes].sort((a, b) => a.ms - b.ms));
        if (model.seen.includes(id))
            return false;
        const entry = toEntry(notes, name);
        if (entry.t.length < 20)
            return false;
        entry.id = id;
        model.maps.push(entry);
        model.seen.push(id);
        // keep the newest maps when there are too many notes to store
        let total = model.maps.reduce((n, m) => n + m.t.length, 0);
        while (total > MAX_NOTES && model.maps.length > 1)
            total -= model.maps.shift().t.length;
        if (model.seen.length > 5000)
            model.seen.splice(0, model.seen.length - 5000);
        await save();
        return true;
    }

    function statsSync() {
        return model ? { maps: model.maps.length, notes: model.maps.reduce((n, m) => n + m.t.length, 0) } : null;
    }

    async function stats() {
        await load();
        return statsSync();
    }

    async function reset() {
        model = emptyModel();
        await save();
    }

    // Classic Sound Space patterns, used only until a map has been learned
    function defaultEntry() {
        let seed = 7;
        const random = () => (seed = seed * 16807 % 2147483647) / 2147483647;
        const patterns = [
            [[0, 0], [2, 2], [0, 2], [2, 0]],
            [[0, 1], [2, 1], [0, 1], [2, 1]],
            [[1, 0], [1, 2], [1, 0], [1, 2]],
            [[0, 0], [1, 0], [2, 0], [2, 1], [2, 2], [1, 2], [0, 2], [0, 1]],
            [[0, 2], [1, 1], [2, 0], [1, 1]],
            [[0, 0], [2, 0], [1, 2]],
            [[0, 0], [0, 1], [0, 2], [1, 2], [2, 2], [2, 1], [2, 0], [1, 0]],
            [[2, 1], [0, 0], [2, 2], [0, 1]],
            [[0, 0], [1, 1], [2, 2], [1, 1]],
            [[1, 0], [0, 2], [2, 2], [1, 0]],
        ];
        const notes = [];
        let ms = 0;
        for (let p = 0; p < 400; p++) {
            const pattern = patterns[Math.floor(random() * patterns.length)];
            const f = SYM[Math.floor(random() * 8)];
            const gap = [75, 120, 180, 250, 330][Math.floor(random() * 5)];
            const reps = 1 + Math.floor(random() * 3);
            for (let r = 0; r < reps; r++)
                for (const [x, y] of pattern) {
                    const [tx, ty] = f(x, y);
                    if (notes.length && notes[notes.length - 1].x === tx && notes[notes.length - 1].y === ty)
                        continue;
                    notes.push({ x: tx, y: ty, ms });
                    ms += gap;
                }
            ms += 300;
        }
        return toEntry(notes, 'built in');
    }

    // ------------------------------------------------ listening to the song

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

    const percentile = (arr, f) => {
        const s = Float32Array.from(arr).sort();
        return s[Math.min(s.length - 1, Math.floor(s.length * f))] || 0;
    };

    function smooth(arr, radius) {
        const out = new Float32Array(arr.length);
        let sum = 0, count = 0;
        for (let i = 0; i < Math.min(arr.length, radius); i++) {
            sum += arr[i];
            count++;
        }
        for (let i = 0; i < arr.length; i++) {
            if (i + radius < arr.length) {
                sum += arr[i + radius];
                count++;
            }
            if (i - radius - 1 >= 0) {
                sum -= arr[i - radius - 1];
                count--;
            }
            out[i] = sum / count;
        }
        return out;
    }

    // Whole-song analysis, done once per song: 10ms frames of
    //  hits: how strongly something drum-like starts (bass and highs; the mids, where vocals sit, count for little)
    //  intensity: 0..1, how intense the song is around there compared to the rest of it (drops are near 1)
    const analyses = new WeakMap();
    async function analyse(buffer) {
        if (analyses.has(buffer))
            return analyses.get(buffer);
        const sr = buffer.sampleRate, N = 1024, hop = sr / 100;
        const frames = Math.max(0, Math.floor((buffer.length - N) / hop));
        const chans = [];
        for (let c = 0; c < buffer.numberOfChannels; c++)
            chans.push(buffer.getChannelData(c));
        const win = new Float32Array(N).map((_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
        const re = new Float32Array(N), im = new Float32Array(N);
        let prev = new Float32Array(N / 2), cur = new Float32Array(N / 2);
        const bin = f => Math.max(1, Math.min(N / 2 - 1, Math.round(f / sr * N)));
        const lowEnd = bin(170), midEnd = bin(2600), highEnd = bin(11000);
        const low = new Float32Array(frames), mid = new Float32Array(frames), high = new Float32Array(frames), rms = new Float32Array(frames);

        for (let f = 0; f < frames; f++) {
            const o = Math.floor(f * hop);
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
            let l = 0, m = 0, h = 0;
            for (let k = 1; k < highEnd; k++) {
                cur[k] = Math.log1p(100 * Math.hypot(re[k], im[k]));
                const d = cur[k] - prev[k];
                if (d > 0) {
                    if (k < lowEnd)
                        l += d;
                    else if (k < midEnd)
                        m += d;
                    else
                        h += d;
                }
            }
            if (f) {
                low[f] = l;
                mid[f] = m;
                high[f] = h;
            }
            [prev, cur] = [cur, prev];
            if (f % 1500 === 1499)
                await new Promise(r => setTimeout(r));
        }

        // each band on the same scale, then mostly bass and highs
        const norm = a => {
            const p = percentile(a, 0.97) || 1;
            for (let i = 0; i < a.length; i++)
                a[i] = Math.min(2, a[i] / p);
        };
        norm(low);
        norm(mid);
        norm(high);
        const raw = new Float32Array(frames);
        for (let i = 0; i < frames; i++)
            raw[i] = (low[i] * 1.2 + high[i] + mid[i] * 0.3) / 2.5;
        // only what stands out from its surroundings
        const base = smooth(raw, 15);
        const hits = new Float32Array(frames);
        for (let i = 0; i < frames; i++)
            hits[i] = Math.max(0, raw[i] - base[i] * 1.1);
        const hp = percentile(hits, 0.98) || 1;
        for (let i = 0; i < frames; i++)
            hits[i] = Math.min(1.5, hits[i] / hp);

        // intensity: how busy the drums are (mostly) and how loud it is, over a couple of seconds, ranked against the
        // rest of the song so the calmest parts are near 0 and the most intense near 1
        const loud = smooth(rms.map(v => Math.log10(v + 1e-4)), 150);
        const busy = smooth(hits, 150);
        const rank = a => {
            const sorted = Float32Array.from(a).sort();
            return a.map(v => {
                let lo = 0, hi = sorted.length;
                while (lo < hi) {
                    const m = (lo + hi) >> 1;
                    if (sorted[m] < v)
                        lo = m + 1;
                    else
                        hi = m;
                }
                return lo / sorted.length;
            });
        };
        const L = rank(loud), B = rank(busy);
        const intensity = smooth(L.map((v, i) => 0.3 * v + 0.7 * B[i]), 60);

        const result = { frames, hits, intensity, tempo: estimateTempo(hits) };
        analyses.set(buffer, result);
        return result;
    }

    // The beat (when the map has no BPM): the period that lines the drum hits up best, and where the beats fall
    function estimateTempo(hits) {
        const n = hits.length;
        if (n < 1000)
            return null;
        // rough: autocorrelation over 60-220 BPM, nudged towards usual tempos
        let best = null;
        for (let lag = 27; lag <= 100; lag++) {
            let s = 0;
            for (let i = 0; i + lag < n; i += 2)
                s += hits[i] * hits[i + lag];
            const bpm = 6000 / lag;
            s *= Math.exp(-0.5 * (Math.log2(bpm / 150) / 0.8) ** 2);
            if (!best || s > best.s)
                best = { s, lag };
        }
        // fine: the period (in steps of 0.02 BPM) and phase whose beats land on the most hits
        const strong = [];
        const th = percentile(hits, 0.9);
        for (let i = 1; i + 1 < n; i++)
            if (hits[i] > th && hits[i] >= hits[i - 1] && hits[i] >= hits[i + 1])
                strong.push([i, hits[i]]);
        if (strong.length < 50)
            return null;
        const center = 6000 / best.lag;
        let top = null;
        const BINS = 72;
        const hist = new Float64Array(BINS);
        for (let bpm = center * 0.96; bpm <= center * 1.04; bpm += 0.02) {
            const period = 6000 / bpm;
            hist.fill(0);
            for (const [i, v] of strong) {
                const ph = (i / period) % 1;
                hist[Math.floor(ph * BINS) % BINS] += v;
            }
            let peak = 0, at = 0;
            for (let b = 0; b < BINS; b++) {
                const v = hist[b] + 0.5 * (hist[(b + 1) % BINS] + hist[(b + BINS - 1) % BINS]);
                if (v > peak) {
                    peak = v;
                    at = b;
                }
            }
            if (!top || peak > top.peak)
                top = { peak, bpm, phase: (at + 0.5) / BINS * period, total: strong.reduce((s, x) => s + x[1], 0) };
        }
        const confidence = top.peak / (top.total / BINS * 2);
        // frames are 10ms
        return { bpm: top.bpm, offsetMs: top.phase * 10, confidence };
    }

    // ------------------------------------------------ choosing when notes go

    // how strongly each beat division counts (a note on the beat beats one on a 1/16)
    const DIV_WEIGHT = { 1: 1, 2: 0.75, 3: 0.55, 4: 0.55, 6: 0.42, 8: 0.4, 12: 0.32, 16: 0.3 };
    const DIVISIONS = [1, 2, 4, 6, 8, 12, 16];

    // beats and their subdivisions (up to `finest` per beat) between startMs and endMs: [{ ms, weight }]
    function gridTimes(timing, startMs, endMs, finest) {
        const out = new Map();
        const divs = [1, 2, 3, 4, 6, 8, 12, 16].filter(d => d <= finest && finest % d === 0);
        for (let i = 0; i < timing.length; i++) {
            const tp = timing[i];
            const until = i + 1 < timing.length ? timing[i + 1].ms : endMs + 1;
            const beat = 60000 / tp.bpm;
            if (!(beat > 5))
                continue;
            divs.forEach(d => {
                const step = beat / d;
                let k = Math.ceil((Math.max(startMs, tp.ms) - tp.ms) / step - 1e-6);
                for (let ms = tp.ms + k * step; ms < Math.min(until, endMs + 0.5); ms = tp.ms + ++k * step) {
                    const key = Math.round(ms);
                    if (key >= startMs && !out.has(key))
                        out.set(key, DIV_WEIGHT[d]);
                }
            });
        }
        return [...out].map(([ms, weight]) => ({ ms, weight })).sort((a, b) => a.ms - b.ms);
    }

    const hitAt = (a, ms, radius = 2) => {
        const f = Math.round(ms / 10);
        let best = 0;
        for (let k = Math.max(0, f - radius); k <= Math.min(a.frames - 1, f + radius); k++)
            best = Math.max(best, a.hits[k]);
        return best;
    };
    const intensityAt = (a, ms) => a.intensity[Math.min(a.frames - 1, Math.max(0, Math.round(ms / 10)))] || 0;

    // How many notes per second where the song has this intensity, for an average of `nps` over the whole song
    function densityCurve(a, nps) {
        const shape = v => 0.2 + 1.8 * Math.pow(v, 1.6);
        let mean = 0;
        for (let i = 0; i < a.frames; i += 10)
            mean += shape(a.intensity[i]);
        mean /= Math.ceil(a.frames / 10) || 1;
        return v => nps * shape(v) / (mean || 1);
    }

    function chooseTimes(a, opts, nps) {
        const { startMs, endMs } = opts;
        const density = densityCurve(a, nps);
        const WINDOW = 2000;

        // how many notes each stretch gets
        const windows = [];
        for (let w = startMs; w < endMs; w += WINDOW) {
            const to = Math.min(endMs, w + WINDOW);
            let sum = 0, count = 0;
            for (let ms = w; ms < to; ms += 50) {
                sum += intensityAt(a, ms);
                count++;
            }
            const level = sum / Math.max(1, count);
            windows.push({ from: w, to, level, want: density(level) * (to - w) / 1000 });
        }
        if (opts.count > 0) {
            const total = windows.reduce((n, w) => n + w.want, 0) || 1;
            for (const w of windows)
                w.want *= opts.count / total;
        }

        const timing = opts.timing && opts.timing.length ? opts.timing
            : a.tempo && a.tempo.confidence > 1.25 ? [{ bpm: a.tempo.bpm, ms: a.tempo.offsetMs }] : null;
        const fromUser = !!(opts.timing && opts.timing.length);
        const avoid = opts.avoid || [];
        const out = [];

        for (const w of windows) {
            let want = Math.round(w.want + (Math.random() - 0.5) * 0.6);
            if (want <= 0)
                continue;
            let candidates;
            if (timing) {
                // the coarsest beat division that has room for this many notes
                const bpm = timing.reduce((b, t) => t.ms <= w.from ? t.bpm : b, timing[0].bpm);
                const perBeat = want / ((w.to - w.from) / (60000 / bpm));
                const finest = DIVISIONS.find(d => d >= perBeat * 1.1) || 16;
                candidates = gridTimes(timing, w.from, w.to, finest).map(g => {
                    // a detected beat can be a little off: use the hit itself when it's right there
                    let ms = g.ms;
                    if (!fromUser) {
                        const f = Math.round(ms / 10);
                        let best = -1, at = f;
                        for (let k = f - 2; k <= f + 2; k++)
                            if (k >= 0 && k < a.frames && a.hits[k] > best) {
                                best = a.hits[k];
                                at = k;
                            }
                        if (best > 0.25)
                            ms = at * 10;
                    }
                    const bonus = g.weight;
                    return { ms, score: hitAt(a, g.ms) * bonus + bonus * 0.12 + Math.random() * 0.01 };
                });
            } else {
                // no beat to follow: the hits themselves, then even steps between them where it's busy
                candidates = [];
                for (let f = Math.max(1, Math.floor(w.from / 10)); f < Math.min(a.frames - 1, w.to / 10); f++)
                    if (a.hits[f] > 0.08 && a.hits[f] >= a.hits[f - 1] && a.hits[f] >= a.hits[f + 1])
                        candidates.push({ ms: f * 10, score: a.hits[f] });
            }

            const minGap = Math.max(12, Math.min(250, (w.to - w.from) / want * 0.55));
            const taken = [];
            const free = ms => taken.every(t => Math.abs(t - ms) >= minGap) && avoid.every(t => Math.abs(t - ms) >= minGap)
                && out.every(t => Math.abs(t - ms) >= minGap || t < ms - 500);
            for (const c of candidates.sort((p, q) => q.score - p.score)) {
                if (taken.length >= want)
                    break;
                const ms = Math.round(c.ms);
                if (ms >= startMs && ms <= endMs && free(ms))
                    taken.push(ms);
            }
            // still short with no beat: stream evenly between the hits
            if (!timing && taken.length < want) {
                const pts = [w.from, ...taken.sort((p, q) => p - q), w.to];
                const spacing = (w.to - w.from) / want;
                const extra = [];
                for (let i = 0; i + 1 < pts.length && taken.length + extra.length < want; i++) {
                    const n = Math.round((pts[i + 1] - pts[i]) / spacing) - 1;
                    for (let k = 1; k <= n && taken.length + extra.length < want; k++) {
                        const ms = Math.round(pts[i] + (pts[i + 1] - pts[i]) * k / (n + 1));
                        if (ms > startMs && ms < endMs && free(ms))
                            extra.push(ms);
                    }
                }
                taken.push(...extra);
            }
            out.push(...taken);
        }
        return out.sort((p, q) => p - q);
    }

    // ------------------------------------------------ choosing where notes go

    // Library entries with lookups from a position to the notes there
    function prepare(entries, quantum) {
        return entries.map(e => {
            const n = e.t.length;
            const at = new Map();
            for (let i = 0; i + 1 < n; i++) {
                const key = posKey(e.x[i], e.y[i]);
                let list = at.get(key);
                if (!list)
                    at.set(key, list = []);
                list.push(i);
            }
            // where a run of whole-cell notes ends (for when quantum notes aren't allowed)
            const wholeUntil = new Int32Array(n);
            for (let i = n - 1; i >= 0; i--) {
                const whole = isWhole(e.x[i]) && isWhole(e.y[i]) && e.x[i] >= 0 && e.x[i] <= 2 && e.y[i] >= 0 && e.y[i] <= 2;
                wholeUntil[i] = whole ? (i + 1 < n ? Math.max(i + 1, wholeUntil[i + 1]) : n) : i;
            }
            return { ...e, n, at, wholeUntil, usable: quantum || !e.quantum || wholeUntil.some((u, i) => u - i >= 4) };
        }).filter(e => e.n >= 8 && e.usable);
    }

    // Finds the run of library notes to copy next.
    // gaps: the time from the previous note to each new note; prev/prev2: the last two notes placed
    function findRun(lib, gaps, prev, prev2, opts, used) {
        const bounds = opts.quantum ? QUANTUM : GRID;
        const target = opts.spread; // 0..1: how big the moves should be, compared to what fits here
        const candidates = [];

        const consider = (e, k, i, ox, oy) => {
            // copy e[i + 1 ...] after e[i], which lands on prev
            const f = SYM[k];
            const len = Math.min(gaps.length, e.n - i - 1, opts.quantum ? Infinity : e.wholeUntil[i + 1] - i - 1);
            if (len < Math.min(3, gaps.length))
                return;
            let cost = 0, used_len = 0, dist = 0, time = 0, jacks = 0, spins = 0;
            const recent = [prev2, prev].filter(Boolean).map(p => [p.x, p.y]);
            for (let q = 0; q < len; q++) {
                const gl = e.t[i + q + 1] - e.t[i + q], gg = gaps[q];
                const c = Math.abs(Math.log((Math.min(gg, 800) + 10) / (Math.min(gl, 800) + 10)));
                if (c > (opts.loose ? 3 : 0.45) && q > 0)
                    break;
                const [x, y] = f(e.x[i + q + 1], e.y[i + q + 1]);
                if (x + ox < bounds[0] - 1e-6 || x + ox > bounds[1] + 1e-6 || y + oy < bounds[0] - 1e-6 || y + oy > bounds[1] + 1e-6)
                    break;
                cost += c * (q === 0 ? 2 : 1);
                // notes on the same spot twice and little 2x2 circles are what make auto maps feel wrong
                const last = recent[recent.length - 1];
                if (last && Math.abs(last[0] - x - ox) < 1e-3 && Math.abs(last[1] - y - oy) < 1e-3)
                    jacks++;
                recent.push([x + ox, y + oy]);
                if (recent.length >= 4) {
                    const w = recent.slice(-4);
                    const xs = w.map(v => v[0]), ys = w.map(v => v[1]);
                    if (Math.max(...xs) - Math.min(...xs) <= 1.001 && Math.max(...ys) - Math.min(...ys) <= 1.001
                        && new Set(w.map(v => v.join(','))).size === 4)
                        spins++;
                }
                dist += Math.hypot(e.x[i + q + 1] - e.x[i + q], e.y[i + q + 1] - e.y[i + q]);
                time += Math.max(gl, 1);
                used_len++;
            }
            if (used_len < Math.min(opts.loose ? 1 : 3, gaps.length))
                return;
            cost /= used_len + 1;
            cost += 1.2 * jacks / used_len + 0.8 * spins / used_len;
            // carries on in the same way the library did before this point
            if (prev2 && i > 0) {
                const [px, py] = f(e.x[i - 1], e.y[i - 1]);
                const [cx, cy] = f(e.x[i], e.y[i]);
                const v1 = [prev.x - prev2.x, prev.y - prev2.y], v2 = [cx - px, cy - py];
                const l1 = Math.hypot(...v1), l2 = Math.hypot(...v2);
                if (l1 > 1e-3 && l2 > 1e-3)
                    cost += 0.25 * (1 - (v1[0] * v2[0] + v1[1] * v2[1]) / (l1 * l2)) + 0.08 * Math.abs(Math.log(l1 / l2));
                else if ((l1 > 1e-3) !== (l2 > 1e-3))
                    cost += 0.3;
            }
            cost += 0.25 * Math.hypot(ox, oy);
            const usedBefore = used.get(e);
            if (usedBefore && usedBefore.some(u => Math.abs(u - i) < 24))
                cost += 0.5;
            cost -= e.bonus || 0;
            cost -= 0.004 * used_len;
            candidates.push({ e, k, i, ox, oy, len: used_len, cost, speed: dist / Math.max(time, 1) });
        };

        const sample = (list, max) => {
            if (list.length <= max)
                return list;
            const out = [];
            for (let s = 0; s < max; s++)
                out.push(list[Math.floor(Math.random() * list.length)]);
            return out;
        };

        if (prev) {
            for (const e of lib)
                for (let k = 0; k < 8; k++) {
                    const [lx, ly] = SYM[INV[k]](prev.x, prev.y);
                    const list = e.at.get(posKey(lx, ly));
                    if (list)
                        for (const i of sample(list, 260))
                            consider(e, k, i, 0, 0);
                }
            // nothing starts exactly here (a quantum note, or a spot the maps never use): shift a run over to it
            if (candidates.length < 6)
                for (const e of lib)
                    for (let s = 0; s < 120; s++) {
                        const i = Math.floor(Math.random() * (e.n - 2));
                        const k = Math.floor(Math.random() * 8);
                        const [x, y] = SYM[k](e.x[i], e.y[i]);
                        let ox = prev.x - x, oy = prev.y - y;
                        if (!opts.quantum) {
                            if (!isWhole(ox) || !isWhole(oy))
                                continue;
                        }
                        consider(e, k, i, ox, oy);
                    }
        } else
            for (const e of lib)
                for (let s = 0; s < 300; s++)
                    consider(e, Math.floor(Math.random() * 8), Math.floor(Math.random() * (e.n - 2)), 0, 0);

        if (!candidates.length)
            return null;

        // drops get the bigger moves, calm parts the smaller ones (among runs that fit equally well)
        const bySpeed = [...candidates].sort((p, q) => p.speed - q.speed);
        bySpeed.forEach((c, r) => c.cost += 0.25 * Math.abs(r / Math.max(1, bySpeed.length - 1) - target));

        candidates.sort((p, q) => p.cost - q.cost);
        const top = candidates.slice(0, 6);
        const weights = top.map(c => Math.exp(-(c.cost - top[0].cost) / 0.06));
        let r = Math.random() * weights.reduce((p, q) => p + q, 0);
        for (let j = 0; j < top.length; j++) {
            r -= weights[j];
            if (r <= 0)
                return top[j];
        }
        return top[0];
    }

    // opts: { buffer (AudioBuffer), startMs, endMs, difficulty (1..10), density (1 = normal), count (0 = by difficulty),
    //         quantum (allow notes off the 3x3 grid), timing ([{ bpm, ms }] from the map, if it has any),
    //         before (the notes just before startMs), styleNotes (the map's own notes: their patterns are preferred),
    //         avoid (times already taken) }
    async function generate(opts) {
        await load();
        const a = await analyse(opts.buffer);
        const difficulty = Math.min(10, Math.max(1, opts.difficulty || 5));
        // 1 = ~1.5 notes a second on average, 5 = ~5.5, 10 = ~30 (Tasukete streams)
        const nps = 1.5 * Math.pow(20, (difficulty - 1) / 9) * (opts.density || 1);
        const times = chooseTimes(a, opts, nps);
        if (!times.length)
            return [];

        // what to copy from: the learned maps, the map being made (preferred), or built-in patterns
        let entries = model.maps.slice();
        const style = (opts.styleNotes || []).filter(n => n.ms < opts.startMs || n.ms > opts.endMs);
        if (style.length >= 12) {
            const own = toEntry(style, 'this map');
            own.bonus = 0.12;
            entries.push(own);
        }
        let lib = prepare(entries, !!opts.quantum);
        if (!lib.length)
            lib = prepare([defaultEntry()], !!opts.quantum);

        const out = [];
        const before = (opts.before || []).slice(-2);
        let prev = before.length ? before[before.length - 1] : null;
        let prev2 = before.length > 1 ? before[0] : null;
        if (prev && !opts.quantum && (!isWhole(prev.x) || !isWhole(prev.y)))
            prev = { x: Math.min(2, Math.max(0, Math.round(prev.x))), y: Math.min(2, Math.max(0, Math.round(prev.y))), ms: prev.ms };
        const used = new Map();
        const spreadBias = (difficulty - 5) * 0.03;

        let i = 0;
        const copyRun = r => {
            const f = SYM[r.k];
            for (let q = 0; q < r.len && i < times.length; q++, i++) {
                const [x, y] = f(r.e.x[r.i + q + 1], r.e.y[r.i + q + 1]);
                const note = { x: Math.round((x + r.ox) * 1000) / 1000, y: Math.round((y + r.oy) * 1000) / 1000, ms: times[i] };
                out.push(note);
                prev2 = prev;
                prev = note;
            }
            const list = used.get(r.e) || [];
            list.push(r.i);
            if (list.length > 40)
                list.shift();
            used.set(r.e, list);
        };

        while (i < times.length) {
            // a run of up to 8-16 notes, ending where the rhythm changes a lot (a new phrase)
            const L = 8 + Math.floor(Math.random() * 9);
            const gaps = [];
            for (let q = 0; q < L && i + q < times.length; q++) {
                const g = times[i + q] - (q === 0 ? (prev ? prev.ms : times[i] - 500) : times[i + q - 1]);
                if (q > 2 && (g > gaps[q - 1] * 1.9 || g * 1.9 < gaps[q - 1]))
                    break;
                gaps.push(g);
            }
            const spread = Math.min(1, Math.max(0, 0.5 + (intensityAt(a, times[i]) - 0.5) * 0.8 + spreadBias));
            const ropts = { quantum: !!opts.quantum, spread };
            // nothing carries on from here: anything that does, then a fresh start
            const run = findRun(lib, gaps, prev, prev2, ropts, used)
                || findRun(lib, gaps, prev, prev2, { ...ropts, loose: true }, used)
                || findRun(lib, gaps, null, null, { ...ropts, loose: true }, used);
            if (!run)
                break;
            copyRun(run);
        }
        return out;
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
                else if (await learn(notes, map.props.songName || f.name))
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
    return { learn, learnFiles, stats, statsSync, reset, generate, analyse };
})();
