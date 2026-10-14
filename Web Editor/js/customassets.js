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

    // ------------------------------------------------ state (loaded once, then kept in sync)

    const state = {
        imageUrl: null,     // object URL of the custom background image
        imageName: '',
        noteMesh: null,     // Float32Array of triangle positions
        noteMeshName: '',
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

    const ready = Promise.all([loadImage(), loadMesh()]).catch(() => { });

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

    return { ready, state, parseObj, setImage, setNoteMesh };
})();
