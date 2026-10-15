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

    // rank of each value among all of them, 0..1
    function rank(a) {
        const sorted = Float32Array.from(a).sort();
        return Float32Array.from(a, v => {
            let lo = 0, hi = sorted.length;
            while (lo < hi) {
                const m = (lo + hi) >> 1;
                if (sorted[m] < v)
                    lo = m + 1;
                else
                    hi = m;
            }
            return lo / Math.max(1, sorted.length - 1);
        });
    }

    // median of the first n values of buf (sorted in place)
    function median(buf, n) {
        for (let i = 1; i < n; i++) {
            const v = buf[i];
            let j = i - 1;
            while (j >= 0 && buf[j] > v) {
                buf[j + 1] = buf[j];
                j--;
            }
            buf[j + 1] = v;
        }
        return buf[n >> 1];
    }

    // Whole-song analysis, done once per song (in 10ms frames).
    // The spectrum is split into its percussive and harmonic parts (median filtering across frequency and across
    // time): drums are short and wide, vocals and instruments are long and narrow. Only the percussive part is used to
    // place notes, so singing doesn't get synced.
    const analyses = new WeakMap();
    async function analyse(buffer, progress = () => { }) {
        if (analyses.has(buffer))
            return analyses.get(buffer);
        const sr = buffer.sampleRate, N = 1024, hop = sr / 100;
        const frames = Math.max(0, Math.floor((buffer.length - N) / hop));
        const B = Math.min(N / 2 - 1, Math.round(11000 / sr * N));
        const bin = f => Math.max(1, Math.min(B, Math.round(f / sr * N)));
        const lowEnd = bin(160), midEnd = bin(4500);
        const chans = [];
        for (let c = 0; c < buffer.numberOfChannels; c++)
            chans.push(buffer.getChannelData(c));
        const win = new Float32Array(N).map((_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
        const re = new Float32Array(N), im = new Float32Array(N);

        const T = 13, HALF = 6; // median windows: 13 frames (130ms) across time, 13 bins across frequency
        const ring = Array.from({ length: T }, () => new Float32Array(B + 1));
        const tmp = new Float32Array(T);
        let prevLp = new Float32Array(B + 1), lp = new Float32Array(B + 1);
        const low = new Float32Array(frames), mid = new Float32Array(frames), high = new Float32Array(frames);
        const rms = new Float32Array(frames), harmonic = new Float32Array(frames);

        for (let f = 0; f < frames + HALF; f++) {
            if (f < frames) {
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
                const mag = ring[f % T];
                for (let k = 1; k <= B; k++)
                    mag[k] = Math.hypot(re[k], im[k]);
            }
            const g = f - HALF;
            if (g < 0)
                continue;
            const cur = ring[g % T];
            const from = Math.max(0, g - HALF), to = Math.min(frames - 1, g + HALF);
            let l = 0, m = 0, h = 0, harm = 0;
            for (let k = 1; k <= B; k++) {
                // harmonic: median over time; percussive: median over frequency
                let n = 0;
                for (let q = from; q <= to; q++)
                    tmp[n++] = ring[q % T][k];
                const H = median(tmp, n);
                n = 0;
                for (let j = Math.max(1, k - HALF); j <= Math.min(B, k + HALF); j++)
                    tmp[n++] = cur[j];
                const P = median(tmp, n);
                const mask = P * P / (P * P + H * H + 1e-12);
                lp[k] = Math.log1p(100 * cur[k] * mask);
                harm += cur[k] * (1 - mask);
                const d = lp[k] - prevLp[k];
                if (d > 0) {
                    if (k < lowEnd)
                        l += d;
                    else if (k < midEnd)
                        m += d;
                    else
                        h += d;
                }
            }
            if (g) {
                low[g] = l;
                mid[g] = m;
                high[g] = h;
            }
            harmonic[g] = harm;
            [prevLp, lp] = [lp, prevLp];
            if (g % 400 === 399) {
                progress(`LISTENING TO THE SONG ${Math.round(g / frames * 100)}%`);
                await new Promise(r => setTimeout(r));
            }
        }

        // each band on the same scale
        for (const a of [low, mid, high]) {
            const p = percentile(a, 0.97) || 1;
            for (let i = 0; i < a.length; i++)
                a[i] = Math.min(2, a[i] / p);
        }
        // what stands out from its surroundings
        const peaky = raw => {
            const base = smooth(raw, 12);
            const out = new Float32Array(raw.length);
            for (let i = 0; i < raw.length; i++)
                out[i] = Math.max(0, raw[i] - base[i] * 1.05);
            const p = percentile(out, 0.98) || 1;
            for (let i = 0; i < out.length; i++)
                out[i] = Math.min(1.5, out[i] / p);
            return out;
        };
        // hits: any drum (kick, snare, hats); beats: the kick and snare, which carry the beat
        const hits = peaky(Float32Array.from(low, (v, i) => (1.2 * v + mid[i] + 0.6 * high[i]) / 2.8));
        const beats = peaky(Float32Array.from(low, (v, i) => (1.4 * v + mid[i]) / 2.4));

        progress('FINDING THE BPM');
        await new Promise(r => setTimeout(r));
        const tempo = findTempo(beats, hits, frames);

        const result = { frames, hits, beats, low, rms, harmonic, tempo };
        analyses.set(buffer, result);
        return result;
    }

    // value of an envelope at a (fractional) frame: the strongest within ±r frames
    function around(env, f, r = 2) {
        const c = Math.round(f);
        let best = 0;
        for (let k = Math.max(0, c - r); k <= Math.min(env.length - 1, c + r); k++)
            if (env[k] > best)
                best = env[k];
        return best;
    }

    // How well a beat grid (period and phase in frames) sits on the kicks and snares: their average strength on its
    // beats, against their average strength anywhere
    function beatScore(env, period, phase, from = 0, to = env.length) {
        let sum = 0, n = 0;
        for (let t = phase + Math.ceil((from - phase) / period) * period; t < to; t += period) {
            sum += around(env, t, 1);
            n++;
        }
        return n ? sum / n : 0;
    }

    // The song's BPM and where its beats are. Every likely tempo (from the rhythm's repetition) and its relatives
    // (x2, /2, x3/2, /3/2) is tried; the one whose beats land on the most kick and snare hits wins, with a nudge
    // towards rhythm game tempos. Then the BPM is fine tuned and checked for drifting.
    function findTempo(beats, hits, frames) {
        if (frames < 1500)
            return null;
        const mean = beats.reduce((a, b) => a + b, 0) / frames || 1e-6;

        // candidates from the autocorrelation of the drums
        const ac = [];
        for (let lag = 20; lag <= 140; lag++) {
            let s = 0;
            for (let i = 0; i + lag < frames; i += 2)
                s += hits[i] * hits[i + lag];
            ac[lag] = s;
        }
        const peaks = [];
        for (let lag = 21; lag < 140; lag++)
            if (ac[lag] >= ac[lag - 1] && ac[lag] >= ac[lag + 1])
                peaks.push(lag);
        peaks.sort((a, b) => ac[b] - ac[a]);
        const candidates = [];
        for (const lag of peaks.slice(0, 6))
            for (const r of [1, 2, 0.5, 1.5, 2 / 3, 4 / 3, 0.75]) {
                const bpm = 6000 / lag * r;
                if (bpm >= 85 && bpm <= 280 && !candidates.some(c => Math.abs(c / bpm - 1) < 0.012))
                    candidates.push(bpm);
            }

        // best phase for a period: where the strongest hits gather
        const strong = [];
        const th = percentile(beats, 0.85);
        for (let i = 1; i + 1 < frames; i++)
            if (beats[i] > th && beats[i] >= beats[i - 1] && beats[i] >= beats[i + 1]) {
                // the peak between frames
                const a = beats[i - 1], b = beats[i], c = beats[i + 1];
                const d = a - 2 * b + c;
                strong.push([i + (d ? 0.5 * (a - c) / d : 0), b]);
            }
        if (strong.length < 40)
            return null;
        const phaseFor = period => {
            const BINS = 100;
            const hist = new Float64Array(BINS);
            for (const [t, v] of strong)
                hist[Math.floor((t / period % 1) * BINS) % BINS] += v;
            let best = 0, at = 0;
            for (let k = 0; k < BINS; k++) {
                const v = hist[k] + 0.6 * (hist[(k + 1) % BINS] + hist[(k + BINS - 1) % BINS]);
                if (v > best) {
                    best = v;
                    at = k;
                }
            }
            return (at + 0.5) / BINS * period;
        };
        const prior = bpm => Math.exp(-0.5 * (Math.log2(bpm / 175) / 0.55) ** 2);

        // 1) each candidate tuned in 0.01 BPM steps: the tempo whose beats gather the strong hits most tightly
        const total = strong.reduce((t, x) => t + x[1], 0);
        const gather = bpm => {
            const period = 6000 / bpm, BINS = Math.max(8, Math.round(period * 4));
            const hist = new Float64Array(BINS);
            for (const [t, v] of strong)
                hist[Math.floor((t / period % 1) * BINS) % BINS] += v;
            let best = 0;
            for (let k = 0; k < BINS; k++) {
                let s = 0;
                for (let j = -2; j <= 2; j++)
                    s += hist[(k + j + BINS) % BINS];
                if (s > best)
                    best = s;
            }
            return best / total;
        };
        const tuned = [];
        for (const c of candidates) {
            let top = null;
            for (let bpm = c * 0.992; bpm <= c * 1.008; bpm += 0.01) {
                const g = gather(bpm);
                if (!top || g > top.g)
                    top = { bpm, g };
            }
            if (!tuned.some(t => Math.abs(t.bpm / top.bpm - 1) < 0.003))
                tuned.push(top);
        }

        // 2) which of them is the beat: kicks and snares on its beats, and on its half beats too (a tempo 2/3 or 3/2 off
        // puts half of its beats between hits), with a nudge towards usual rhythm game tempos
        const fullScore = bpm => {
            const period = 6000 / bpm;
            let top = { s: -1, phase: 0 };
            for (let ph = 0; ph < period; ph += 0.25) {
                const v = beatScore(beats, period, ph);
                if (v > top.s)
                    top = { s: v, phase: ph };
            }
            const half = beatScore(beats, period, top.phase + period / 2);
            return { onBeats: top.s / mean, half: half / mean, phase: top.phase };
        };
        let best = null;
        for (const t of tuned) {
            const f = fullScore(t.bpm);
            const score = (f.onBeats + 0.5 * f.half) * (0.55 + 0.45 * prior(t.bpm));
            if (!best || score > best.score)
                best = { bpm: t.bpm, phase: f.phase, score, onBeats: f.onBeats };
        }
        if (!best)
            return null;

        // 3) fine: 0.002 BPM steps
        let fine = { ...best, g: gather(best.bpm) };
        for (let bpm = best.bpm - 0.03; bpm <= best.bpm + 0.03; bpm += 0.002) {
            const g = gather(bpm);
            if (g > fine.g)
                fine = { bpm, g, onBeats: best.onBeats };
        }
        // 4) precise: a straight line through the strong hits that sit on beats (time = offset + beat number x period)
        {
            let period = 6000 / fine.bpm, phase = fullScore(fine.bpm).phase;
            for (let pass = 0; pass < 3; pass++) {
                let n = 0, sk = 0, st = 0, skk = 0, skt = 0;
                for (const [t, v] of strong) {
                    const k = Math.round((t - phase) / period);
                    if (Math.abs(t - (phase + k * period)) > 2)
                        continue;
                    n += v;
                    sk += v * k;
                    st += v * t;
                    skk += v * k * k;
                    skt += v * k * t;
                }
                const det = n * skk - sk * sk;
                if (n < 20 || !det)
                    break;
                const p2 = (n * skt - sk * st) / det;
                if (!(p2 > 0) || Math.abs(p2 / period - 1) > 0.003)
                    break;
                phase = (st - p2 * sk) / n;
                period = p2;
            }
            fine.bpm = 6000 / period;
        }

        // a whole number when it's that close, otherwise two decimals
        let bpm = Math.abs(fine.bpm - Math.round(fine.bpm)) < 0.06 ? Math.round(fine.bpm) : Math.round(fine.bpm * 100) / 100;
        let period = 6000 / bpm;
        // phase to the millisecond for the rounded BPM
        let phase = phaseFor(period), top = -1;
        for (let p = phase - 2; p <= phase + 2; p += 0.1) {
            const s = beatScore(beats, period, p);
            if (s > top) {
                top = s;
                phase = p;
            }
        }
        phase = ((phase % period) + period) % period;

        // does the beat stay put? the local shift that fits each 15 seconds best
        const shifts = [];
        for (let from = 0; from + 1500 <= frames; from += 1500) {
            let bestShift = 0, bestS = -1;
            for (let s = -5; s <= 5; s += 0.5) {
                const v = beatScore(beats, period, phase + s, from, from + 1500);
                if (v > bestS) {
                    bestS = v;
                    bestShift = s;
                }
            }
            shifts.push(bestShift);
        }
        const steady = shifts.filter(s => Math.abs(s) <= 1.5).length >= shifts.length * 0.8;

        // swing: are the hits between beats on thirds rather than quarters?
        let thirds = 0, quarters = 0;
        for (let t = phase; t < frames - period; t += period) {
            thirds += around(hits, t + period / 3, 1) + around(hits, t + 2 * period / 3, 1);
            quarters += around(hits, t + period / 4, 1) + around(hits, t + 3 * period / 4, 1);
        }

        return {
            bpm, offsetMs: phase * 10, steady, triplet: thirds > quarters * 1.25,
            confidence: fine.onBeats, shifts,
        };
    }

    // ------------------------------------------------ the song's sections

    // Beat times (ms) between fromMs and toMs, from the map's timing points or the detected tempo
    function beatTimes(timing, fromMs, toMs) {
        const out = [];
        for (let i = 0; i < timing.length; i++) {
            const tp = timing[i];
            const until = i + 1 < timing.length ? timing[i + 1].ms : toMs + 1;
            const beat = 60000 / tp.bpm;
            if (!(beat > 20))
                continue;
            let k = Math.ceil((Math.max(fromMs, tp.ms) - tp.ms) / beat - 1e-6);
            if (i === 0 && fromMs < tp.ms)
                k = Math.ceil((fromMs - tp.ms) / beat - 1e-6);
            for (let ms = tp.ms + k * beat; ms < Math.min(until, toMs + 0.5); ms = tp.ms + ++k * beat)
                out.push({ ms, index: k, tp: i });
        }
        return out;
    }

    // Splits the song into sections of steady intensity (bars of 4 beats grouped where the drums and loudness stay
    // about the same), each with a level from 0 (calmest) to 1 (most intense), and marks drops.
    function findSections(a, bars) {
        const n = bars.length;
        if (!n)
            return [];
        const feat = bars.map(b => {
            const f0 = Math.max(0, Math.floor(b.from / 10)), f1 = Math.min(a.frames, Math.max(f0 + 1, Math.floor(b.to / 10)));
            let loud = 0, hits = 0, kick = 0, harm = 0;
            for (let f = f0; f < f1; f++) {
                loud += Math.log10(a.rms[f] + 1e-4);
                hits += a.hits[f];
                kick += a.low[f];
                harm += a.harmonic[f];
            }
            const c = f1 - f0;
            return [loud / c, hits / c, kick / c, harm / c];
        });
        const R = [0, 1, 2, 3].map(j => rank(feat.map(v => v[j])));
        const v = bars.map((_, i) => 0.3 * R[0][i] + 0.4 * R[1][i] + 0.2 * R[2][i] + 0.1 * R[3][i]);

        // best split into sections of at least 4 bars: least spread inside sections, plus a cost per section
        const MIN = Math.min(4, n), LAMBDA = 0.6;
        const pre = [0], pre2 = [0];
        for (let i = 0; i < n; i++) {
            pre.push(pre[i] + v[i]);
            pre2.push(pre2[i] + v[i] * v[i]);
        }
        const sse = (i, j) => {
            const s = pre[j] - pre[i], s2 = pre2[j] - pre2[i];
            return s2 - s * s / (j - i);
        };
        const cost = new Float64Array(n + 1).fill(Infinity), from = new Int32Array(n + 1);
        cost[0] = 0;
        for (let j = MIN; j <= n; j++)
            for (let i = 0; i <= j - MIN; i++) {
                if (cost[i] === Infinity)
                    continue;
                const c = cost[i] + sse(i, j) + LAMBDA * 0.25;
                if (c < cost[j]) {
                    cost[j] = c;
                    from[j] = i;
                }
            }
        if (cost[n] === Infinity) {
            cost[n] = 0;
            from[n] = 0;
        }
        const cuts = [];
        for (let j = n; j > 0; j = from[j])
            cuts.unshift([from[j], j]);
        const sections = cuts.map(([i, j]) => ({
            from: bars[i].from, to: bars[j - 1].to, level: (pre[j] - pre[i]) / (j - i), bars: j - i, drop: false,
        }));
        sections.forEach((s, i) => {
            const before = sections[i - 1];
            s.drop = s.level >= 0.65 && (!before || before.level <= s.level - 0.18);
        });
        return sections;
    }

    // ------------------------------------------------ choosing when notes go

    // beat divisions, and how much a note on each position counts (on the beat most, then 1/2, then the rest)
    const STRAIGHT = [1, 2, 4, 8, 16];
    const SWUNG = [1, 3, 6, 12];
    function slotWeight(pos, div) {
        // pos: 0..div-1 within the beat
        if (pos === 0)
            return 1;
        for (const [d, w] of [[2, 0.72], [3, 0.6], [4, 0.55], [6, 0.42], [8, 0.4], [12, 0.33], [16, 0.3]])
            if (div % d === 0 && (pos * d) % div === 0)
                return w;
        return 0.3;
    }

    // Picks the note times. Each section gets a steady density (more in intense parts and drops, fewer in calm
    // ones, for the chosen average), on one beat division for the whole section, and inside each bar the notes go
    // where the drums hit (helped by where they usually hit in that section, so the rhythm keeps a pattern).
    function chooseTimes(a, opts, nps, ctx) {
        const { startMs, endMs } = opts;
        const songMs = a.frames * 10;
        const beats = beatTimes(ctx.timing, 0, songMs);
        // bars of 4 beats, counted from the timing point
        const bars = [];
        for (let i = 0; i < beats.length; i++) {
            if (((beats[i].index % 4) + 4) % 4 !== 0 && bars.length)
                continue;
            const next = beats.slice(i + 1).find(b => ((b.index % 4) + 4) % 4 === 0 || b.tp !== beats[i].tp);
            bars.push({ from: beats[i].ms, to: next ? next.ms : Math.min(songMs, beats[i].ms + 4 * 60000 / ctx.timing[beats[i].tp].bpm), first: i });
        }
        const sections = findSections(a, bars);
        ctx.sections = sections;

        // density per section, averaging `nps` over the whole song
        const shape = s => (0.3 + 1.6 * Math.pow(s.level, 1.5)) * (s.drop ? 1.15 : 1);
        const total = sections.reduce((t, s) => t + shape(s) * (s.to - s.from), 0) || 1;
        const span = sections.reduce((t, s) => t + (s.to - s.from), 0) || 1;
        sections.forEach(s => s.nps = nps * shape(s) * span / total);
        const sectionAt = ms => sections.find(s => ms >= s.from && ms < s.to) || sections[sections.length - 1];

        // notes wanted in each bar of the range
        const inRange = bars.filter(b => b.to > startMs && b.from < endMs);
        let want = inRange.map(b => {
            const s = sectionAt(b.from);
            const part = (Math.min(b.to, endMs) - Math.max(b.from, startMs)) / (b.to - b.from);
            return s.nps * (b.to - b.from) / 1000 * part;
        });
        if (opts.count > 0) {
            const sum = want.reduce((p, q) => p + q, 0) || 1;
            want = want.map(w => w * opts.count / sum);
        }

        const family = ctx.triplet ? SWUNG : STRAIGHT;
        const shiftAt = ms => {
            if (!ctx.shifts)
                return 0;
            const i = Math.min(ctx.shifts.length - 1, Math.max(0, Math.floor(ms / 15000)));
            return ctx.shifts[i] * 10;
        };
        // one division per section: the coarsest with room for its busiest bar
        const divFor = new Map();
        inRange.forEach((b, j) => {
            const s = sectionAt(b.from);
            const beatsIn = Math.max(1, Math.round((b.to - b.from) / (60000 / ctx.timing[beats[b.first].tp].bpm)));
            const perBeat = want[j] / beatsIn;
            const d = family.find(d => d >= perBeat * 1.05) || family[family.length - 1];
            divFor.set(s, Math.max(divFor.get(s) || 1, d));
        });

        // slots in a bar: [{ ms, weight, pos }]
        const slotsOf = b => {
            const d = divFor.get(sectionAt(b.from)) || 1;
            const out = [];
            for (let i = b.first; i < beats.length && beats[i].ms < b.to - 1; i++) {
                const t0 = beats[i].ms, t1 = i + 1 < beats.length ? beats[i + 1].ms : t0 + 60000 / ctx.timing[beats[i].tp].bpm;
                for (let p = 0; p < d; p++) {
                    const ms = t0 + (t1 - t0) * p / d;
                    out.push({ ms: ms + shiftAt(ms), weight: slotWeight(p, d), pos: (i - b.first) * d + p });
                }
            }
            return out;
        };
        const strength = ms => around(a.hits, ms / 10, 2);

        // where the drums usually hit in each section (per position in the bar)
        const usual = new Map();
        for (const b of bars) {
            const s = sectionAt(b.from);
            if (!divFor.has(s))
                continue;
            const map = usual.get(s) || new Map();
            for (const slot of slotsOf(b))
                map.set(slot.pos, (map.get(slot.pos) || 0) + strength(slot.ms) / Math.max(1, s.bars));
            usual.set(s, map);
        }

        const avoid = opts.avoid || [];
        const out = [];
        let carry = 0;
        inRange.forEach((b, j) => {
            const s = sectionAt(b.from);
            const slots = slotsOf(b).filter(x => x.ms >= startMs && x.ms <= endMs);
            const exact = want[j] + carry;
            let k = Math.min(slots.length, Math.max(0, Math.round(exact)));
            carry = exact - k;
            if (!k || !slots.length)
                return;
            const minGap = slots.length > 1 ? (slots[1].ms - slots[0].ms) * 0.8 : 30;
            const pattern = usual.get(s) || new Map();
            const picked = k >= slots.length * 0.85 ? slots
                : slots.map(x => ({ ...x, score: x.weight * (0.2 + 0.55 * strength(x.ms) + 0.45 * (pattern.get(x.pos) || 0)) }))
                    .sort((p, q) => q.score - p.score).slice(0, k);
            for (const x of picked)
                if (avoid.every(t => Math.abs(t - x.ms) >= minGap))
                    out.push(Math.round(x.ms));
        });
        return [...new Set(out)].sort((p, q) => p - q);
    }

    // No beat to follow (the tempo drifts and the map has no timing points): the drum hits themselves, then even
    // steps between them where it's busy
    function chooseTimesFree(a, opts, nps) {
        const { startMs, endMs } = opts;
        const WINDOW = 2000;
        const lv = smooth(a.hits, 150);
        const r = rank(lv);
        const out = [];
        for (let w = startMs; w < endMs; w += WINDOW) {
            const to = Math.min(endMs, w + WINDOW);
            const level = r[Math.min(a.frames - 1, Math.round((w + to) / 20))] || 0;
            let want = Math.round(nps * (0.3 + 1.4 * Math.pow(level, 1.5)) * (to - w) / 1000);
            if (opts.count > 0)
                want = Math.round(opts.count * (to - w) / (endMs - startMs));
            const minGap = Math.max(25, (to - w) / Math.max(1, want) * 0.55);
            const taken = [];
            const cands = [];
            for (let f = Math.max(1, Math.floor(w / 10)); f < Math.min(a.frames - 1, to / 10); f++)
                if (a.hits[f] > 0.08 && a.hits[f] >= a.hits[f - 1] && a.hits[f] >= a.hits[f + 1])
                    cands.push({ ms: f * 10, score: a.hits[f] });
            for (const c of cands.sort((p, q) => q.score - p.score)) {
                if (taken.length >= want)
                    break;
                if (taken.every(t => Math.abs(t - c.ms) >= minGap) && out.every(t => Math.abs(t - c.ms) >= minGap || t < c.ms - 500))
                    taken.push(c.ms);
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
        const J = opts.jump; // the average move (in cells) wanted here
        const vmax = opts.vmax; // the fastest a single move should make the cursor go (cells per second)
        const candidates = [];

        const consider = (e, k, i, ox, oy) => {
            // copy e[i + 1 ...] after e[i], which lands on prev
            const f = SYM[k];
            const len = Math.min(gaps.length, e.n - i - 1, opts.quantum ? Infinity : e.wholeUntil[i + 1] - i - 1);
            if (len < Math.min(3, gaps.length))
                return;
            let cost = 0, used_len = 0, dist = 0, time = 0, jacks = 0, spins = 0, spikes = 0;
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
                const move = Math.hypot(e.x[i + q + 1] - e.x[i + q], e.y[i + q + 1] - e.y[i + q]);
                dist += move;
                if (move > Math.max(1.5, 2.1 * J) || move / Math.max(gg, 1) * 1000 > vmax)
                    spikes++;
                time += Math.max(gl, 1);
                used_len++;
            }
            if (used_len < Math.min(opts.loose ? 1 : 3, gaps.length))
                return;
            cost /= used_len + 1;
            cost += 1.2 * jacks / used_len + 0.8 * spins / used_len;
            // steady difficulty: moves about as big as wanted here, without sudden far jumps
            cost += 1.2 * Math.abs(Math.log((dist / used_len + 0.15) / (J + 0.15))) + 1.5 * spikes / used_len;
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

    // Places notes at `times` by copying runs from the library. jumpAt(ms): the average move wanted there.
    function place(times, lib, opts, jumpAt) {
        const out = [];
        const before = (opts.before || []).slice(-2);
        let prev = before.length ? before[before.length - 1] : null;
        let prev2 = before.length > 1 ? before[0] : null;
        if (prev && !opts.quantum && (!isWhole(prev.x) || !isWhole(prev.y)))
            prev = { x: Math.min(2, Math.max(0, Math.round(prev.x))), y: Math.min(2, Math.max(0, Math.round(prev.y))), ms: prev.ms };
        const used = new Map();
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
            const ropts = { quantum: !!opts.quantum, jump: jumpAt(times[i]), vmax: opts.vmax };
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

    // How unbalanced or awkward a generated map is (lower is better): moves drifting away from what's wanted where they
    // are, sudden far jumps, notes on the same spot twice and little 2x2 circles
    function badness(notes, jumpAt, vmax = Infinity) {
        const n = notes.length;
        if (n < 2)
            return 0;
        let drift = 0, spikes = 0, jacks = 0, spins = 0;
        const moves = [];
        for (let i = 1; i < n; i++) {
            const a = notes[i - 1], b = notes[i];
            const d = Math.hypot(b.x - a.x, b.y - a.y);
            const J = jumpAt(b.ms);
            moves.push(d);
            if (moves.length > 8)
                moves.shift();
            const avg = moves.reduce((p, q) => p + q, 0) / moves.length;
            drift += Math.log((avg + 0.15) / (J + 0.15)) ** 2;
            if (d > Math.max(1.5, 2.2 * J) || d / Math.max(1, b.ms - a.ms) * 1000 > vmax * 1.1)
                spikes++;
            if (d < 1e-3)
                jacks++;
            if (i >= 3) {
                const w = notes.slice(i - 3, i + 1);
                const xs = w.map(v => v.x), ys = w.map(v => v.y);
                if (Math.max(...xs) - Math.min(...xs) <= 1.001 && Math.max(...ys) - Math.min(...ys) <= 1.001
                    && new Set(w.map(v => `${v.x},${v.y}`)).size === 4)
                    spins++;
            }
        }
        return 3 * drift / n + 4 * spikes / n + 5 * jacks / n + 4 * spins / n;
    }

    // swing for a given beat (period/phase in frames): are the hits between beats on thirds rather than quarters?
    function isSwung(hits, period, phase) {
        let thirds = 0, quarters = 0;
        for (let t = phase; t < hits.length - period; t += period) {
            thirds += around(hits, t + period / 3, 1) + around(hits, t + 2 * period / 3, 1);
            quarters += around(hits, t + period / 4, 1) + around(hits, t + 3 * period / 4, 1);
        }
        return thirds > quarters * 1.25;
    }

    const TRIES = 5;

    // opts: { buffer (AudioBuffer), startMs, endMs, difficulty (1..10), density (1 = normal), count (0 = by difficulty),
    //         quantum (allow notes off the 3x3 grid), timing ([{ bpm, ms }] from the map, if it has any),
    //         before (the notes just before startMs), styleNotes (the map's own notes: their patterns are preferred),
    //         avoid (times already taken), progress (text => void) }
    // Resolves to the notes, with .info = { bpm, offsetMs, steady (when the BPM was detected), sections }.
    async function generate(opts) {
        await load();
        const progress = opts.progress || (() => { });
        const tick = () => new Promise(r => setTimeout(r));
        const a = await analyse(opts.buffer, progress);
        const difficulty = Math.min(10, Math.max(1, opts.difficulty || 5));
        // 1 = ~1.5 notes a second on average, 5 = ~5.5, 10 = ~30 (Tasukete streams)
        const nps = 1.5 * Math.pow(20, (difficulty - 1) / 9) * (opts.density || 1);

        progress('STUDYING THE SECTIONS AND DROPS');
        await tick();
        const ctx = {};
        let detected = null;
        if (opts.timing && opts.timing.length) {
            ctx.timing = opts.timing;
            ctx.triplet = isSwung(a.hits, 6000 / opts.timing[0].bpm, opts.timing[0].ms / 10);
        } else if (a.tempo) {
            detected = a.tempo;
            ctx.timing = [{ bpm: a.tempo.bpm, ms: a.tempo.offsetMs }];
            ctx.triplet = a.tempo.triplet;
            ctx.shifts = a.tempo.steady ? null : a.tempo.shifts;
        }
        const times = ctx.timing ? chooseTimes(a, opts, nps, ctx) : chooseTimesFree(a, opts, nps);
        if (!times.length)
            return Object.assign([], { info: { bpm: detected && detected.bpm, offsetMs: detected && detected.offsetMs, steady: !!(detected && detected.steady) } });

        // how big the moves should be: bigger with difficulty, and in intense sections and drops
        const sections = ctx.sections || [];
        const base = 0.85 + 0.07 * difficulty;
        const free = rank(smooth(a.hits, 150));
        const jumpAt = ms => {
            const s = sections.find(x => ms >= x.from && ms < x.to);
            const level = s ? s.level : free[Math.min(a.frames - 1, Math.max(0, Math.round(ms / 10)))] || 0.5;
            return base * (0.8 + 0.4 * level + (s && s.drop ? 0.1 : 0));
        };

        // what to copy from: the learned maps, the map being made (preferred), or built-in patterns
        const entries = model.maps.slice();
        const style = (opts.styleNotes || []).filter(n => n.ms < opts.startMs || n.ms > opts.endMs);
        if (style.length >= 12) {
            const own = toEntry(style, 'this map');
            own.bonus = 0.12;
            entries.push(own);
        }
        let lib = prepare(entries, !!opts.quantum);
        if (!lib.length)
            lib = prepare([defaultEntry()], !!opts.quantum);

        // how fast one move may make the cursor go: comfortable for the difficulty (about 12 cells a second at 5)
        const vmax = 4 * Math.pow(1.33, difficulty - 1);

        // map it a few times and keep the most balanced
        let best = null;
        for (let t = 0; t < TRIES; t++) {
            progress(`MAPPING (TRY ${t + 1} OF ${TRIES})`);
            await tick();
            const notes = place(times, lib, { ...opts, vmax }, jumpAt);
            const score = badness(notes, jumpAt, vmax);
            if (!best || score < best.score)
                best = { notes, score };
        }
        best.notes.info = {
            bpm: detected && detected.bpm, offsetMs: detected && detected.offsetMs, steady: !!(detected && detected.steady),
            sections: sections.map(s => ({ from: s.from, to: s.to, level: +s.level.toFixed(2), drop: s.drop })),
        };
        return best.notes;
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
    return { learn, learnFiles, stats, statsSync, reset, generate, analyse, findTempo };
})();
