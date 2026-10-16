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
// With the Quantum option, the notes are quantum jumps and quantum slides: the quantum parts of the learned maps, or
// ones made for the spot and rhythm (quantumRun). Grid patterns are only ever moved by whole cells, never by part of
// one: a grid pattern sitting off the grid isn't quantum mapping.
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
        // how much is sounding in each band (held sounds too: a bass line, a pad), in log units
        const bandLow = new Float32Array(frames), bandMid = new Float32Array(frames), bandHigh = new Float32Array(frames);

        // Kicks are found in the bass range of the sound itself. A 1024-point spectrum has only a few bins below
        // 160Hz, and a held bass note there makes them flicker from frame to frame (false kicks, and real ones lost
        // under it). So: the song filtered below ~150Hz, its energy every 5ms, and how sharply that rises over 20ms.
        // A kick jumps within 10-20ms; a held or swelling (side-chained) bass doesn't.
        const lowRise = new Float32Array(frames);
        {
            const blk = sr / 200;
            const nb = Math.floor(buffer.length / blk);
            const e5 = new Float32Array(nb);
            const w0 = 2 * Math.PI * 150 / sr, cs = Math.cos(w0), al = Math.sin(w0) / (2 * Math.SQRT1_2);
            const b0 = (1 - cs) / 2 / (1 + al), b1 = (1 - cs) / (1 + al), a1 = -2 * cs / (1 + al), a2 = (1 - al) / (1 + al);
            let x1 = 0, x2 = 0, y1 = 0, y2 = 0, u1 = 0, u2 = 0, z1 = 0, z2 = 0, acc = 0, bi = 0, next = blk;
            const nch = chans.length;
            for (let i = 0; i < buffer.length; i++) {
                let v = chans[0][i];
                for (let c = 1; c < nch; c++)
                    v += chans[c][i];
                v /= nch;
                const y = b0 * v + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2;
                x2 = x1; x1 = v; y2 = y1; y1 = y;
                const z = b0 * y + b1 * u1 + b0 * u2 - a1 * z1 - a2 * z2;
                u2 = u1; u1 = y; z2 = z1; z1 = z;
                acc += z * z;
                if (i + 1 >= next) {
                    if (bi < nb)
                        e5[bi++] = acc / blk;
                    acc = 0;
                    next += blk;
                }
                if ((i & 0xfffff) === 0xfffff)
                    await new Promise(r => setTimeout(r));
            }
            const floor = percentile(e5, 0.9) * 1e-3 + 1e-12;
            // energy over the 20ms starting `LEAD` ms into a frame (so a kick lands on the same frame as everything
            // else found from the spectrum)
            const LEAD = 12;
            const energy = g => {
                const q = Math.floor((g * 10 + LEAD) / 5);
                let e = 0;
                for (let k = q; k < q + 4; k++)
                    e += k >= 0 && k < nb ? e5[k] : 0;
                return Math.log10(e / 4 + floor);
            };
            // ...and only where it gets louder than anything in the 30-90ms before (a side-chained bass swelling back
            // after a kick rises fast too, but never above the kick)
            const E = new Float32Array(frames);
            for (let g = 0; g < frames; g++)
                E[g] = energy(g);
            for (let g = 9; g < frames; g++) {
                let before = -Infinity;
                for (let k = g - 9; k <= g - 3; k++)
                    before = Math.max(before, E[k]);
                lowRise[g] = Math.max(0, E[g] - E[g - 2]) * Math.min(1, Math.max(0, (E[g] - before + 0.4) / 0.6));
            }
        }

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
            let eL = 0, eM = 0, eH = 0;
            for (let k = 1; k <= B; k++) {
                const pow = cur[k] * cur[k];
                if (k < lowEnd)
                    eL += pow;
                else if (k < midEnd)
                    eM += pow;
                else
                    eH += pow;
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
            bandLow[g] = Math.log10(eL + 1e-7);
            bandMid[g] = Math.log10(eM + 1e-7);
            bandHigh[g] = Math.log10(eH + 1e-7);
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
            kick: percentile(lowRise, 0.98), snare: percentile(mid, 0.98), hat: percentile(high, 0.98),
            melody: percentile(melodyRaw, 0.98), bass: percentile(bassRaw, 0.98),
        };
        // each band on the same scale
        for (const a of [low, mid, high, lowRise]) {
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
        // (the beat is found from the spectrum's bands above, which it was tuned on; kick notes from the bass range)
        const sources = { kick: peaky(lowRise), snare: peaky(mid), hat: peaky(high), melody, bass: bassline };
        const loudest = Math.max(...Object.values(rawPeak), 1e-9);
        const sourceLevel = {};
        for (const k in rawPeak)
            sourceLevel[k] = Math.min(1, rawPeak[k] / loudest);

        // how loud the song is around each moment compared to its loud parts (0..1): a soft passage's drums count less
        const db = smooth(rms.map(v => 20 * Math.log10(v + 1e-6)), 25);
        const loudRef = percentile(db, 0.95);
        const loudness = db.map(v => Math.min(1, Math.max(0, (v - (loudRef - 30)) / 24)));

        const result = { frames, hits, beats, low, rms, harmonic, melody, everything, sources, sourceLevel, loudness, tempo, bandLow, bandMid, bandHigh };
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

    // Splits the song into sections wherever its character changes (how loud it is, how much bass, mids and highs
    // are sounding, how many kicks, snares, hi-hats and melody notes there are), each at least 4 bars long, so a drop
    // that brings in an extra layer halfway becomes two sections. Each gets a level from 0 (calmest) to 1 (most
    // intense): mostly how loud the song is and how much bass is going on, then how busy the drums are (a snare roll
    // in a build-up is busy but has no bass, so it stays below the drop). Drops are intense sections that come after
    // a clearly calmer part, and the sections that carry them on.
    function findSections(a, bars) {
        const n = bars.length;
        if (!n)
            return [];
        if (!a.drumEvents)
            a.drumEvents = findEvents(a, DEFAULT_SOURCES, 0.5, 0, a.frames * 10);
        const ev = a.drumEvents;
        const mel = a.sources.melody;
        let e = 0;
        const KEYS = ['loud', 'lo', 'mi', 'hi', 'kick', 'snare', 'hat', 'melody', 'count', 'hits', 'onBeat', 'off8', 'off16'];
        const feat = bars.map(b => {
            const f0 = Math.max(0, Math.floor(b.from / 10)), f1 = Math.min(a.frames, Math.max(f0 + 1, Math.floor(b.to / 10)));
            let loud = 0, hits = 0, lo = 0, mi = 0, hi = 0, melody = 0;
            for (let f = f0; f < f1; f++) {
                loud += Math.log10(a.rms[f] + 1e-4);
                hits += a.hits[f];
                lo += a.bandLow[f];
                mi += a.bandMid[f];
                hi += a.bandHigh[f];
                melody += mel[f];
            }
            while (e < ev.length && ev[e].ms < b.from)
                e++;
            let kick = 0, snare = 0, hat = 0, count = 0;
            for (let j = e; j < ev.length && ev[j].ms < b.to; j++) {
                const w = Math.min(1, ev[j].strength);
                count += w;
                if (ev[j].kinds.includes('kick'))
                    kick += w;
                if (ev[j].kinds.includes('snare'))
                    snare += w;
                if (ev[j].kinds.includes('hat'))
                    hat += w;
            }
            // the shape of the rhythm: how much of the drums falls on the beats, on the 8th notes between them and on
            // the 16ths (a drop switching to a syncopated kick, or adding 16th hi-hats, changes it)
            const slot = (b.to - b.from) / 16;
            let onBeat = 0, off8 = 0, off16 = 0;
            for (let q = 0; q < 16; q++) {
                const v = around(a.hits, (b.from + q * slot) / 10, 2);
                if (q % 4 === 0)
                    onBeat += v;
                else if (q % 2 === 0)
                    off8 += v;
                else
                    off16 += v;
            }
            const all = onBeat + off8 + off16 + 1e-6;
            const c = f1 - f0, secs = Math.max(0.1, (b.to - b.from) / 1000);
            return {
                loud: loud / c, hits: hits / c, lo: lo / c, mi: mi / c, hi: hi / c, melody: melody / c,
                kick: kick / secs, snare: snare / secs, hat: hat / secs, count: count / secs,
                onBeat: onBeat / all, off8: off8 / all, off16: off16 / all,
            };
        });
        const R = {};
        for (const k of KEYS)
            R[k] = rank(feat.map(f => f[k]));
        const v = bars.map((_, i) => 0.3 * R.loud[i] + 0.3 * R.lo[i] + 0.15 * R.hits[i] + 0.25 * R.count[i]);

        // character: every feature on the same scale (how many spreads from its average), loudness and bass counting
        // a little more
        const WEIGHT = { loud: 1.3, lo: 1.3 };
        const D = KEYS.length;
        const z = new Float64Array(n * D);
        KEYS.forEach((k, d) => {
            const vals = feat.map(f => f[k]);
            const mean = vals.reduce((p, q) => p + q, 0) / n;
            const sd = Math.sqrt(vals.reduce((p, q) => p + (q - mean) ** 2, 0) / n) || 1;
            for (let i = 0; i < n; i++)
                z[i * D + d] = (vals[i] - mean) / sd * (WEIGHT[k] || 1);
        });
        const pre = new Float64Array((n + 1) * D), pre2 = new Float64Array(n + 1);
        for (let i = 0; i < n; i++) {
            let sq = 0;
            for (let d = 0; d < D; d++) {
                pre[(i + 1) * D + d] = pre[i * D + d] + z[i * D + d];
                sq += z[i * D + d] ** 2;
            }
            pre2[i + 1] = pre2[i] + sq;
        }
        const sse = (i, j) => {
            let s2 = pre2[j] - pre2[i];
            for (let d = 0; d < D; d++) {
                const s = pre[j * D + d] - pre[i * D + d];
                s2 -= s * s / (j - i);
            }
            return s2;
        };
        // best split: least spread inside sections, plus a cost per section
        const MIN = Math.min(4, n), LAMBDA = 9;
        const cost = new Float64Array(n + 1).fill(Infinity), from = new Int32Array(n + 1);
        cost[0] = 0;
        for (let j = MIN; j <= n; j++)
            for (let i = 0; i <= j - MIN; i++) {
                if (cost[i] === Infinity)
                    continue;
                const c = cost[i] + sse(i, j) + LAMBDA;
                if (c < cost[j]) {
                    cost[j] = c;
                    from[j] = i;
                }
            }
        if (cost[n] === Infinity) {
            cost[n] = 0;
            from[n] = 0;
        }
        let cuts = [];
        for (let j = n; j > 0; j = from[j])
            cuts.unshift([from[j], j]);

        // Smaller changes inside a section (a drop bringing in an extra layer, switching its kick pattern): the
        // 4 bars after each bar line against the 4 before it. Over 4 bars a song's own little cycle (chords, a
        // repeating fill) evens out, so inside a steady part this stays near zero and a change stands out as a
        // clear peak. Such a part is split there (each side at least 4 bars), so the notes can change with it.
        const W = 4;
        const novelty = i => {
            if (i < W || i + W > n)
                return 0;
            let s2 = 0;
            for (let d = 0; d < D; d++) {
                const after = (pre[(i + W) * D + d] - pre[i * D + d]) / W, before = (pre[i * D + d] - pre[(i - W) * D + d]) / W;
                s2 += (after - before) ** 2;
            }
            return Math.sqrt(s2 / D);
        };
        const split = ([i, j]) => {
            if (j - i < 2 * W)
                return [[i, j]];
            const inner = [];
            for (let k = i + W; k <= j - W; k++)
                inner.push([k, novelty(k)]);
            const [at, peak] = inner.reduce((p, q) => q[1] > p[1] ? q : p);
            // the usual change, away from the peak (a change shows in the 3 bar lines either side of it too)
            const rest = inner.filter(x => Math.abs(x[0] - at) > W - 1).map(x => x[1]).sort((p, q) => p - q);
            const base = rest.length ? rest[Math.floor(rest.length / 2)] : 0;
            // a peak: well above the part's usual change, and higher than its neighbours a bar either side
            if (peak < Math.max(0.12, 2.5 * base, novelty(at - 1) * 1.15, novelty(at + 1) * 1.15))
                return [[i, j]];
            return [...split([i, at]), ...split([at, j]).map((c, q) => q ? c : [c[0], c[1], true])];
        };
        cuts = cuts.flatMap(c => split(c).map((x, q) => q ? [x[0], x[1], true] : x));
        const sections = cuts.map(([i, j, change]) => ({
            from: bars[i].from, to: bars[j - 1].to, level: v.slice(i, j).reduce((p, q) => p + q, 0) / (j - i), bars: j - i, drop: false,
            change: !!change,
        }));
        sections.forEach((s, i) => {
            const before = sections[i - 1];
            s.drop = s.level >= 0.62 && (!before || before.level <= s.level - 0.15 || (before.drop && s.level >= before.level - 0.12));
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
        // inside a section, a bar with more going on than usual there (a drum fill, a roll into a drop) gets more
        // notes, up to 2.5x, even for that one moment, and a bar with less a few fewer; the section's total stays
        // the same
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
            const act = sec.rate > 0 ? Math.max(0.6, Math.min(2.5, 0.6 + 0.4 * barRate(b) / sec.rate)) : 1;
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
        // (a set number of notes sets its own speed: as fast as it takes to fit them)
        const countNps = opts.count > 0 ? Math.max(opts.count / span_s, 0.5) : 0;
        const dense = (opts.density || 1) >= 1.5;
        const peak = Math.max(12 * Math.pow(1.15, level10 - 1) * Math.max(1, opts.density || 1), countNps * 2.6);
        const busiest = Math.min(peak, (countNps || nps) * 2.6);
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

        // maps every bar; scale: section -> how much of its note allowance to use; push: more notes everywhere
        // (mult) and, to reach a set number of notes, streams in more places (stage 1: any busy part, 2: also where
        // there's one sound a beat, a division finer, and across gaps of two beats, 3: in any bar with a sound in it,
        // across gaps of four beats; bars with no sound at all stay empty)
        // (notes each bar got the first time, so a section can be scaled down from what it really got: its allowance
        // can be far above what its bars can hold)
        const firstCount = [];
        const mapBars = (scale, push = { mult: 1, stage: 0 }) => {
        out = [];
        heard = new Map();
        let carry = 0;
        const firstPass = !firstCount.length;
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

            const sc = scale.get(s);
            const exact = (sc === undefined || firstCount[j] === undefined ? cap[j] * push.mult : Math.min(cap[j], firstCount[j]) * sc * push.mult) + carry;
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
            // the strongest sounds, spread over the bar first (a bar's few notes all bunched at its start, then
            // nothing, feels like the map stopped), then the rest of the strongest wherever they are
            const picked = [];
            const spread = Math.max(minGap, 0.55 * (b.to - b.from) / Math.max(1, k));
            for (const gap of [spread, minGap])
                for (const e of here.sort((p, q) => q.score - p.score)) {
                    if (picked.length >= k)
                        break;
                    if (picked.every(t => Math.abs(t - e.ms) >= gap)) {
                        picked.push(e.ms);
                        heard.set(e.ms, e.src);
                    }
                }
            picked.sort((p, q) => p - q);

            // streams between the sounds, only where the song itself is busy (two sounds a beat or more), and at
            // most one division finer than the bar's own rhythm (another at difficulty 8 and up, and another at
            // 150% density or more), within the difficulty's top speed. Hard and dense maps fill the busy medium
            // parts too, not only the drops.
            const busy = raw.length >= (push.stage >= 3 ? 1 : beatsIn * (push.stage >= 2 ? 1 : dense ? 1.5 : 2));
            const intense = s.level >= 0.6 || s.drop || (hard && s.level >= 0.3) || (dense && s.level >= 0.2) || push.stage >= 1;
            if (picked.length < k && busy && (fill === 'busy' || (fill === 'intense' && intense))) {
                let finest = finer(family, div);
                for (let q = (hard ? 1 : 0) + (dense ? 1 : 0) + Math.min(2, Math.max(0, push.stage - 1)); q > 0; q--)
                    finest = finer(family, finest);
                const fillDiv = Math.min(topDiv(family, beatLen), finest, Math.max(div, d));
                const step = beatLen / fillDiv;
                const extra = [];
                for (let i = 0; i + 1 < picked.length && picked.length + extra.length < k; i++) {
                    const p0 = picked[i], p1 = picked[i + 1];
                    if (p1 - p0 > beatLen * (push.stage >= 3 ? 4.01 : push.stage >= 2 ? 2.01 : 1.01))
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
            if (firstPass)
                firstCount[j] = picked.length;
            out.push(...picked);
        });
        // No cuts where the music carries on. A gap much longer than this part's usual spacing (a bar whose share
        // of the notes rounded down to none, half a second or more) is only right when the music itself gives way
        // there: it stops, goes quiet, or its drums thin out. Otherwise the strongest sound near the middle of the
        // gap, on the beat, gets a note, until no such gap is left.
        const activity = (from, to) => {
            let w = 0;
            for (const e of events)
                if (e.ms >= from && e.ms < to)
                    w += Math.min(1, e.strength);
            return w / Math.max(0.2, (to - from) / 1000);
        };
        const loudAt = (from, to) => {
            let sum = 0, n = 0;
            for (let f = Math.max(0, Math.floor(from / 10)); f < Math.min(a.frames, to / 10); f++, n++)
                sum += a.loudness[f];
            return n ? sum / n : 0;
        };
        for (let round = 0; round < 6; round++) {
            const ts = [...new Set(out)].sort((p, q) => p - q);
            const add = [];
            for (let q = 1; q < ts.length; q++) {
                const t0 = ts[q - 1], t1 = ts[q], g = t1 - t0;
                const sec = sectionAt(t0);
                const here = Math.max(0.5, sec.nps * (scale.get(sec) ?? 1) * push.mult);
                // (long next to the notes just before it, or next to this part's usual spacing)
                const prevGaps = [];
                for (let k = Math.max(1, q - 8); k < q; k++)
                    prevGaps.push(ts[k] - ts[k - 1]);
                prevGaps.sort((p, q) => p - q);
                const usual = prevGaps.length ? prevGaps[prevGaps.length >> 1] : Infinity;
                if (g < 450 || (g < 2.5 * usual && g < 2.6 * 1000 / here))
                    continue;
                const inside = activity(t0 + 100, t1 - 100), before = activity(t0 - 4000, t0);
                if (inside < 1 || inside < 0.5 * before || loudAt(t0, t1) < loudAt(t0 - 4000, t0) - 0.2)
                    continue;
                let best = null;
                for (const e of events) {
                    if (e.ms <= t0 + g * 0.25 || e.ms >= t1 - g * 0.25)
                        continue;
                    const g2 = gridAt(e.ms, 2), g4 = gridAt(e.ms, 4), g3 = gridAt(e.ms, 3);
                    const on = [g2, g4, g3].find(x => x.err <= tolerance(x.step));
                    if (!on)
                        continue;
                    const score = Math.min(1.5, e.strength) * (0.6 + 0.4 * on.weight) * (1 - Math.abs(e.ms - (t0 + t1) / 2) / g);
                    if (!best || score > best.score)
                        best = { ms: Math.round(on.at), src: e.ms, score };
                }
                if (best) {
                    add.push(best.ms);
                    heard.set(best.ms, best.src);
                }
            }
            if (!add.length)
                break;
            out.push(...add);
        }
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

        // A set number of notes: mapped again with more (or fewer) until it's that many, filling in more places if
        // the song's sounds alone don't have enough; any left over are taken out evenly (streams filled in between
        // sounds first, so the notes on real sounds stay)
        if (opts.count > 0) {
            let mult = 1, stage = 0, lastGot = 0, enough = null;
            for (let it = 0; it < 12; it++) {
                const got = new Set(out).size;
                if (got >= opts.count && (!enough || got < enough.got))
                    enough = { got, out, heard };
                if (got >= opts.count && got <= opts.count * 1.03)
                    break;
                if (got < opts.count) {
                    // not getting any more from more of the same: fill in more places
                    if (it && got <= lastGot * 1.02 || mult >= 8) {
                        if (stage === 3)
                            break;
                        stage++;
                    } else
                        mult *= Math.min(3, opts.count / Math.max(1, got));
                } else
                    mult *= Math.max(0.5, (opts.count * 1.01) / got);
                lastGot = got;
                mapBars(scale, { mult, stage });
            }
            if (enough && new Set(out).size < opts.count)
                ({ out, heard } = enough);
            const all = [...new Set(out)].sort((p, q) => p - q);
            let excess = all.length - opts.count;
            if (excess > 0) {
                const filled = all.filter(t => !heard.has(t));
                const from = filled.length >= excess ? filled : all;
                const drop = new Set();
                const step = from.length / excess;
                for (let q = 0; q < excess; q++)
                    drop.add(from[Math.min(from.length - 1, Math.floor(q * step + step / 2))]);
                out = all.filter(t => !drop.has(t));
            }
        }
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
            // (at least one note in every stretch with a sound in it, so it never goes quiet while the song doesn't)
            let k = Math.max(1, Math.round(nps * (0.3 + 1.4 * Math.pow(lv, 1.5)) * (to - w) / 1000));
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

    // Spots in a learned map nobody could actually play, which are never copied: two places at the same moment, a
    // move faster than any human map goes (150 cells a second), a far jump much faster than the notes around it
    // (a glitch, or a joke part of a meme map), or a jerk (turning round at full speed) beyond the hardest human maps.
    // note i is flagged when getting to it from note i - 1 is the problem.
    const impossibleCache = new WeakMap();
    function impossible(e) {
        if (impossibleCache.has(e.t))
            return impossibleCache.get(e.t);
        const n = e.t.length, bad = new Uint8Array(n);
        const sp = new Float64Array(n), mv = new Float64Array(n);
        for (let i = 1; i < n; i++) {
            const g = e.t[i] - e.t[i - 1];
            mv[i] = Math.hypot(e.x[i] - e.x[i - 1], e.y[i] - e.y[i - 1]);
            sp[i] = mv[i] / Math.max(g, 1) * 1000;
            if ((g < 3 && mv[i] > 0.05) || sp[i] > 150)
                bad[i] = 1;
        }
        const pre = new Float64Array(n + 1);
        for (let i = 0; i < n; i++)
            pre[i + 1] = pre[i] + sp[i];
        for (let i = 1; i < n; i++) {
            const lo = Math.max(1, i - 16), hi = Math.min(n - 1, i + 16);
            const around = (pre[hi + 1] - pre[lo] - sp[i]) / Math.max(1, hi - lo);
            if (mv[i] >= 1.5 && sp[i] > Math.max(45, 3.5 * around))
                bad[i] = 1;
            if (i >= 2) {
                const t1 = (e.t[i - 1] - e.t[i - 2]) / 1000, t2 = (e.t[i] - e.t[i - 1]) / 1000;
                if (t1 >= 0.003 && t2 >= 0.003) {
                    const ax = (e.x[i] - e.x[i - 1]) / t2 - (e.x[i - 1] - e.x[i - 2]) / t1;
                    const ay = (e.y[i] - e.y[i - 1]) / t2 - (e.y[i - 1] - e.y[i - 2]) / t1;
                    if (Math.hypot(ax, ay) / ((t1 + t2) / 2) > 12000)
                        bad[i] = 1;
                }
            }
        }
        impossibleCache.set(e.t, bad);
        return bad;
    }

    // What a map's design is like: how far it moves, how often it jumps far or steps to a neighbour, how often it
    // turns right round, how much is off the grid, and its usual gap between notes
    function styleOf(e) {
        const n = Math.min(e.t.length, 4000);
        let moves = 0, sum = 0, jumps = 0, steps = 0, turns = 0, back = 0, off = 0;
        const gaps = [];
        for (let i = 1; i < n; i++) {
            const dx = e.x[i] - e.x[i - 1], dy = e.y[i] - e.y[i - 1], d = Math.hypot(dx, dy);
            if (!isWhole(e.x[i]) || !isWhole(e.y[i]))
                off++;
            if (e.t[i] - e.t[i - 1] > 5)
                gaps.push(e.t[i] - e.t[i - 1]);
            if (d < 0.05)
                continue;
            moves++;
            sum += d;
            if (d >= 1.5)
                jumps++;
            else if (d <= 1.05)
                steps++;
            if (i >= 2) {
                const px = e.x[i - 1] - e.x[i - 2], py = e.y[i - 1] - e.y[i - 2], pd = Math.hypot(px, py);
                if (pd > 0.3 && d > 0.3) {
                    turns++;
                    if ((px * dx + py * dy) / (pd * d) < -0.7)
                        back++;
                }
            }
        }
        gaps.sort((p, q) => p - q);
        return {
            move: moves ? sum / moves : 1, jumps: moves ? jumps / moves : 0, steps: moves ? steps / moves : 0,
            back: turns ? back / turns : 0, off: off / Math.max(1, n), gap: gaps.length ? gaps[gaps.length >> 1] : 200,
        };
    }
    const styleDistance = (p, q) => Math.hypot((p.move - q.move) / 0.35, (p.jumps - q.jumps) / 0.15, (p.steps - q.steps) / 0.15,
        (p.back - q.back) / 0.15, (p.off - q.off) / 0.2);

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
            // where a run without impossible spots ends
            const bad = impossible(e);
            const cleanUntil = new Int32Array(n);
            for (let i = n - 1; i >= 0; i--)
                cleanUntil[i] = bad[i] ? i : (i + 1 < n ? cleanUntil[i + 1] : n);
            return {
                ...e, n, at, wholeUntil, cleanUntil, style: styleOf(e),
                usable: quantum || !e.quantum || wholeUntil.some((u, i) => u - i >= 4),
            };
        }).filter(e => e.n >= 8 && e.usable);
    }

    // How many places in the library to try for each run of notes
    const SEARCH = 2400;

    // How much the Quantum option wants quantum notes over notes on the grid: enough that most of the map comes out
    // as quantum slides and jumps wherever they can be played
    const QUANTUM_WANT = 0.8;
    // (made-up quantum runs come after the learned maps' own quantum patterns, when those fit as well)
    const MADE_COST = 0.45;

    // A learned run from e[i] on (turned or mirrored by SYM[k]), as an entry whose first note is `from`: the move
    // from there to e[i] is checked and costed like any other
    function jumpInto(e, k, i, from, gaps) {
        const n = Math.max(1, Math.min(gaps.length, e.cleanUntil[i + 1] - i, e.n - i)) + 1;
        const x = new Float64Array(n), y = new Float64Array(n), t = new Float64Array(n);
        x[0] = from.x;
        y[0] = from.y;
        t[0] = e.t[i] - gaps[0];
        for (let q = 1; q < n; q++) {
            [x[q], y[q]] = SYM[k](e.x[i + q - 1], e.y[i + q - 1]);
            t[q] = e.t[i + q - 1];
        }
        return { name: e.name, x, y, t, n, quantum: true, cleanUntil: new Int32Array(n).fill(n), wholeUntil: new Int32Array(n), source: e };
    }
    const snapTo = (v, d) => Math.round(v * d) / d;
    const offGrid = (x, y) => !isWhole(x) || !isWhole(y) || x < 0 || x > 2 || y < 0 || y > 2;

    // A quantum run made for this spot and rhythm, as a library entry whose first note is `start` (`before` is the
    // note before it, for which way the cursor is going):
    // 'slide': the cursor gliding in small steps along a curve that sometimes bends the other way, turning back
    //          off the edges
    // 'jumps': jumps about as big as wanted here, from one spot off the grid to another, turning the same way each
    //          time like a spin
    function quantumRun(kind, start, before, gaps, J) {
        const n = gaps.length + 1;
        const x = new Float64Array(n), y = new Float64Array(n), t = new Float64Array(n);
        x[0] = start.x;
        y[0] = start.y;
        for (let q = 1; q < n; q++)
            t[q] = t[q - 1] + gaps[q - 1];
        const [lo, hi] = QUANTUM;
        const clamp = v => Math.min(hi, Math.max(lo, v));
        let ang = before && Math.hypot(start.x - before.x, start.y - before.y) > 0.05
            ? Math.atan2(start.y - before.y, start.x - before.x) : Math.random() * 2 * Math.PI;
        let step = 0;
        if (kind === 'slide') {
            step = Math.min(0.75, Math.max(0.2, J * (0.45 + 0.3 * Math.random())));
            let turn = (Math.random() < 0.5 ? -1 : 1) * (0.06 + 0.3 * Math.random());
            let px = start.x, py = start.y;
            for (let q = 1; q < n; q++) {
                if (q % 8 === 0 && Math.random() < 0.35)
                    turn = -turn;
                ang += turn;
                if (px + Math.cos(ang) * step < lo || px + Math.cos(ang) * step > hi)
                    ang = Math.PI - ang;
                if (py + Math.sin(ang) * step < lo || py + Math.sin(ang) * step > hi)
                    ang = -ang;
                px = clamp(px + Math.cos(ang) * step);
                py = clamp(py + Math.sin(ang) * step);
                x[q] = snapTo(px, 12);
                y[q] = snapTo(py, 12);
            }
        } else {
            // spins (turning 100-150 degrees each jump: triangles and stars), zigzags (nearly straight back and
            // forth, drifting across) or wide circles (turning 40-75 degrees), never going round the same shape twice
            const size = Math.max(1.2, J);
            let dir = Math.random() < 0.5 ? 1 : -1;
            const shape = Math.random();
            const bendOf = () => (shape < 0.45 ? 0.55 + 0.28 * Math.random() : shape < 0.75 ? 0.8 + 0.13 * Math.random() : 0.22 + 0.2 * Math.random()) * Math.PI;
            for (let q = 1; q < n; q++) {
                if (shape >= 0.45 && shape < 0.75)
                    dir = -dir;
                let best = null;
                for (let c = 0; c < 24; c++) {
                    const a2 = ang + dir * bendOf() + (Math.random() - 0.5) * 0.4;
                    const d = size * (0.8 + 0.4 * Math.random());
                    // (a spot past the edge isn't moved onto it: that gives jumps back and forth along the edge)
                    const cx = snapTo(x[q - 1] + Math.cos(a2) * d, 4), cy = snapTo(y[q - 1] + Math.sin(a2) * d, 4);
                    const real = Math.hypot(cx - x[q - 1], cy - y[q - 1]);
                    if (cx !== clamp(cx) || cy !== clamp(cy) || !offGrid(cx, cy) || real < 0.6)
                        continue;
                    let score = Math.abs(Math.log(real / size)) + 0.1 * Math.random();
                    for (let back = 2; back <= 6; back++)
                        if (q >= back && Math.hypot(cx - x[q - back], cy - y[q - back]) < 0.35)
                            score += 1;
                    if (!best || score < best.score)
                        best = { x: cx, y: cy, score };
                }
                // (boxed in: across the middle)
                if (!best)
                    best = { x: clamp(snapTo(2 - x[q - 1], 4)), y: clamp(snapTo(2 - y[q - 1], 4)) };
                x[q] = best.x;
                y[q] = best.y;
                if (Math.hypot(x[q] - x[q - 1], y[q] - y[q - 1]) > 0.05)
                    ang = Math.atan2(y[q] - y[q - 1], x[q] - x[q - 1]);
            }
        }
        return {
            name: kind === 'slide' ? 'quantum slide' : 'quantum jumps', x, y, t, n, quantum: true, made: true,
            // (a slide's moves are meant to be small: it's measured against its own step, not the jump size wanted. It
            // belongs in quick notes: gliding slowly from note to note a second apart isn't a slide)
            target: kind === 'slide' ? step : undefined,
            extra: kind === 'slide' ? 0.9 * Math.min(1, Math.max(0, (t[n - 1] / Math.max(1, n - 1) - 130) / 170)) : 0,
            cleanUntil: new Int32Array(n).fill(n), wholeUntil: new Int32Array(n),
        };
    }

    // One note a comfortable move on from `prev` (for when no run at all can be played there, so the map never just
    // stops): on the grid, or anywhere on the quantum grid with the Quantum option
    function stepNote(prev, prev2, ms, J, opts) {
        if (!prev)
            return { x: 1, y: 1, ms };
        const spots = [];
        const [lo, hi] = opts.quantum ? QUANTUM : GRID, d = opts.quantum ? 4 : 1;
        for (let x = lo; x <= hi + 1e-9; x += 1 / d)
            for (let y = lo; y <= hi + 1e-9; y += 1 / d)
                spots.push([x, y]);
        let best = null;
        for (const [x, y] of spots) {
            const dist = Math.hypot(x - prev.x, y - prev.y);
            if (dist < 0.05 || (prev2 && Math.hypot(x - prev2.x, y - prev2.y) < 0.05))
                continue;
            const speed = dist / Math.max(1, ms - prev.ms) * 1000;
            const score = Math.abs(Math.log((dist + 0.15) / (J + 0.15))) + (speed > opts.speedCap ? 5 + speed / opts.speedCap : 0) + 0.2 * Math.random();
            if (!best || score < best.score)
                best = { x, y, score };
        }
        return best ? { x: best.x, y: best.y, ms } : { x: prev.x, y: prev.y, ms };
    }

    // Finds the run of library notes to copy next.
    // gaps: the time from the previous note to each new note; prev/prev2: the last two notes placed
    function findRun(lib, gaps, prev, prev2, opts, used) {
        const bounds = opts.quantum ? QUANTUM : GRID;
        // (opts.jump: the average move, in cells, wanted here)
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
            const J = e.target || opts.jump;
            const len = Math.min(gaps.length, e.n - i - 1, opts.quantum ? Infinity : e.wholeUntil[i + 1] - i - 1,
                e.cleanUntil[i + 1] - i - 1);
            if (len < Math.min(opts.loose ? 1 : 3, gaps.length))
                return;
            // starting fresh (nothing to land on): the move from the last note placed still has to be playable
            if (!prev && opts.anchor) {
                const [x0, y0] = f(e.x[i + 1], e.y[i + 1]);
                const d0 = Math.hypot(x0 + ox - opts.anchor.x, y0 + oy - opts.anchor.y), s0 = d0 / Math.max(gaps[0], 1) * 1000;
                if (s0 > opts.speedCap || (d0 >= 1.5 && s0 > Math.max(0.45 * vmax, 3 * (opts.recentSpeed || 0) + 2)))
                    return;
            }
            let cost = 0, used_len = 0, dist = 0, jacks = 0, spins = 0, spikes = 0, logSum = 0, rough = 0, roughN = 0, off = 0;
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
                // Physically playable at the new timing, however fast the map it comes from was: no move faster than
                // the difficulty's top speed, no turning round harder than it allows, and no far jump much faster
                // than the notes just before (the run stops before such a note)
                const move = Math.hypot(e.x[i + q + 1] - e.x[i + q], e.y[i + q + 1] - e.y[i + q]);
                const speed = move / Math.max(gg, 1) * 1000;
                // (how fast it's been going over the last 8 moves: the notes placed before, then the run's own)
                let lately = opts.recentSpeed || 0;
                if (q && opts.recentMoves && isFinite(lately)) {
                    let d = 0, t = 0;
                    const fromRun = Math.min(q, 8);
                    for (const [md, mt] of opts.recentMoves.slice(opts.recentMoves.length - (8 - fromRun))) {
                        d += md;
                        t += mt;
                    }
                    for (let z = q - fromRun; z < q; z++) {
                        d += Math.hypot(e.x[i + z + 1] - e.x[i + z], e.y[i + z + 1] - e.y[i + z]);
                        t += gaps[z];
                    }
                    lately = t > 0 ? d / t * 1000 : lately;
                }
                if (speed > opts.speedCap || (move >= 1.5 && speed > Math.max(0.45 * vmax, 3 * lately + 2)))
                    break;
                if (recent.length >= 2 && lastGap > 0) {
                    const [a, b] = recent.slice(-2), t1 = lastGap / 1000, t2 = Math.max(gg, 1) / 1000;
                    const ax = (x + ox - b[0]) / t2 - (b[0] - a[0]) / t1, ay = (y + oy - b[1]) / t2 - (b[1] - a[1]) / t1;
                    if (Math.hypot(ax, ay) / ((t1 + t2) / 2) > opts.accelCap)
                        break;
                }
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
                    if (x1 - x0 <= 1.001 && y1 - y0 <= 1.001 && new Set([w0.join(','), w1.join(','), w2.join(','), w3.join(',')]).size === 4
                        && [w0, w1, w2, w3].every(w => isWhole(w[0]) && isWhole(w[1])))
                        spins++;
                }
                dist += move;
                if (move > Math.max(1.5, 2.1 * J) || move / Math.max(gg, 1) * 1000 > vmax)
                    spikes++;
                if (!isWhole(x + ox) || !isWhole(y + oy) || x + ox < 0 || x + ox > 2 || y + oy < 0 || y + oy > 2)
                    off++;
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
                cost += (0.1 + 2.2 * variety) * seen / total;
            }
            const scale = logSum / used_len;
            if (!opts.loose && (scale > Math.log(5) || scale < Math.log(0.6)))
                return;
            cost = cost / used_len * 1.5 + 0.12 * Math.abs(scale) * (0.5 + follow);
            cost += 2.6 * jacks / used_len + 1.8 * spins / used_len;
            // Flow: no rougher than the learned maps (at 100%, a fair bit smoother)
            if (model && roughN)
                cost += 2.4 * flow * Math.max(0, rough / roughN - model.change * (1.2 - 0.45 * flow));
            // steady difficulty: moves about as big as wanted here, without sudden far jumps
            // (much more so when Jump Size or Patterns ask for bigger or smaller moves than the maps make)
            cost += (opts.sizeWeight || 1.5) * Math.abs(Math.log((dist / used_len + 0.15) / (J + 0.15))) + 1.5 * spikes / used_len;
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
                cost += 0.05 + 1.3 * variety;
            cost -= e.bonus || 0;
            cost -= 0.006 * used_len;
            // Quantum: real quantum patterns (from quantum maps, or quantum slides and jumps made for here) are
            // wanted over notes on the grid
            if (opts.quantum)
                cost -= QUANTUM_WANT * off / used_len - (e.made ? MADE_COST + e.extra + (opts.lastName === e.name ? 0.4 : 0) : 0);
            // keeps to one map's design rather than hopping between maps; at a change in the music (a new section,
            // a drop bringing in something new) it does the opposite and starts a new pattern
            if (opts.lastEntry === e) {
                if (opts.fresh)
                    cost += Math.abs(i - opts.lastEnd) < 64 ? 0.5 : 0.1;
                else
                    cost -= 0.06 * (0.5 + follow);
            }
            if (opts.fresh && opts.lastK === k)
                cost += 0.12;
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
            // nothing starts exactly here (a spot the maps never use): a run moved over to it by whole cells. Never by
            // part of a cell: that only gives a grid pattern sitting off the grid, which isn't quantum mapping.
            if (candidates.length < 6)
                for (let s = 0; s < Math.min(SEARCH, 120 * lib.length); s++) {
                    const e = lib[Math.floor(Math.random() * lib.length)];
                    const i = Math.floor(Math.random() * (e.n - 2));
                    const k = Math.floor(Math.random() * 8);
                    const [x, y] = SYM[k](e.x[i], e.y[i]);
                    const ox = prev.x - x, oy = prev.y - y;
                    if (isWhole(ox) && isWhole(oy))
                        consider(e, k, i, Math.round(ox), Math.round(oy));
                }
        } else
            for (let s = 0; s < Math.min(SEARCH, 300 * lib.length); s++) {
                const e = lib[Math.floor(Math.random() * lib.length)];
                consider(e, Math.floor(Math.random() * 8), Math.floor(Math.random() * (e.n - 2)), 0, 0);
            }
        // With the Quantum option: quantum parts of the learned maps, jumped into from here (quantum notes seldom
        // land exactly where a learned run starts), and quantum slides and jumps made for exactly this spot and rhythm
        if (opts.quantum) {
            const quantumMaps = lib.filter(e => e.style && e.style.off >= 0.1);
            for (let s = 0; prev && quantumMaps.length && s < 160; s++) {
                const e = quantumMaps[Math.floor(Math.random() * quantumMaps.length)];
                const i = Math.floor(Math.random() * (e.n - 2));
                if (offGrid(e.x[i], e.y[i]))
                    consider(jumpInto(e, Math.floor(Math.random() * 8), i, prev, gaps), 0, 0, 0, 0);
            }
            const start = prev || opts.anchor || { x: 0.5 + Math.random() * 1.5, y: 0.5 + Math.random() * 1.5 };
            for (let s = 0; s < 4; s++) {
                consider(quantumRun('slide', start, prev2, gaps, opts.jump), 0, 0, 0, 0);
                consider(quantumRun('jumps', start, prev2, gaps, opts.jump), 0, 0, 0, 0);
            }
        }

        if (!candidates.length)
            return null;

        candidates.sort((p, q) => p.cost - q.cost);
        // (low Variety keeps to the very best fits, which repeat; high picks more freely among good ones)
        const top = candidates.slice(0, 1 + Math.round(variety * 11));
        const weights = top.map(c => Math.exp(-(c.cost - top[0].cost) / (0.015 + 0.14 * variety)));
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
        let lastRun = null;
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
            lastRun = r;
        };
        // the last 8 moves placed ([distance, time]), and how fast the cursor went over them
        const recentMoves = () => {
            const list = [];
            for (let j = Math.max(1, out.length - 8); j < out.length; j++)
                list.push([Math.hypot(out[j].x - out[j - 1].x, out[j].y - out[j - 1].y), out[j].ms - out[j - 1].ms]);
            return list;
        };
        const recentSpeed = () => {
            let d = 0, t = 0;
            for (let j = Math.max(1, out.length - 8); j < out.length; j++) {
                d += Math.hypot(out[j].x - out[j - 1].x, out[j].y - out[j - 1].y);
                t += out[j].ms - out[j - 1].ms;
            }
            return t > 0 ? d / t * 1000 : 0;
        };

        // where the music changes (a new section, or something new inside one): runs stop there, and what comes
        // after starts a new pattern
        const bounds = (opts.boundaries || []).slice().sort((p, q) => p - q);
        let bi = 0, fresh = false;
        while (i < times.length) {
            await yieldNow(i / times.length);
            while (bi < bounds.length && bounds[bi] <= times[i]) {
                bi++;
                fresh = true;
            }
            const limit = bi < bounds.length ? bounds[bi] : Infinity;
            // a run of up to 12-24 notes (fewer joins, more of the original flow), ending at a long pause
            const L = 12 + Math.floor(Math.random() * 13);
            const gaps = [];
            for (let q = 0; q < L && i + q < times.length; q++) {
                if (q > 0 && times[i + q] >= limit)
                    break;
                const g = times[i + q] - (q === 0 ? (prev ? prev.ms : times[i] - 500) : times[i + q - 1]);
                if (q > 2 && g > 4 * gaps[q - 1] && g > 600)
                    break;
                gaps.push(g);
            }
            remember();
            const ropts = {
                ...opts.runOptions, quantum: !!opts.quantum, jump: jumpAt(times[i]), vmax: opts.vmax, history,
                speedCap: opts.speedCap, accelCap: opts.accelCap, recentSpeed: recentSpeed(), recentMoves: recentMoves(), fresh,
                lastEntry: lastRun && lastRun.e, lastEnd: lastRun ? lastRun.i + lastRun.len : 0, lastK: lastRun && lastRun.k,
                lastName: lastRun && lastRun.e.name,
            };
            // nothing carries on from here: anything that does, then a fresh start (still a playable move away)
            let run = findRun(lib, gaps, prev, prev2, ropts, used)
                || findRun(lib, gaps, prev, prev2, { ...ropts, loose: true }, used)
                || findRun(lib, gaps, null, null, { ...ropts, loose: true, anchor: prev }, used);
            // (and if nothing at all can be played in time, the limits give a little rather than leaving a hole)
            for (let relax = 1.5; !run && relax <= 12; relax *= 2)
                run = findRun(lib, gaps, prev, prev2, {
                    ...ropts, loose: true, speedCap: opts.speedCap * relax, accelCap: opts.accelCap * relax,
                    recentSpeed: relax > 6 ? Infinity : ropts.recentSpeed * relax,
                }, used);
            if (!run) {
                const note = stepNote(prev, prev2, times[i], jumpAt(times[i]), opts);
                out.push(note);
                prev2 = prev;
                prev = note;
                i++;
                continue;
            }
            if (opts.trace)
                opts.trace.push({ ms: times[i], name: run.e.name, entry: run.e, k: run.k, len: run.len, fresh });
            fresh = false;
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
                    && new Set(w.map(v => `${v.x},${v.y}`)).size === 4 && w.every(v => isWhole(v.x) && isWhole(v.y)))
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

    // Which beat of four starts a bar (0..3), for a beat `beat` ms long whose beats fall at offsetMs + k * beat. Songs
    // change on the first beat of a bar (a drop comes in, a layer is added), so the bar lines that see the biggest
    // changes from one bar to the next are the real ones.
    function findDownbeat(a, beat, offsetMs) {
        const step = beat / 10;
        const count = Math.floor((a.frames - offsetMs / 10) / step);
        if (count < 16)
            return 0;
        const D = 5;
        const per = new Float64Array(count * D);
        for (let k = 0; k < count; k++) {
            const f0 = Math.floor(offsetMs / 10 + k * step), f1 = Math.min(a.frames, Math.floor(offsetMs / 10 + (k + 1) * step));
            let lo = 0, mi = 0, hi = 0, loud = 0, hits = 0;
            for (let f = f0; f < f1; f++) {
                lo += a.bandLow[f];
                mi += a.bandMid[f];
                hi += a.bandHigh[f];
                loud += Math.log10(a.rms[f] + 1e-4);
                hits += a.hits[f];
            }
            const c = Math.max(1, f1 - f0);
            [lo, mi, hi, loud, hits].forEach((v, d) => per[k * D + d] = v / c);
        }
        for (let d = 0; d < D; d++) {
            let mean = 0, sq = 0;
            for (let k = 0; k < count; k++)
                mean += per[k * D + d];
            mean /= count;
            for (let k = 0; k < count; k++)
                sq += (per[k * D + d] - mean) ** 2;
            const sd = Math.sqrt(sq / count) || 1;
            for (let k = 0; k < count; k++)
                per[k * D + d] = (per[k * D + d] - mean) / sd;
        }
        let best = 0, top = -1;
        for (let phase = 0; phase < 4; phase++) {
            // squared change between neighbouring bars: a change right on a bar line counts in full, one in the
            // middle of a bar is split over two smaller ones
            let score = 0, prev = null;
            for (let k = phase; k + 4 <= count; k += 4) {
                const bar = new Float64Array(D);
                for (let q = 0; q < 4; q++)
                    for (let d = 0; d < D; d++)
                        bar[d] += per[(k + q) * D + d] / 4;
                if (prev)
                    for (let d = 0; d < D; d++)
                        score += (bar[d] - prev[d]) ** 2;
                prev = bar;
            }
            if (score > top) {
                top = score;
                best = phase;
            }
        }
        return best;
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
            // the timing point on a downbeat (the first beat of a bar), so bars and sections start where the music's do
            const beat = 60000 / a.tempo.bpm;
            detected = { ...a.tempo, offsetMs: a.tempo.offsetMs + findDownbeat(a, beat, a.tempo.offsetMs) * beat };
            ctx.timing = [{ bpm: detected.bpm, ms: detected.offsetMs }];
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
        // With many maps learned, copying from all of them at once gives a patchwork: a stretch in one map's design,
        // then suddenly a completely different one. So one map leads (the map being made, if it has notes; otherwise
        // one of the learned maps whose rhythm fits this song best), and only the maps closest to its design are used.
        if (lib.length > 10) {
            const all = lib;
            const gaps = times.slice(1).map((t, q) => t - times[q]).filter(g => g > 5).sort((p, q) => p - q);
            const want = gaps.length ? gaps[gaps.length >> 1] : 200;
            const fit = e => Math.abs(Math.log(e.style.gap / want));
            let lead = lib.find(e => e.bonus);
            if (!lead) {
                const ranked = lib.slice().sort((p, q) => fit(p) - fit(q)).slice(0, 3);
                lead = ranked[Math.floor(Math.random() * ranked.length)];
            }
            const near = lib.filter(e => e !== lead)
                .map(e => ({ e, d: styleDistance(e.style, lead.style) + 0.6 * fit(e) }))
                .sort((p, q) => p.d - q.d).slice(0, 9).map(x => x.e);
            // (with the Quantum option, the most quantum of the learned maps come too)
            const quantumMaps = opts.quantum ? all.filter(e => e !== lead && !near.includes(e) && e.style.off >= 0.15)
                .sort((p, q) => q.style.off - p.style.off).slice(0, 3) : [];
            lib = [lead, ...near, ...quantumMaps];
        }
        await tick();
        const fm = flowModel(lib);
        await tick();

        // how big the moves should be: like the learned maps (Jump Size and Patterns adjust it), a little bigger in
        // intense sections and drops
        const sections = ctx.sections || [];
        const styleScale = { streams: 0.6, jumps: 1.6 }[opts.patterns] || 1;
        // (harder maps jump further: 0.8x at 1, 1.25x at 10)
        const base = fm.move * (opts.jumpScale || 1) * styleScale * (0.8 + 0.05 * (difficulty - 1));
        const boost = opts.dropBoost ?? 1;
        const free = rank(smooth(a.hits, 150));
        const jumpAt = ms => {
            const s = sections.find(x => ms >= x.from && ms < x.to);
            const level = s ? s.level : free[Math.min(a.frames - 1, Math.max(0, Math.round(ms / 10)))] || 0.5;
            return base * (0.92 + 0.16 * level * (0.5 + 0.5 * boost) + (s && s.drop ? 0.06 * boost : 0));
        };
        const runOptions = {
            flow: opts.flow ?? 0.7, follow: opts.follow ?? 0.75, variety: opts.variety ?? 0.5, flowModel: fm,
            sizeWeight: 1.5 + 3.5 * Math.abs(Math.log((opts.jumpScale || 1) * styleScale)),
        };

        // how fast one move may make the cursor go: comfortable for the difficulty (about 12 cells a second at 5)
        // (about 63 at 10, which the hardest human maps go past one move in ten)
        const vmax = 4 * Math.pow(1.36, difficulty - 1);
        // what can physically be played: the top speed of a single move and how hard the cursor may turn round
        // (about what the hardest human maps reach at 10, far gentler at the easy end)
        const speedCap = Math.max(8, vmax * 1.6), accelCap = vmax * 160;
        const boundaries = sections.slice(1).map(x => x.from).filter(ms => ms > opts.startMs && ms < opts.endMs);

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
            const trace = opts.trace ? [] : null;
            const notes = await place(times, lib, { ...opts, vmax, speedCap, accelCap, boundaries, runOptions, yieldNow, trace }, jumpAt);
            const score = badness(notes, jumpAt, vmax, fm, runOptions.flow);
            if (!best || score < best.score)
                best = { notes, score, trace };
            const each = (performance.now() - started) / (t + 1);
            tries = Math.min(tries, Math.max(t + 1, Math.floor(20000 / each)));
        }
        if (opts.trace && best.trace)
            opts.trace.push(...best.trace);
        best.notes.info = {
            bpm: detected && detected.bpm, offsetMs: detected && detected.offsetMs, steady: !!(detected && detected.steady), times: times.length,
            sections: sections.map(s => ({ from: s.from, to: s.to, level: +s.level.toFixed(2), drop: s.drop, change: s.change, rate: s.rate && +s.rate.toFixed(1), nps: s.nps && +s.nps.toFixed(1) })),
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
