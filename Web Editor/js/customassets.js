'use strict';

// Web only: files the user picks to customise the editor and player (background image, note mesh).
// They're kept in IndexedDB so they survive reloads and are shared by the editor and the map player.
window.SSQECustom = (function () {
    const DB_NAME = 'ssqe-custom';
    const STORE = 'files';

    let dbPromise = null;
    function db() {
        if (!dbPromise)
            dbPromise = new Promise((resolve, reject) => {
                const req = indexedDB.open(DB_NAME, 1);
                req.onupgradeneeded = () => req.result.createObjectStore(STORE);
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
        return dbPromise;
    }

    async function request(mode, fn) {
        const d = await db();
        return new Promise((resolve, reject) => {
            const tx = d.transaction(STORE, mode);
            const req = fn(tx.objectStore(STORE));
            tx.oncomplete = () => resolve(req.result);
            tx.onerror = () => reject(tx.error);
        });
    }

    const get = key => request('readonly', s => s.get(key)).catch(() => undefined);
    const put = (key, value) => request('readwrite', s => s.put(value, key));
    const remove = key => request('readwrite', s => s.delete(key));

    // ------------------------------------------------ OBJ

    // Returns a flat Float32Array of triangle positions (polygons are fanned), centred on the origin.
    function parseObj(text) {
        const verts = [], out = [];
        for (const raw of text.split('\n')) {
            const line = raw.trim();
            if (line.startsWith('v ')) {
                const p = line.split(/\s+/);
                verts.push([+p[1], +p[2], +p[3]]);
            } else if (line.startsWith('f ')) {
                const idx = line.split(/\s+/).slice(1).map(t => {
                    const i = parseInt(t, 10);
                    return i < 0 ? verts.length + i : i - 1;
                });
                for (let i = 1; i + 1 < idx.length; i++)
                    for (const k of [idx[0], idx[i], idx[i + 1]]) {
                        const v = verts[k];
                        if (!v || v.some(n => !Number.isFinite(n)))
                            throw new Error('The model has a face that points to a missing vertex');
                        out.push(v[0], v[1], v[2]);
                    }
            }
        }
        if (!out.length)
            throw new Error('No faces were found in this .obj file');

        const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < out.length; i += 3)
            for (let a = 0; a < 3; a++) {
                min[a] = Math.min(min[a], out[i + a]);
                max[a] = Math.max(max[a], out[i + a]);
            }
        const centre = [0, 1, 2].map(a => (min[a] + max[a]) / 2);
        for (let i = 0; i < out.length; i += 3)
            for (let a = 0; a < 3; a++)
                out[i + a] -= centre[a];
        return new Float32Array(out);
    }

    // ------------------------------------------------ GIF

    // Decodes every frame of a GIF into its own canvas, so animated cursors can be drawn on the editor's canvas
    // (browsers only draw the first frame of an animated <img> there). Returns [{ image, delay }] or null.
    function decodeGif(buffer) {
        const b = new Uint8Array(buffer);
        if (b.length < 13 || String.fromCharCode(b[0], b[1], b[2]) !== 'GIF')
            return null;
        const w = b[6] | b[7] << 8, h = b[8] | b[9] << 8;
        let p = 13;
        const readTable = (flags) => {
            const size = 2 << (flags & 7);
            const t = b.subarray(p, p + size * 3);
            p += size * 3;
            return t;
        };
        const global = b[10] & 0x80 ? readTable(b[10]) : null;

        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        let screen = ctx.createImageData(w, h);
        const frames = [];
        let delay = 100, transparent = -1, disposal = 0;

        const subBlocks = () => {
            const parts = [];
            let len = 0;
            while (p < b.length && b[p] !== 0) {
                const n = b[p];
                parts.push(b.subarray(p + 1, p + 1 + n));
                len += n;
                p += n + 1;
            }
            p++;
            const out = new Uint8Array(len);
            let o = 0;
            for (const part of parts) {
                out.set(part, o);
                o += part.length;
            }
            return out;
        };

        const lzw = (data, minSize, count) => {
            const out = new Uint8Array(count);
            const clear = 1 << minSize, end = clear + 1;
            let size = minSize + 1, next = end + 1, prev = -1;
            const prefix = new Int16Array(4096), suffix = new Uint8Array(4096), first = new Uint8Array(4096);
            for (let i = 0; i < clear; i++) {
                suffix[i] = i;
                first[i] = i;
                prefix[i] = -1;
            }
            const stack = new Uint8Array(4097);
            let bits = 0, acc = 0, o = 0, i = 0;
            while (o < count) {
                while (bits < size && i < data.length) {
                    acc |= data[i++] << bits;
                    bits += 8;
                }
                if (bits < size)
                    break;
                const code = acc & ((1 << size) - 1);
                acc >>>= size;
                bits -= size;
                if (code === clear) {
                    size = minSize + 1;
                    next = end + 1;
                    prev = -1;
                    continue;
                }
                if (code === end)
                    break;
                let c = code, sp = 0;
                if (code >= next && prev >= 0) {
                    stack[sp++] = first[prev];
                    c = prev;
                }
                while (c >= 0 && sp < 4096) {
                    stack[sp++] = suffix[c];
                    c = prefix[c];
                }
                while (sp > 0 && o < count)
                    out[o++] = stack[--sp];
                if (prev >= 0 && next < 4096) {
                    prefix[next] = prev;
                    suffix[next] = code >= next ? first[prev] : first[code];
                    first[next] = first[prev];
                    next++;
                    if (next >= 1 << size && size < 12)
                        size++;
                }
                prev = code;
            }
            return out;
        };

        while (p < b.length) {
            const block = b[p++];
            if (block === 0x21) {
                const label = b[p++];
                if (label === 0xF9) {
                    const flags = b[p + 1];
                    disposal = (flags >> 2) & 7;
                    delay = (b[p + 2] | b[p + 3] << 8) * 10 || 100;
                    transparent = flags & 1 ? b[p + 4] : -1;
                }
                subBlocks();
            } else if (block === 0x2C) {
                const fx = b[p] | b[p + 1] << 8, fy = b[p + 2] | b[p + 3] << 8;
                const fw = b[p + 4] | b[p + 5] << 8, fh = b[p + 6] | b[p + 7] << 8;
                const flags = b[p + 8];
                p += 9;
                const table = flags & 0x80 ? readTable(flags) : global;
                const interlaced = !!(flags & 0x40);
                const minSize = b[p++];
                const pixels = lzw(subBlocks(), minSize, fw * fh);
                const before = disposal === 3 ? new Uint8ClampedArray(screen.data) : null;

                const rows = [];
                if (interlaced)
                    for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]])
                        for (let r = start; r < fh; r += step)
                            rows.push(r);
                else
                    for (let r = 0; r < fh; r++)
                        rows.push(r);
                const d = screen.data;
                rows.forEach((row, i) => {
                    const y = fy + row;
                    if (y >= h)
                        return;
                    for (let x = 0; x < fw; x++) {
                        const idx = pixels[i * fw + x];
                        if (idx === transparent || !table || fx + x >= w)
                            continue;
                        const o = (y * w + fx + x) * 4;
                        d[o] = table[idx * 3];
                        d[o + 1] = table[idx * 3 + 1];
                        d[o + 2] = table[idx * 3 + 2];
                        d[o + 3] = 255;
                    }
                });

                const frame = document.createElement('canvas');
                frame.width = w;
                frame.height = h;
                frame.getContext('2d').putImageData(screen, 0, 0);
                frames.push({ image: frame, delay: Math.max(20, delay) });

                if (disposal === 2)
                    for (let y = fy; y < Math.min(h, fy + fh); y++)
                        d.fill(0, (y * w + fx) * 4, (y * w + Math.min(w, fx + fw)) * 4);
                else if (disposal === 3 && before)
                    screen = new ImageData(before, w, h);
                delay = 100;
                transparent = -1;
                disposal = 0;
            } else
                break;
        }
        return frames.length ? frames : null;
    }

    // ------------------------------------------------ state (loaded once, then kept in sync)

    const state = {
        imageUrl: null,     // object URL of the custom background image
        imageName: '',
        noteMesh: null,     // Float32Array of triangle positions
        noteMeshName: '',
        cursorUrl: null,    // object URL of the custom grid cursor (any image, animated GIFs included)
        cursorName: '',
        cursorImage: null,  // loaded <img> for still images
        cursorFrames: null, // [{ image, delay }] for animated GIFs
    };

    async function loadImage() {
        const rec = await get('backgroundImage');
        if (state.imageUrl)
            URL.revokeObjectURL(state.imageUrl);
        state.imageUrl = rec && rec.blob ? URL.createObjectURL(rec.blob) : null;
        state.imageName = rec ? rec.name : '';
    }

    async function loadMesh() {
        const rec = await get('noteMesh');
        state.noteMesh = null;
        state.noteMeshName = '';
        if (rec && rec.text)
            try {
                state.noteMesh = parseObj(rec.text);
                state.noteMeshName = rec.name;
            } catch { /* a broken save is ignored */ }
    }

    async function loadCursor() {
        const rec = await get('editorCursor');
        if (state.cursorUrl)
            URL.revokeObjectURL(state.cursorUrl);
        state.cursorUrl = rec && rec.blob ? URL.createObjectURL(rec.blob) : null;
        state.cursorName = rec ? rec.name : '';
        state.cursorImage = null;
        state.cursorFrames = null;
        if (!state.cursorUrl)
            return;
        try {
            const frames = decodeGif(await rec.blob.arrayBuffer());
            if (frames && frames.length > 1) {
                state.cursorFrames = frames;
                return;
            }
        } catch { /* not a GIF we can read; shown as a still image */ }
        const img = new Image();
        img.src = state.cursorUrl;
        await img.decode().catch(() => { });
        state.cursorImage = img;
    }

    // what to draw for the custom cursor right now (null when there isn't one)
    function cursorFrame(timeMs = performance.now()) {
        const frames = state.cursorFrames;
        if (frames) {
            const total = frames.reduce((n, f) => n + f.delay, 0);
            let t = timeMs % total;
            for (const f of frames) {
                if (t < f.delay)
                    return f.image;
                t -= f.delay;
            }
            return frames[0].image;
        }
        const img = state.cursorImage;
        return img && img.complete && img.naturalWidth ? img : null;
    }

    async function setCursor(file) {
        if (file)
            await put('editorCursor', { name: file.name, blob: file });
        else
            await remove('editorCursor');
        await loadCursor();
    }

    const ready = Promise.all([loadImage(), loadMesh(), loadCursor()]).catch(() => { });

    async function setImage(file) {
        if (file)
            await put('backgroundImage', { name: file.name, blob: file });
        else
            await remove('backgroundImage');
        await loadImage();
    }

    // throws when the file isn't a usable .obj
    async function setNoteMesh(file) {
        if (file) {
            const text = await file.text();
            parseObj(text);
            await put('noteMesh', { name: file.name, text });
        } else
            await remove('noteMesh');
        await loadMesh();
    }

    // learned data (auto mapper, bot) is stored next to the files
    return { ready, state, parseObj, decodeGif, cursorFrame, setImage, setNoteMesh, setCursor, get, put, remove };
})();
