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
        let prevLh = new Float32Array(B + 1), lh = new Float32Array(B + 1);
        let prevLa = new Float32Array(B + 1), la = new Float32Array(B + 1);
        const melodyRaw = new Float32Array(frames), allRaw = new Float32Array(frames), bassRaw = new Float32Array(frames);
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
                // on a scale where 1 is a full-volume sine, so near-silent noise stays near 0 after the log below
                for (let k = 1; k <= B; k++)
                    mag[k] = Math.hypot(re[k], im[k]) / (N / 4);
            }
            const g = f - HALF;
            if (g < 0)
                continue;
            const cur = ring[g % T];
            const from = Math.max(0, g - HALF), to = Math.min(frames - 1, g + HALF);
            let l = 0, m = 0, h = 0, harm = 0, mel = 0, all = 0, bass = 0, lc = 0, mc = 0, hc = 0;
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
                lh[k] = Math.log1p(100 * cur[k] * (1 - mask));
                la[k] = Math.log1p(100 * cur[k]);
                harm += cur[k] * (1 - mask);
                if (lh[k] > prevLh[k]) {
                    if (k >= lowEnd)
                        mel += lh[k] - prevLh[k];
                    else
                        bass += lh[k] - prevLh[k];
                }
                if (la[k] > prevLa[k])
                    all += la[k] - prevLa[k];
                const d = lp[k] - prevLp[k];
                if (d > 0) {
                    // also how many frequencies jump at once: a drum hits most of its range, a wobbling voice a few
                    const wide = d > 0.25 ? 1 : 0;
                    if (k < lowEnd) {
                        l += d;
                        lc += wide;
                    } else if (k < midEnd) {
                        m += d;
                        mc += wide;
                    } else {
                        h += d;
                        hc += wide;
                    }
                }
            }
            if (g) {
                // per frequency, weighted by how much of the band jumped together
                low[g] = l / (lowEnd - 1) * (0.4 + 0.6 * lc / (lowEnd - 1));
                mid[g] = m / (midEnd - lowEnd) * Math.min(1, 2.5 * mc / (midEnd - lowEnd));
                high[g] = h / (B + 1 - midEnd) * Math.min(1, 2.5 * hc / (B + 1 - midEnd));
            }
            harmonic[g] = harm;
            if (g) {
                melodyRaw[g] = mel / (B + 1 - lowEnd);
                allRaw[g] = all / B;
                bassRaw[g] = bass / (lowEnd - 1);
            }
            [prevLp, lp] = [lp, prevLp];
            [prevLh, lh] = [lh, prevLh];
            [prevLa, la] = [la, prevLa];
            if (g % 400 === 399) {
                progress(`LISTENING TO THE SONG ${Math.round(g / frames * 100)}%`);
                await new Promise(r => setTimeout(r));
            }
        }

        // how loud each kind of sound is compared to the others (a song without hi-hats shouldn't get hi-hat notes
        // from noise that was scaled up)
        const rawPeak = {
            kick: percentile(low, 0.98), snare: percentile(mid, 0.98), hat: percentile(high, 0.98),
            melody: percentile(melodyRaw, 0.98), bass: percentile(bassRaw, 0.98),
        };
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
        const tempo = await findTempo(beats, hits, frames);

        // for "sync to": melody onsets (notes of vocals and instruments starting) and everything together
        const melody = peaky(melodyRaw);
        const everything = peaky(allRaw);

        const bassline = peaky(bassRaw);
        const sources = { kick: peaky(low), snare: peaky(mid), hat: peaky(high), melody, bass: bassline };
        const loudest = Math.max(...Object.values(rawPeak), 1e-9);
        const sourceLevel = {};
        for (const k in rawPeak)
            sourceLevel[k] = Math.min(1, rawPeak[k] / loudest);

        // how loud the song is around each moment compared to its loud parts (0..1): a soft passage's drums count less
        const db = smooth(rms.map(v => 20 * Math.log10(v + 1e-6)), 25);
        const loudRef = percentile(db, 0.95);
        const loudness = db.map(v => Math.min(1, Math.max(0, (v - (loudRef - 30)) / 24)));

        const result = { frames, hits, beats, low, rms, harmonic, melody, everything, sources, sourceLevel, loudness, tempo };
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
    async function findTempo(beats, hits, frames) {
        if (frames < 1500)
            return null;
        // it's a lot of work on a long song: the page gets a moment between the steps so it doesn't freeze
        let lastYield = performance.now();
        const breathe = async () => {
            if (performance.now() - lastYield > 25) {
                await new Promise(r => setTimeout(r));
                lastYield = performance.now();
            }
        };
        const mean = beats.reduce((a, b) => a + b, 0) / frames || 1e-6;

        // candidates from the autocorrelation of the drums
        const ac = [];
        for (let lag = 20; lag <= 140; lag++) {
            let s = 0;
            for (let i = 0; i + lag < frames; i += 2)
                s += hits[i] * hits[i + lag];
            ac[lag] = s;
            await breathe();
        }
        const peaks = [];
        for (let lag = 21; lag < 140; lag++)
            if (ac[lag] >= ac[lag - 1] && ac[lag] >= ac[lag + 1])
                peaks.push(lag);
        peaks.sort((a, b) => ac[b] - ac[a]);
        const candidates = [];
        for (const lag of peaks.slice(0, 6)) {
            // between whole frames: the top of a parabola through the peak and its neighbours
            const y0 = ac[lag - 1], y1 = ac[lag], y2 = ac[lag + 1];
            const d = y0 - 2 * y1 + y2;
            const exact = lag + (d ? 0.5 * (y0 - y2) / d : 0);
            for (const r of [1, 2, 0.5, 1.5, 2 / 3, 4 / 3, 0.75]) {
                const bpm = 6000 / exact * r;
                if (bpm >= 85 && bpm <= 280 && !candidates.some(c => Math.abs(c / bpm - 1) < 0.012))
                    candidates.push(bpm);
            }
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
            await breathe();
            let top = null;
            for (let bpm = c * 0.984; bpm <= c * 1.016; bpm += 0.01) {
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
            await breathe();
            const f = fullScore(t.bpm);
            const score = (f.onBeats + 0.5 * f.half) * (0.55 + 0.45 * prior(t.bpm));
            if (!best || score > best.score)
                best = { bpm: t.bpm, phase: f.phase, score, onBeats: f.onBeats };
        }
        if (!best)
            return null;

        // 3) fine: 0.002 BPM steps
        await breathe();
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
        await breathe();
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
        // (quiet stretches can't tell where the beat is, so a few windows off don't count against it)
        const steady = shifts.filter(s => Math.abs(s) <= 2).length >= shifts.length * 0.7;

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
        // drum hits per second matter most (how much rhythm is going on), then their strength and the loudness
        if (!a.drumEvents)
            a.drumEvents = findEvents(a, DEFAULT_SOURCES, 0.5, 0, a.frames * 10);
        const ev = a.drumEvents;
        let e = 0;
        const feat = bars.map(b => {
            const f0 = Math.max(0, Math.floor(b.from / 10)), f1 = Math.min(a.frames, Math.max(f0 + 1, Math.floor(b.to / 10)));
            let loud = 0, hits = 0, kick = 0;
            for (let f = f0; f < f1; f++) {
                loud += Math.log10(a.rms[f] + 1e-4);
                hits += a.hits[f];
                kick += a.low[f];
            }
            while (e < ev.length && ev[e].ms < b.from)
                e++;
            let count = 0;
            for (let j = e; j < ev.length && ev[j].ms < b.to; j++)
                count += Math.min(1, ev[j].strength);
            const c = f1 - f0;
            return [loud / c, hits / c, kick / c, count / Math.max(0.1, (b.to - b.from) / 1000)];
        });
        const R = [0, 1, 2, 3].map(j => rank(feat.map(v => v[j])));
        const v = bars.map((_, i) => 0.2 * R[0][i] + 0.2 * R[1][i] + 0.1 * R[2][i] + 0.5 * R[3][i]);

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

    // ------------------------------------------------ what to put notes on

    // the kinds of sound notes can sync to, and how much each counts when there's more than the difficulty allows
    const SOURCE_WEIGHT = { kick: 1, snare: 1, hat: 0.55, melody: 0.75, bass: 0.7 };
    const DEFAULT_SOURCES = ['kick', 'snare', 'hat'];

    // The sounds worth a note: moments where one of the chosen kinds of sound starts, loud enough to count
    // (sensitivity 0..1) and standing out from what's around it. Silence and held sounds (pads, long vocal notes)
    // don't start anything, so they get nothing. [{ ms, strength, kinds }] in time order.
    function findEvents(a, sources, sensitivity, fromMs, toMs) {
        const thr = 0.34 - 0.3 * sensitivity;
        const f0 = Math.max(2, Math.floor(fromMs / 10) - 1), f1 = Math.min(a.frames - 2, Math.ceil(toMs / 10) + 1);
        const raw = [];
        for (const kind of sources) {
            const env = a.sources[kind];
            if (!env)
                continue;
            // a kind of sound the song (nearly) doesn't have: its envelope is only scaled-up noise
            if (a.sourceLevel[kind] < 0.01)
                continue;
            const weight = SOURCE_WEIGHT[kind];
            const base = smooth(env, 40);
            // low sounds ring longer: their echoes are ignored for longer
            // low sounds ring longer, and a sung note wobbles (vibrato): their echoes are ignored for longer
            const low = kind === 'kick' || kind === 'bass' || kind === 'melody';
            const tail = low ? 14 : 8;
            let lastF = -1e9, lastV = 0;
            for (let f = f0; f < f1; f++) {
                const v = env[f] * (0.3 + 0.7 * a.loudness[f]);
                if (v < thr || env[f] < base[f] * 1.4)
                    continue;
                if (env[f] < env[f - 1] || env[f] < env[f + 1] || env[f] < env[f - 2] || env[f] <= env[f + 2])
                    continue;
                // not just a bump in the tail of the sound before it
                let before = 0;
                for (let k = Math.max(0, f - tail); k < f - 1; k++)
                    before = Math.max(before, env[k]);
                if (env[f] < before * 0.5)
                    continue;
                // the same sound again: right after a hit (a kick's pitch falling sets the lowest frequencies off a
                // second time), or a clearly weaker one shortly after
                const since = f - lastF;
                if (low ? since < 9 || (since < 25 && v < lastV * 0.7) : since < 4 || (since < 10 && v < lastV * 0.4))
                    continue;
                lastF = f;
                lastV = v;
                // between frames: the top of a parabola through the peak and its neighbours
                const y0 = env[f - 1], y1 = env[f], y2 = env[f + 1], dd = y0 - 2 * y1 + y2;
                const frac = dd < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (y0 - y2) / dd)) : 0;
                raw.push({ ms: (f + frac) * 10, strength: Math.min(1.5, v) * weight, kinds: [kind] });
            }
        }
        raw.sort((p, q) => p.ms - q.ms);
        // one moment heard in several kinds of sound (a kick and a crash together) is one stronger event
        const out = [];
        for (const e of raw) {
            const last = out[out.length - 1];
            if (last && e.ms - last.ms <= 25) {
                if (e.strength > last.strength)
                    last.ms = e.ms;
                last.strength = Math.max(last.strength, e.strength) + 0.2 * Math.min(last.strength, e.strength);
                last.kinds.push(...e.kinds);
            } else
                out.push(e);
        }
        return out.filter(e => e.ms >= fromMs && e.ms <= toMs);
    }

    // Picks the note times. Notes go on sounds the song actually makes (the chosen kinds of sound), lined up on the
    // beat; where there's nothing, there are no notes. The difficulty sets how many of them may get a note: each
    // section of the song is allowed more or fewer (intense parts and drops more), and when there are more sounds than
    // that, the strongest and most on-beat ones win. Streams are only filled in between sounds where the song itself
    // is busy (Fill Streams).
    function chooseTimes(a, opts, nps, ctx) {
        const { startMs, endMs } = opts;
        const songMs = a.frames * 10;
        const beats = beatTimes(ctx.timing, 0, songMs);
        // bars of 4 beats, counted from the timing point
        const bars = [];
        for (let i = 0; i < beats.length; i++) {
            if (((beats[i].index % 4) + 4) % 4 !== 0 && bars.length)
                continue;
            const next = beats.slice(i + 1, i + 9).find(b => ((b.index % 4) + 4) % 4 === 0 || b.tp !== beats[i].tp);
            bars.push({ from: beats[i].ms, to: next ? next.ms : Math.min(songMs, beats[i].ms + 4 * 60000 / ctx.timing[beats[i].tp].bpm), first: i });
        }
        const sections = findSections(a, bars);
        ctx.sections = sections;

        // how many notes each section may have, averaging `nps` over the whole song
        const boost = opts.dropBoost ?? 1;
        // Calm Parts (0..1): how much the calm sections (intros, breakdowns) get compared to the intense ones
        const floor = 0.04 + 0.5 * (opts.calm ?? 0.3);
        const shape = s => (floor + (1.9 - floor) * Math.pow(s.level, 1 + 0.5 * boost)) * (s.drop ? 1 + 0.15 * boost : 1);
        const total = sections.reduce((t, s) => t + shape(s) * (s.to - s.from), 0) || 1;
        const span = sections.reduce((t, s) => t + (s.to - s.from), 0) || 1;
        sections.forEach(s => s.nps = nps * shape(s) * span / total);
        // Where the music carries on just as busy (about as many drum hits a second), the notes carry on too: next
        // to each other, two such sections can't differ much in how many notes they get, however their loudness
        // changes (a build-up into a drop, or a drop that's split in two). Real changes (a breakdown, the drop
        // kicking in) still change as much as the music does.
        const ev = a.drumEvents || [];
        for (const sec of sections) {
            let w = 0;
            for (const e of ev)
                if (e.ms >= sec.from && e.ms < sec.to)
                    w += Math.min(1, e.strength);
            sec.rate = w / Math.max(0.5, (sec.to - sec.from) / 1000);
        }
        for (let pass = 0; pass < 3; pass++)
            for (let i = 0; i + 1 < sections.length; i++) {
                const p = sections[i], q = sections[i + 1];
                const same = Math.min(p.rate, q.rate) / Math.max(p.rate, q.rate, 1e-6);
                const allowed = 1.25 + 4 * Math.max(0, 0.85 - same);
                const [lo, hi] = p.nps < q.nps ? [p, q] : [q, p];
                if (hi.nps > lo.nps * allowed)
                    lo.nps = hi.nps / allowed;
            }
        // (still averaging `nps` over the song)
        const now = sections.reduce((t, s) => t + s.nps * (s.to - s.from), 0) / span;
        if (now > 0)
            sections.forEach(s => s.nps *= nps / now);
        const sectionAt = ms => sections.find(s => ms >= s.from && ms < s.to) || sections[sections.length - 1];

        const inRange = bars.filter(b => b.to > startMs && b.from < endMs);
        // inside a section, a bar with more going on than usual there (a drum roll into a drop) gets a few more
        // notes and a bar with less a few fewer; the section's total stays the same
        let e1 = 0;
        const barRate = bar => {
            while (e1 < ev.length && ev[e1].ms < bar.from)
                e1++;
            let w = 0;
            for (let q = e1; q < ev.length && ev[q].ms < bar.to; q++)
                w += Math.min(1, ev[q].strength);
            return w / Math.max(0.2, (bar.to - bar.from) / 1000);
        };
        let cap = inRange.map(b => {
            const part = (Math.min(b.to, endMs) - Math.max(b.from, startMs)) / (b.to - b.from);
            const sec = sectionAt(b.from);
            const act = sec.rate > 0 ? Math.max(0.6, Math.min(1.5, 0.6 + 0.4 * barRate(b) / sec.rate)) : 1;
            return { sec, w: sec.nps * (b.to - b.from) / 1000 * part, act };
        });
        {
            const plain = new Map(), weighted = new Map();
            for (const c of cap) {
                plain.set(c.sec, (plain.get(c.sec) || 0) + c.w);
                weighted.set(c.sec, (weighted.get(c.sec) || 0) + c.w * c.act);
            }
            cap = cap.map(c => c.w * c.act * plain.get(c.sec) / (weighted.get(c.sec) || 1));
        }
        if (opts.count > 0) {
            const sum = cap.reduce((p, q) => p + q, 0) || 1;
            cap = cap.map(w => w * opts.count / sum);
        }

        const shiftAt = ms => {
            if (!ctx.shifts)
                return 0;
            const i = Math.min(ctx.shifts.length - 1, Math.max(0, Math.floor(ms / 15000)));
            return ctx.shifts[i] * 10;
        };
        const beatAt = ms => {
            let lo = 0, hi = beats.length - 1;
            while (hi - lo > 1) {
                const m = (lo + hi) >> 1;
                if (beats[m].ms <= ms)
                    lo = m;
                else
                    hi = m;
            }
            return lo;
        };
        // where a time falls on the beat divided into `div`: the nearest position, how far off that is and how much
        // a note there counts
        const gridAt = (ms, div) => {
            const i = beatAt(ms - shiftAt(ms));
            const t0 = beats[i].ms + shiftAt(beats[i].ms);
            const len = i + 1 < beats.length ? beats[i + 1].ms - beats[i].ms : 60000 / ctx.timing[beats[i].tp].bpm;
            const step = len / div;
            const p = Math.round((ms - t0) / step);
            const at = t0 + p * step;
            return { at, err: Math.abs(at - ms), step, weight: slotWeight(((p % div) + div) % div, div) };
        };
        // how close together notes may come at this difficulty: the fastest stretches get about 2.6x the average
        // notes a second, up to a top speed that rises with the difficulty (about 21 notes a second at 5, 42 at 10:
        // 1/16 streams at 130 BPM)
        const level10 = Math.min(10, Math.max(1, opts.difficulty || 5));
        const hard = level10 >= 8;
        const span_s = Math.max(1, (endMs - startMs) / 1000);
        const peak = 12 * Math.pow(1.15, level10 - 1) * Math.max(1, opts.density || 1);
        const busiest = Math.min(peak, (opts.count > 0 ? Math.max(opts.count / span_s, 0.5) : nps) * 2.6);
        const fastest = 1000 / busiest;
        // the finest beat division allowed at a tempo: 1/1 or 1/2 for easy maps up to 1/16 for the hardest
        const topDiv = (family, beatLen) => {
            let top = family[0];
            for (const d of family)
                if (beatLen / d >= fastest * 0.95)
                    top = d;
            return top;
        };
        // a sound counts as on a position when it's within a quarter of a step of it: at least 12ms (how precisely a
        // sound's start can be heard in the song) and at most 20ms
        const tolerance = step => Math.min(20, Math.max(12, 0.25 * step));
        const finer = (family, d) => family[Math.min(family.length - 1, family.indexOf(d) + 1)];

        const sources = opts.sources && opts.sources.length ? opts.sources : DEFAULT_SOURCES;
        const events = findEvents(a, sources, opts.sensitivity ?? 0.5, startMs - 200, endMs + 200);

        const fill = opts.fill || 'intense';
        const avoid = opts.avoid || [];
        let out = [];
        let heard = new Map(); // note time on the grid -> when its sound is heard

        // maps every bar; scale: section -> how much of its note allowance to use
        const mapBars = scale => {
        out = [];
        heard = new Map();
        let carry = 0;
        inRange.forEach((b, j) => {
            const s = sectionAt(b.from);
            const beatLen = 60000 / ctx.timing[beats[b.first].tp].bpm;
            const beatsIn = Math.max(1, Math.round((b.to - b.from) / beatLen));
            const raw = events.filter(e => e.ms >= b.from - 20 && e.ms < b.to - 20);

            // One beat division for the whole bar: the simplest one (straight 1/1, 1/2, 1/4... or triplet 1/3,
            // 1/6...) that the bar's sounds sit on, but no finer than the difficulty allows. Every note in the bar,
            // streams included, goes on it, so straight and triplet positions never mix and a stream stays even.
            const fit = family => {
                const top = topDiv(family, beatLen);
                const total = raw.reduce((t, e) => t + e.strength, 0);
                let share = 0;
                for (const div of family) {
                    if (div > top)
                        break;
                    let on = 0;
                    for (const e of raw) {
                        const g = gridAt(e.ms, div);
                        if (g.err <= tolerance(g.step))
                            on += e.strength;
                    }
                    share = total ? on / total : 1;
                    if (share >= 0.85)
                        return { family, div, full: true, share };
                }
                return { family, div: top, full: false, share };
            };
            const main = fit(ctx.triplet ? SWUNG : STRAIGHT), other = fit(ctx.triplet ? STRAIGHT : SWUNG);
            const grid = (other.full && (!main.full || other.div < main.div)) ? other : main;
            const { family, div } = grid;

            const exact = cap[j] * (scale.get(s) ?? 1) + carry;
            // never more notes than the bar has positions at the finest division allowed
            const k = Math.max(0, Math.min(Math.round(exact), beatsIn * topDiv(family, beatLen)));
            // how close notes may be: the beat division this many notes needs
            const d = Math.min(topDiv(family, beatLen), family.find(d => d >= k / beatsIn * 1.05) || family[family.length - 1]);
            const minGap = beatLen / Math.max(d, 1) * 0.85;
            const ok = ms => ms >= startMs && ms <= endMs && avoid.every(t => Math.abs(t - ms) >= minGap);

            // sounds that aren't on the bar's division (a flam, a grace note, an off-beat sound at an easy
            // difficulty) are left out rather than moved a long way from where they're heard
            const here = raw.map(e => {
                const g = gridAt(e.ms, div);
                return g.err <= Math.max(tolerance(g.step), Math.min(25, 0.5 * g.step))
                    ? { ms: Math.round(g.at), src: e.ms, score: e.strength * (0.55 + 0.45 * g.weight) } : null;
            }).filter(e => e && ok(e.ms));
            const picked = [];
            for (const e of here.sort((p, q) => q.score - p.score)) {
                if (picked.length >= k)
                    break;
                if (picked.every(t => Math.abs(t - e.ms) >= minGap)) {
                    picked.push(e.ms);
                    heard.set(e.ms, e.src);
                }
            }
            picked.sort((p, q) => p - q);

            // streams between the sounds, only where the song itself is busy (two sounds a beat or more), and at
            // most one division finer than the bar's own rhythm (two at difficulty 8 and up), within the
            // difficulty's top speed. Hard maps fill the busy medium parts too, not only the drops.
            const busy = raw.length >= beatsIn * 2;
            const intense = s.level >= 0.6 || s.drop || (hard && s.level >= 0.3);
            if (picked.length < k && busy && (fill === 'busy' || (fill === 'intense' && intense))) {
                const fillDiv = Math.min(topDiv(family, beatLen), hard ? finer(family, finer(family, div)) : finer(family, div), Math.max(div, d));
                const step = beatLen / fillDiv;
                const extra = [];
                for (let i = 0; i + 1 < picked.length && picked.length + extra.length < k; i++) {
                    const p0 = picked[i], p1 = picked[i + 1];
                    if (p1 - p0 > beatLen * 1.01)
                        continue;
                    for (let t = p0 + step; t < p1 - step * 0.5 && picked.length + extra.length < k; t += step) {
                        const ms = Math.round(gridAt(t, fillDiv).at);
                        if (ok(ms) && ms - p0 >= Math.min(minGap, step) * 0.9 && p1 - ms >= step * 0.5)
                            extra.push(ms);
                    }
                }
                picked.push(...extra);
            }
            carry = Math.min(2, Math.max(-2, exact - picked.length));
            out.push(...picked);
        });
        };
        mapBars(new Map());

        // A drop is never easier than the calmer parts: a section that came out with more notes a second than a
        // more intense one (its sounds or rhythm let it fill up more) is mapped again with fewer
        const inSection = sec => {
            const from = Math.max(sec.from, startMs), to = Math.min(sec.to, endMs);
            return to - from >= 2000 ? { n: out.filter(t => t >= from && t < to).length / ((to - from) / 1000) } : null;
        };
        const rates = new Map(sections.map(sec => [sec, inSection(sec)]));
        const scale = new Map();
        for (const sec of sections) {
            const mine = rates.get(sec);
            if (!mine || !mine.n)
                continue;
            let allowed = Infinity;
            for (const other of sections) {
                const theirs = rates.get(other);
                if (theirs && other.level >= sec.level + 0.1)
                    allowed = Math.min(allowed, theirs.n * 0.95);
            }
            if (mine.n > allowed)
                scale.set(sec, allowed / mine.n);
        }
        if (scale.size)
            mapBars(scale);
        // Streams and other quick runs stay exactly on the grid, so they're perfectly even. A note on its own (no
        // other note within 200ms) goes exactly where its sound is heard: the sounds of a song never all sit on one
        // perfect grid, and on a slow note being late or early by even 15ms is easy to feel.
        const times = [...new Set(out)].sort((p, q) => p - q);
        return times.map((t, i) => {
            const src = heard.get(t);
            if (src === undefined || Math.abs(src - t) <= 4 || src < startMs || src > endMs)
                return t;
            const gap = Math.min(i ? t - times[i - 1] : Infinity, i + 1 < times.length ? times[i + 1] - t : Infinity);
            return gap >= 200 ? Math.round(src) : t;
        });
    }

    // No beat to follow (the tempo drifts and the map has no timing points): the sounds themselves, at most as many as
    // the difficulty allows per couple of seconds
    function chooseTimesFree(a, opts, nps) {
        const { startMs, endMs } = opts;
        const WINDOW = 2000;
        const sources = opts.sources && opts.sources.length ? opts.sources : DEFAULT_SOURCES;
        const events = findEvents(a, sources, opts.sensitivity ?? 0.5, startMs, endMs);
        const level = rank(smooth(a.hits, 150));
        const out = [];
        for (let w = startMs; w < endMs; w += WINDOW) {
            const to = Math.min(endMs, w + WINDOW);
            const lv = level[Math.min(a.frames - 1, Math.round((w + to) / 20))] || 0;
            let k = Math.round(nps * (0.3 + 1.4 * Math.pow(lv, 1.5)) * (to - w) / 1000);
            if (opts.count > 0)
                k = Math.round(opts.count * (to - w) / (endMs - startMs));
            const minGap = Math.max(30, (to - w) / Math.max(1, k) * 0.5);
            const taken = [];
            for (const e of events.filter(e => e.ms >= w && e.ms < to).sort((p, q) => q.strength - p.strength)) {
                if (taken.length >= k)
                    break;
                if (taken.every(t => Math.abs(t - e.ms) >= minGap) && out.every(t => Math.abs(t - e.ms) >= minGap || t < e.ms - 500))
                    taken.push(e.ms);
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

    // How many places in the library to try for each run of notes
    const SEARCH = 2400;

    // Finds the run of library notes to copy next.
    // gaps: the time from the previous note to each new note; prev/prev2: the last two notes placed
    function findRun(lib, gaps, prev, prev2, opts, used) {
        const bounds = opts.quantum ? QUANTUM : GRID;
        const J = opts.jump; // the average move (in cells) wanted here
        const vmax = opts.vmax; // the fastest a single move should make the cursor go (cells per second)
        const candidates = [];

        const flow = opts.flow ?? 0.7, follow = opts.follow ?? 0.75, variety = opts.variety ?? 0.5;
        const model = opts.flowModel;
        // how far apart the rhythm may be: a run is matched by the shape of its rhythm (which gaps are short and
        // which long) at any speed from 0.6x to 5x the original, with a small cost for playing it at another speed
        const relTol = opts.loose ? 3 : 0.3 + 0.35 * (1 - follow);
        const consider = (e, k, i, ox, oy) => {
            // copy e[i + 1 ...] after e[i], which lands on prev
            const f = SYM[k];
            const len = Math.min(gaps.length, e.n - i - 1, opts.quantum ? Infinity : e.wholeUntil[i + 1] - i - 1);
            if (len < Math.min(3, gaps.length))
                return;
            let cost = 0, used_len = 0, dist = 0, jacks = 0, spins = 0, spikes = 0, logSum = 0, rough = 0, roughN = 0;
            const recent = [prev2, prev].filter(Boolean).map(p => [p.x, p.y]);
            let lastGap = prev && prev2 ? prev.ms - prev2.ms : 0;
            for (let q = 0; q < len; q++) {
                const gl = e.t[i + q + 1] - e.t[i + q], gg = gaps[q];
                const r = Math.log((Math.min(gg, 1200) + 10) / (Math.min(gl, 1200) + 10));
                const dev = q ? Math.abs(r - logSum / q) : 0;
                if (dev > relTol && q > 0)
                    break;
                const [x, y] = f(e.x[i + q + 1], e.y[i + q + 1]);
                if (x + ox < bounds[0] - 1e-6 || x + ox > bounds[1] + 1e-6 || y + oy < bounds[0] - 1e-6 || y + oy > bounds[1] + 1e-6)
                    break;
                logSum += r;
                cost += dev;
                // notes on the same spot twice and little 2x2 circles are what make auto maps feel wrong
                const last = recent[recent.length - 1];
                if (last && Math.abs(last[0] - x - ox) < 1e-3 && Math.abs(last[1] - y - oy) < 1e-3)
                    jacks++;
                recent.push([x + ox, y + oy]);
                // how the cursor's velocity changes through here, at the new timing
                if (recent.length >= 3 && lastGap > 0) {
                    const [a, b, c] = recent.slice(-3);
                    rough += velocityChange({ x: a[0], y: a[1], ms: 0 }, { x: b[0], y: b[1], ms: lastGap }, { x: c[0], y: c[1], ms: lastGap + gg });
                    roughN++;
                }
                lastGap = gg;
                if (recent.length >= 4) {
                    const m = recent.length;
                    const w0 = recent[m - 4], w1 = recent[m - 3], w2 = recent[m - 2], w3 = recent[m - 1];
                    const x0 = Math.min(w0[0], w1[0], w2[0], w3[0]), x1 = Math.max(w0[0], w1[0], w2[0], w3[0]);
                    const y0 = Math.min(w0[1], w1[1], w2[1], w3[1]), y1 = Math.max(w0[1], w1[1], w2[1], w3[1]);
                    if (x1 - x0 <= 1.001 && y1 - y0 <= 1.001 && new Set([w0.join(','), w1.join(','), w2.join(','), w3.join(',')]).size === 4)
                        spins++;
                }
                const move = Math.hypot(e.x[i + q + 1] - e.x[i + q], e.y[i + q + 1] - e.y[i + q]);
                dist += move;
                if (move > Math.max(1.5, 2.1 * J) || move / Math.max(gg, 1) * 1000 > vmax)
                    spikes++;
                used_len++;
            }
            if (used_len < Math.min(opts.loose ? 1 : 3, gaps.length))
                return;
            // variety: the same shape as was just placed (going round the same loop again and again) gets dull
            if (opts.history && recent.length >= 6) {
                let seen = 0, total = 0;
                for (let j = 6; j <= recent.length; j++) {
                    total++;
                    if (opts.history.has(recent.slice(j - 6, j).map(v => v.join(',')).join(' ')))
                        seen++;
                }
                cost += (0.35 + 1.4 * variety) * seen / total;
            }
            const scale = logSum / used_len;
            if (!opts.loose && (scale > Math.log(5) || scale < Math.log(0.6)))
                return;
            cost = cost / used_len * 1.5 + 0.12 * Math.abs(scale) * (0.5 + follow);
            cost += 2.6 * jacks / used_len + 1.8 * spins / used_len;
            // Flow: no rougher than the learned maps (at 100%, a fair bit smoother)
            if (model && roughN)
                cost += 1.4 * flow * Math.max(0, rough / roughN - model.change * (1.2 - 0.45 * flow));
            // steady difficulty: moves about as big as wanted here, without sudden far jumps
            cost += 0.45 * Math.abs(Math.log((dist / used_len + 0.15) / (J + 0.15))) + 1.5 * spikes / used_len;
            // flow: carries on the way the map it comes from did before this point...
            const [fx, fy] = f(e.x[i + 1], e.y[i + 1]);
            if (prev2 && i > 0) {
                const [px, py] = f(e.x[i - 1], e.y[i - 1]);
                const [cx, cy] = f(e.x[i], e.y[i]);
                const v1 = [prev.x - prev2.x, prev.y - prev2.y], v2 = [cx - px, cy - py];
                const l1 = Math.hypot(...v1), l2 = Math.hypot(...v2);
                if (l1 > 1e-3 && l2 > 1e-3)
                    cost += (0.15 + 0.5 * flow) * (1 - (v1[0] * v2[0] + v1[1] * v2[1]) / (l1 * l2)) + (0.08 + 0.15 * flow) * Math.abs(Math.log(l1 / l2));
                else if ((l1 > 1e-3) !== (l2 > 1e-3))
                    cost += 0.3;
                // ...and the turn it makes here is one the learned maps make often at this move size
                if (model) {
                    const v3 = [fx + ox - prev.x, fy + oy - prev.y], l3 = Math.hypot(...v3);
                    if (l1 > 0.05 && l3 > 0.05)
                        cost += flow * 0.3 * model.turnCost(v1, v3, l3);
                }
            }
            cost += (0.15 + 0.4 * follow) * Math.hypot(ox, oy);
            const usedBefore = used.get(e);
            if (usedBefore && usedBefore.some(u => Math.abs(u - i) < 24))
                cost += 0.2 + 0.8 * variety;
            cost -= e.bonus || 0;
            cost -= 0.006 * used_len;
            candidates.push({ e, k, i, ox, oy, len: used_len, cost });
        };

        const sample = (list, max) => {
            if (list.length <= max)
                return list;
            const out = [];
            for (let s = 0; s < max; s++)
                out.push(list[Math.floor(Math.random() * list.length)]);
            return out;
        };

        // A fixed number of places to try per run however many maps were learned (it used to try every map, which with
        // a big library took minutes and froze the page). Each map gets a share by how much of it starts here; the
        // map being made always gets a good look.
        if (prev) {
            const pools = [];
            let total = 0;
            for (const e of lib)
                for (let k = 0; k < 8; k++) {
                    const [lx, ly] = SYM[INV[k]](prev.x, prev.y);
                    const list = e.at.get(posKey(lx, ly));
                    if (list) {
                        pools.push({ e, k, list });
                        total += list.length;
                    }
                }
            const share = Math.min(1, SEARCH / Math.max(1, total));
            for (const { e, k, list } of pools) {
                let take = list.length * share;
                take = e.bonus ? Math.max(take, Math.min(list.length, 260)) : Math.floor(take) + (Math.random() < take % 1 ? 1 : 0);
                for (const i of sample(list, take))
                    consider(e, k, i, 0, 0);
            }
            // nothing starts exactly here (a quantum note, or a spot the maps never use): shift a run over to it
            if (candidates.length < 6)
                for (let s = 0; s < Math.min(SEARCH, 120 * lib.length); s++) {
                    const e = lib[Math.floor(Math.random() * lib.length)];
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
            for (let s = 0; s < Math.min(SEARCH, 300 * lib.length); s++) {
                const e = lib[Math.floor(Math.random() * lib.length)];
                consider(e, Math.floor(Math.random() * 8), Math.floor(Math.random() * (e.n - 2)), 0, 0);
            }

        if (!candidates.length)
            return null;

        candidates.sort((p, q) => p.cost - q.cost);
        const top = candidates.slice(0, 3 + Math.round(variety * 7));
        const weights = top.map(c => Math.exp(-(c.cost - top[0].cost) / (0.03 + 0.08 * variety)));
        let r = Math.random() * weights.reduce((p, q) => p + q, 0);
        for (let j = 0; j < top.length; j++) {
            r -= weights[j];
            if (r <= 0)
                return top[j];
        }
        return top[0];
    }

    // How a player's cursor has to change velocity from one move to the next: 0 = straight on at the same speed,
    // 1 = a full reversal. It doesn't depend on the map's speed, so maps of any density compare.
    function velocityChange(a, b, c) {
        const t1 = Math.max(b.ms - a.ms, 1), t2 = Math.max(c.ms - b.ms, 1);
        const v1 = [(b.x - a.x) / t1, (b.y - a.y) / t1], v2 = [(c.x - b.x) / t2, (c.y - b.y) / t2];
        const s = Math.hypot(...v1) + Math.hypot(...v2);
        return s < 1e-9 ? 0 : Math.hypot(v2[0] - v1[0], v2[1] - v1[1]) / s;
    }

    // What the learned maps are like to play: how often they turn by each angle for each size of move, their usual
    // move size, and how smoothly the cursor travels through them
    function flowModel(lib) {
        const BINS = 12, SIZES = [0.8, 1.6, Infinity];
        const hist = SIZES.map(() => new Float64Array(BINS).fill(1));
        const moves = [];
        let change = 0, changes = 0;
        for (const e of lib) {
            const n = Math.min(e.n, Math.max(400, Math.floor(60000 / lib.length)));
            for (let i = 1; i + 1 < n; i++) {
                const ax = e.x[i] - e.x[i - 1], ay = e.y[i] - e.y[i - 1], bx = e.x[i + 1] - e.x[i], by = e.y[i + 1] - e.y[i];
                const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
                if (lb > 0.05)
                    moves.push(lb);
                if (la > 0.05 && lb > 0.05) {
                    const ang = Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb))));
                    hist[SIZES.findIndex(s => lb < s)][Math.min(BINS - 1, Math.floor(ang / Math.PI * BINS))]++;
                }
                change += velocityChange({ x: e.x[i - 1], y: e.y[i - 1], ms: e.t[i - 1] }, { x: e.x[i], y: e.y[i], ms: e.t[i] },
                    { x: e.x[i + 1], y: e.y[i + 1], ms: e.t[i + 1] });
                changes++;
            }
        }
        const logp = hist.map(h => {
            const total = h.reduce((p, q) => p + q, 0), max = Math.max(...h);
            return Array.from(h, v => Math.log(max / v) / Math.log(BINS));
        });
        moves.sort((p, q) => p - q);
        return {
            // 0 for the turn the maps make most at this move size, towards 1 (or more) for turns they never make
            turnCost(v1, v2, size) {
                const l1 = Math.hypot(...v1), l2 = Math.hypot(...v2);
                const ang = Math.acos(Math.max(-1, Math.min(1, (v1[0] * v2[0] + v1[1] * v2[1]) / (l1 * l2))));
                return logp[SIZES.findIndex(s => size < s)][Math.min(BINS - 1, Math.floor(ang / Math.PI * BINS))];
            },
            move: moves.length ? moves[Math.floor(moves.length / 2)] : 1,
            change: changes ? change / changes : 0.5,
        };
    }

    // Places notes at `times` by copying runs from the library. jumpAt(ms): the average move wanted there.
    async function place(times, lib, opts, jumpAt) {
        const out = [];
        const yieldNow = opts.yieldNow || (async () => { });
        const before = (opts.before || []).slice(-2);
        let prev = before.length ? before[before.length - 1] : null;
        let prev2 = before.length > 1 ? before[0] : null;
        if (prev && !opts.quantum && (!isWhole(prev.x) || !isWhole(prev.y)))
            prev = { x: Math.min(2, Math.max(0, Math.round(prev.x))), y: Math.min(2, Math.max(0, Math.round(prev.y))), ms: prev.ms };
        const used = new Map();
        const history = new Set();
        const remember = () => {
            history.clear();
            const tail = out.slice(-64).map(n => `${n.x},${n.y}`);
            for (let j = 6; j <= tail.length; j++)
                history.add(tail.slice(j - 6, j).join(' '));
        };
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
            await yieldNow(i / times.length);
            // a run of up to 12-24 notes (fewer joins, more of the original flow), ending at a long pause
            const L = 12 + Math.floor(Math.random() * 13);
            const gaps = [];
            for (let q = 0; q < L && i + q < times.length; q++) {
                const g = times[i + q] - (q === 0 ? (prev ? prev.ms : times[i] - 500) : times[i + q - 1]);
                if (q > 2 && g > 4 * gaps[q - 1] && g > 600)
                    break;
                gaps.push(g);
            }
            remember();
            const ropts = { ...opts.runOptions, quantum: !!opts.quantum, jump: jumpAt(times[i]), vmax: opts.vmax, history };
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
    function badness(notes, jumpAt, vmax = Infinity, model = null, flow = 0.7) {
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
        let feel = 0;
        if (model && n > 3) {
            // played through like a player would: how much rougher than the learned maps, overall and at its worst
            const ch = [];
            for (let i = 1; i + 1 < n; i++)
                ch.push(velocityChange(notes[i - 1], notes[i], notes[i + 1]));
            const mean = ch.reduce((p, q) => p + q, 0) / ch.length;
            let worst = 0;
            for (let i = 0; i + 16 <= ch.length; i += 4) {
                let s = 0;
                for (let k = i; k < i + 16; k++)
                    s += ch[k];
                worst = Math.max(worst, s / 16);
            }
            const target = model.change * (1.2 - 0.45 * flow);
            feel = 4 * Math.max(0, mean - target) + 2 * Math.max(0, worst - target * 1.4);
        }
        return 3 * drift / n + 4 * spikes / n + 8 * jacks / n + 6 * spins / n + flow * feel;
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

    const TRIES = 8;

    // opts: { buffer (AudioBuffer), startMs, endMs, difficulty (1..10), density (1 = normal), count (0 = by difficulty),
    //         flow (0..1: how smooth to keep the cursor's path), follow (0..1: how closely to stick to the learned maps),
    //         jumpScale (1 = like the maps), patterns ('mixed' | 'streams' | 'jumps'), dropBoost (0..2: how much harder
    //         intense parts and drops are), variety (0..1), sources (kinds of sound to sync to: 'kick', 'snare',
    //         'hat', 'melody', 'bass'), sensitivity (0..1: how quiet a sound can be and still get a note),
    //         fill ('never' | 'intense' | 'busy': where streams may be filled in between sounds),
    //         calm (0..1: how many notes calm parts like intros and breakdowns get),
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
        await tick();
        if (!times.length)
            return Object.assign([], { info: { bpm: detected && detected.bpm, offsetMs: detected && detected.offsetMs, steady: !!(detected && detected.steady) } });

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
        await tick();
        const fm = flowModel(lib);
        await tick();

        // how big the moves should be: like the learned maps (Jump Size and Patterns adjust it), a little bigger in
        // intense sections and drops
        const sections = ctx.sections || [];
        const styleScale = { streams: 0.72, jumps: 1.4 }[opts.patterns] || 1;
        // (harder maps jump a little further: 0.85x at 1, 1.17x at 10)
        const base = fm.move * (opts.jumpScale || 1) * styleScale * (0.85 + 0.035 * (difficulty - 1));
        const boost = opts.dropBoost ?? 1;
        const free = rank(smooth(a.hits, 150));
        const jumpAt = ms => {
            const s = sections.find(x => ms >= x.from && ms < x.to);
            const level = s ? s.level : free[Math.min(a.frames - 1, Math.max(0, Math.round(ms / 10)))] || 0.5;
            return base * (0.92 + 0.16 * level * (0.5 + 0.5 * boost) + (s && s.drop ? 0.06 * boost : 0));
        };
        const runOptions = { flow: opts.flow ?? 0.7, follow: opts.follow ?? 0.75, variety: opts.variety ?? 0.5, flowModel: fm };

        // how fast one move may make the cursor go: comfortable for the difficulty (about 12 cells a second at 5)
        const vmax = 4 * Math.pow(1.33, difficulty - 1);

        // map it a few times and keep the most balanced (fewer tries for long stretches, so it doesn't take ages)
        // (it hands the page back every few milliseconds so the editor never freezes, and stops trying once it has
        // spent about 20 seconds)
        let best = null;
        let tries = times.length < 600 ? TRIES : times.length < 1500 ? 5 : 3;
        const started = performance.now();
        for (let t = 0; t < tries; t++) {
            const label = `MAPPING (TRY ${t + 1} OF ${tries})`;
            progress(label);
            await tick();
            let last = performance.now();
            const yieldNow = async done => {
                if (performance.now() - last < 25)
                    return;
                progress(`${label} ${Math.floor(done * 100)}%`);
                await tick();
                last = performance.now();
            };
            const notes = await place(times, lib, { ...opts, vmax, runOptions, yieldNow }, jumpAt);
            const score = badness(notes, jumpAt, vmax, fm, runOptions.flow);
            if (!best || score < best.score)
                best = { notes, score };
            const each = (performance.now() - started) / (t + 1);
            tries = Math.min(tries, Math.max(t + 1, Math.floor(20000 / each)));
        }
        best.notes.info = {
            bpm: detected && detected.bpm, offsetMs: detected && detected.offsetMs, steady: !!(detected && detected.steady),
            sections: sections.map(s => ({ from: s.from, to: s.to, level: +s.level.toFixed(2), drop: s.drop, rate: s.rate && +s.rate.toFixed(1), nps: s.nps && +s.nps.toFixed(1) })),
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
    return { learn, learnFiles, stats, statsSync, reset, generate, analyse, findTempo, findEvents };
})();
