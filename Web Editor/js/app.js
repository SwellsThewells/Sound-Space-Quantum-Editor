'use strict';

// Port of NewMaps/Mapping.cs (open/close/save/cache), NewGUI/Windows/GuiWindowMenu.cs, GuiWindowCreate.cs and
// GuiWindowSettings.cs, plus browser-specific storage (IndexedDB stands in for the editor's cached/ folder).
(function () {
    const { Map, Formats, RenderMode } = SSQE;
    const el = (...a) => SSQE.el(...a);

    // ---------------------------------------------------------------- storage

    class Storage {
        constructor() {
            this.memory = { audio: new window.Map(), maps: new window.Map(), handles: new window.Map() };
            this.db = null;
        }

        async open() {
            if (!window.indexedDB)
                return;
            try {
                this.db = await new Promise((resolve, reject) => {
                    const req = indexedDB.open('ssqe-web-editor', 1);
                    req.onupgradeneeded = () => {
                        const db = req.result;
                        for (const name of ['audio', 'maps', 'handles'])
                            if (!db.objectStoreNames.contains(name))
                                db.createObjectStore(name);
                    };
                    req.onsuccess = () => resolve(req.result);
                    req.onerror = () => reject(req.error);
                });
            } catch (e) {
                console.warn('IndexedDB unavailable, maps will not persist', e);
            }
        }

        async op(store, mode, fn) {
            if (!this.db) {
                const m = this.memory[store];
                return fn({
                    get: k => m.get(k), put: (v, k) => m.set(k, v), delete: k => m.delete(k),
                    getAll: () => [...m.values()],
                }, true);
            }
            return new Promise((resolve, reject) => {
                const tx = this.db.transaction(store, mode);
                const req = fn(tx.objectStore(store), false);
                tx.oncomplete = () => resolve(req && 'result' in req ? req.result : undefined);
                tx.onerror = () => reject(tx.error);
            });
        }

        getAudio(id) { return this.op('audio', 'readonly', s => s.get(id)); }
        putAudio(id, blob) { return this.op('audio', 'readwrite', s => s.put(blob, id)); }
        getMaps() { return this.op('maps', 'readonly', s => s.getAll()); }
        putMap(rec) { return this.op('maps', 'readwrite', s => s.put(rec, rec.key)); }
        deleteMap(key) { return this.op('maps', 'readwrite', s => s.delete(key)); }
        getHandle(key) { return this.op('handles', 'readonly', s => s.get(key)); }
        putHandle(key, h) { return this.op('handles', 'readwrite', s => s.put(h, key)); }
        deleteHandle(key) { return this.op('handles', 'readwrite', s => s.delete(key)); }
    }

    // guesses a mime type for raw audio bytes so the browser can decode SSPM audio
    function sniffAudio(bytes) {
        const b = bytes.subarray(0, 12);
        const str = String.fromCharCode(...b);
        if (str.startsWith('OggS'))
            return 'audio/ogg';
        if (str.startsWith('RIFF'))
            return 'audio/wav';
        if (str.startsWith('fLaC'))
            return 'audio/flac';
        if (str.slice(4, 8) === 'ftyp')
            return 'audio/mp4';
        return 'audio/mpeg';
    }

    const newKey = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    // ---------------------------------------------------------------- app

    class App {
        constructor() {
            this.settings = SSQE.Settings.load();
            SSQE.Audio.SoundPlayer.settings = this.settings;
            this.storage = new Storage();
            this.dialogs = new SSQE.Dialogs(this);
            this.music = new SSQE.Audio.MusicPlayer(this.settings);
            this.openMaps = []; // Mapping.Cache: { key, map|null, rec }
            this.mapIndex = 0;
            this.screen = null;
            this.changelog = '';
            this.editor = null;
            this.cacheTimer = null;
            this.autosaveTimer = null;
        }

        async init() {
            SSQE.GUI.setSettings(this.settings);
            await SSQE.GUI.loadFonts();
            await this.storage.open();
            const recs = (await this.storage.getMaps()) || [];
            recs.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
            this.openMaps = recs.map(rec => ({ key: rec.key, map: null, rec }));

            this.applyTheme();
            this.loadChangelog();
            this.showMenu();
            this.startAutosaving();

            window.addEventListener('beforeunload', e => {
                if (this.cacheTimer) {
                    this.flushCache();
                    e.preventDefault();
                    e.returnValue = '';
                }
            });

            // buttons and checkboxes shouldn't keep keyboard focus, otherwise Space would also "click" them
            document.addEventListener('click', e => {
                const target = e.target.closest('button, input[type=checkbox], input[type=range]');
                if (target && !target.closest('.msg-overlay'))
                    setTimeout(() => target.blur(), 0);
            }, true);
            document.addEventListener('change', e => {
                if (e.target.tagName === 'SELECT' && !e.target.closest('.msg-overlay, .av-window'))
                    e.target.blur();
            }, true);

            window.addEventListener('dragover', e => e.preventDefault());
            window.addEventListener('drop', e => {
                e.preventDefault();
                const files = [...e.dataTransfer.files];
                if (!files.length)
                    return;
                if (this.editor && files.length === 1 && files[0].name.toLowerCase().endsWith('.ini'))
                    this.readIniFile(this.editor.map, files[0]);
                else if (!this.editor)
                    this.loadFiles(files);
            });
        }

        applyTheme() {
            const root = document.documentElement.style;
            for (let i = 1; i <= 5; i++)
                root.setProperty(`--c${i}`, `rgb(${this.settings[`color${i}`].join(',')})`);
        }

        dialogOpen() {
            return this.dialogs.isModalOpen();
        }

        // the menu, create, settings and keybinds windows are canvas screens (screens.js); the editor runs its own loop
        showScreen(name) {
            if (this.screen) {
                this.screen.stop();
                this.screen = null;
            }
            document.body.dataset.screen = name;
            if (name !== 'editor') {
                this.screen = SSQE.Screens[name](this);
                this.screen.start();
            }
        }

        // ------------------------------------------------------------ helpers

        download(blob, name) {
            const a = el('a', { href: URL.createObjectURL(blob), download: name });
            document.body.append(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(a.href), 10000);
        }

        pickFile(accept, multiple = false) {
            return new Promise(resolve => {
                const input = el('input', { type: 'file', accept });
                if (multiple)
                    input.multiple = true;
                input.addEventListener('change', () => resolve(multiple ? [...input.files] : input.files[0] || null));
                input.addEventListener('cancel', () => resolve(multiple ? [] : null));
                input.click();
            });
        }

        async writeClipboard(text) {
            try {
                await navigator.clipboard.writeText(text);
            } catch {
                const ta = el('textarea', { style: { position: 'fixed', opacity: '0' } });
                ta.value = text;
                document.body.append(ta);
                ta.select();
                document.execCommand('copy');
                ta.remove();
            }
        }

        async readClipboard(label) {
            try {
                const text = await navigator.clipboard.readText();
                if (text)
                    return text;
            } catch { /* fall back to a prompt */ }
            return this.dialogs.prompt('Paste', label, '', true);
        }

        // ------------------------------------------------------------ menu (GuiWindowMenu)

        showMenu() {
            this.showScreen('menu');
        }

        openCreate() {
            this.showScreen('create');
        }

        openSettings() {
            this.showScreen('settings');
        }

        openKeybinds() {
            this.showScreen('keybinds');
        }

        async loadMapDialog() {
            const files = await this.pickFile('.txt,.ini,.sspm,.osu,audio/*,.asset,.mp3,.ogg,.wav,.flac,.m4a,.opus', true);
            if (files.length)
                this.loadFiles(files);
        }

        async pasteMap() {
            const text = await this.readClipboard('Paste map data');
            if (text && text.trim())
                this.loadText(text.trim());
        }

        // Settings.lastFile: the map opened most recently
        lastMapEntry() {
            let key = null;
            try {
                key = localStorage.getItem('ssqe-web-editor-last-map');
            } catch { /* storage unavailable */ }
            return key ? this.openMaps.find(e => e.key === key) || null : null;
        }

        openLastMap() {
            const entry = this.lastMapEntry();
            if (entry)
                this.openEntry(entry);
        }

        openAutosaved() {
            this.openLastMap();
        }

        entryName(entry) {
            return entry.map ? entry.map.fileId : (entry.rec.fileName ? entry.rec.fileName.replace(/\.[^.]*$/, '') : entry.rec.soundId);
        }

        // stands in for the desktop colour picker dialog
        pickColor(current) {
            return new Promise(resolve => {
                const input = el('input', { type: 'color', style: { position: 'fixed', left: '50%', top: '50%', opacity: '0', pointerEvents: 'none' } });
                input.value = '#' + current.slice(0, 3).map(n => n.toString(16).padStart(2, '0')).join('');
                let done = false;
                const finish = value => {
                    if (done)
                        return;
                    done = true;
                    input.remove();
                    resolve(value ? [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16)) : null);
                };
                input.addEventListener('change', () => finish(input.value));
                input.addEventListener('cancel', () => finish(null));
                document.body.append(input);
                input.click();
            });
        }

        async loadChangelog() {
            try {
                const res = await fetch('../changelog');
                if (!res.ok)
                    throw new Error(res.statusText);
                this.changelog = (await res.text()).replace(/\r/g, '');
            } catch {
                this.changelog = 'The changelog is available in the repository (changelog file next to this folder).';
            }
        }

        isSaved(entry) {
            const rec = entry.rec;
            if (entry.map)
                return !!entry.map.savedText && entry.map.savedText === this.mapText(entry.map);
            return !!rec.savedText && rec.savedText === `${rec.txt}\n${rec.ini}`;
        }

        // ------------------------------------------------------------ loading (Mapping.Load / Parse)

        async loadFiles(files) {
            const byExt = ext => files.filter(f => f.name.toLowerCase().endsWith(ext));
            const audioFiles = files.filter(f => !/\.(txt|ini|sspm|osu)$/i.test(f.name));
            const base = name => name.replace(/\.[^.]*$/, '');

            try {
                const sspm = byExt('.sspm')[0];
                if (sspm) {
                    const map = new Map();
                    const { audio, cover } = Formats.readSspm(map, await sspm.arrayBuffer());
                    if (audio)
                        await this.storage.putAudio(map.soundId, new Blob([audio], { type: sniffAudio(audio) }));
                    if (cover)
                        map.coverBytes = cover;
                    await this.openNewMap(map, null);
                    return;
                }

                const osu = byExt('.osu')[0];
                if (osu) {
                    const map = new Map();
                    const audioName = Formats.readOsu(map, await osu.text());
                    const audio = audioFiles.find(f => f.name === audioName) || audioFiles[0];
                    if (audio)
                        await this.storage.putAudio(map.soundId, audio);
                    await this.openNewMap(map, null);
                    return;
                }

                const txt = byExt('.txt')[0];
                if (txt) {
                    const map = new Map();
                    Formats.readTxt(map, await txt.text());
                    const ini = byExt('.ini').find(f => base(f.name) === base(txt.name)) || byExt('.ini')[0];
                    if (ini)
                        Formats.readIni(map, await ini.text());
                    if (audioFiles[0])
                        await this.storage.putAudio(map.soundId, audioFiles[0]);
                    map.fileName = txt.name;
                    await this.openNewMap(map, null, true);
                    return;
                }

                if (audioFiles[0])
                    this.dialogs.message('To start a new map from an audio file, use CREATE NEW MAP.');
            } catch (e) {
                console.warn(e);
                this.dialogs.message(`Failed to load map data: ${e.message}`);
            }
        }

        async loadText(text) {
            try {
                const map = new Map();
                Formats.readTxt(map, text);
                await this.openNewMap(map, null);
            } catch (e) {
                this.dialogs.message(`Failed to load map data: ${e.message}`);
            }
        }

        async readIniFile(map, file) {
            try {
                Formats.readIni(map, await file.text());
                map.sortAll();
                this.editor && this.editor.toast('IMPORTED INI');
                this.scheduleCacheSave();
            } catch (e) {
                this.dialogs.message(`Failed to read .ini: ${e.message}`);
            }
        }

        async importIni(map) {
            const file = await this.pickFile('.ini');
            if (file)
                this.readIniFile(map, file);
        }

        // adds a freshly parsed map to the open map list and opens it
        async openNewMap(map, key, savedAsLoaded = false) {
            const entry = { key: key || newKey(), map, rec: null };
            if (savedAsLoaded)
                map.savedText = this.mapText(map);
            this.openMaps.push(entry);
            map.key = entry.key;
            await this.persistEntry(entry);
            await this.openEntry(entry);
        }

        mapText(map) {
            return `${Formats.writeTxt(map)}\n${Formats.writeIni(map)}`;
        }

        async materialize(entry) {
            if (entry.map)
                return entry.map;
            const rec = entry.rec;
            const map = new Map();
            Formats.readTxt(map, rec.txt);
            Formats.readIni(map, rec.ini);
            map.key = entry.key;
            map.fileName = rec.fileName || null;
            map.savedText = rec.savedText || null;
            if (rec.props)
                Object.assign(map.props, rec.props);
            if (rec.view) {
                map.tempoSlider = rec.view.tempoSlider ?? map.tempoSlider;
                map.zoom = rec.view.zoom ?? map.zoom;
            }
            if (rec.cover)
                map.coverBytes = rec.cover;
            try {
                map.dirHandle = await this.storage.getHandle(entry.key) || null;
            } catch {
                map.dirHandle = null;
            }
            entry.map = map;
            return map;
        }

        // Mapping.Open
        async openEntry(entry) {
            let map;
            try {
                map = await this.materialize(entry);
            } catch (e) {
                this.dialogs.message(`Failed to load map data: ${e.message}`);
                return;
            }

            let audio = await this.storage.getAudio(map.soundId);
            if (!audio) {
                const answer = await this.dialogs.confirm(`No audio found for ID '${map.soundId}'.\n\nWould you like to import an audio file for this ID?`, [['OK', 'yes'], ['Cancel', 'no']]);
                if (answer !== 'yes')
                    return;
                audio = await this.pickFile('audio/*,.asset,.mp3,.ogg,.wav,.flac,.m4a,.opus');
                if (!audio)
                    return;
                await this.storage.putAudio(map.soundId, audio);
            }

            try {
                await SSQE.Audio.loadSounds();
                await this.music.load(audio);
            } catch (e) {
                const answer = await this.dialogs.confirm(`Failed to load audio with ID '${map.soundId}':\n\n${e.message}\n\nWould you like to import a new file?`, [['OK', 'yes'], ['Cancel', 'no']]);
                if (answer === 'yes') {
                    const file = await this.pickFile('audio/*');
                    if (file) {
                        await this.storage.putAudio(map.soundId, file);
                        return this.openEntry(entry);
                    }
                }
                return;
            }

            map.duration = this.music.duration * 1000;
            map.currentTime = Math.min(map.currentTime, map.duration);
            map.sortAll();

            try {
                localStorage.setItem('ssqe-web-editor-last-map', entry.key);
            } catch { /* storage unavailable */ }
            this.showScreen('editor');
            this.editor = new SSQE.Editor(this, map, this.music);
            this.editor.start();
        }

        backToMenu() {
            if (this.editor) {
                this.flushCache();
                this.editor.stop();
                this.editor = null;
                this.music.stop();
            }
            this.dialogs.closeAll();
            this.showMenu();
        }

        // Mapping.Close
        async closeEntry(entry) {
            if (!this.isSaved(entry)) {
                const map = await this.materialize(entry);
                const answer = await this.dialogs.confirm(`${map.fileId} (${map.soundId})\n\nWould you like to save before closing?`, [['Yes', 'yes'], ['No', 'no'], ['Cancel', 'cancel']]);
                if (answer === 'cancel' || answer === null)
                    return;
                if (answer === 'yes' && !await this.save(map))
                    return;
            }

            this.openMaps = this.openMaps.filter(e => e !== entry);
            await this.storage.deleteMap(entry.key);
            await this.storage.deleteHandle(entry.key).catch(() => { });
        }

        // ------------------------------------------------------------ cache / autosave

        async persistEntry(entry) {
            const map = entry.map;
            if (!map)
                return;
            const rec = {
                key: entry.key,
                order: this.openMaps.indexOf(entry),
                soundId: map.soundId,
                fileName: map.fileName,
                txt: Formats.writeTxt(map),
                ini: Formats.writeIni(map),
                savedText: map.savedText,
                props: map.props,
                view: { tempoSlider: map.tempoSlider, zoom: map.zoom },
                cover: map.coverBytes || null,
                updated: Date.now(),
            };
            entry.rec = rec;
            try {
                await this.storage.putMap(rec);
            } catch (e) {
                console.warn('Failed to cache map', e);
            }
        }

        scheduleCacheSave() {
            clearTimeout(this.cacheTimer);
            this.cacheTimer = setTimeout(() => this.flushCache(), 1000);
        }

        flushCache() {
            clearTimeout(this.cacheTimer);
            this.cacheTimer = null;
            const entry = this.editor && this.openMaps.find(e => e.map === this.editor.map);
            if (entry)
                this.persistEntry(entry);
        }

        // Mapping.StartAutosaving - writes to the map's files when it was saved to a folder before
        startAutosaving() {
            clearInterval(this.autosaveTimer);
            const tick = async () => {
                if (!this.settings.enableAutosave || !this.editor)
                    return;
                const map = this.editor.map;
                if (map.notes.length + map.bookmarks.length + map.timingPoints.length === 0 || this.isSaved({ map }))
                    return;

                // the open map is always cached in the browser; maps saved to a folder are also written to their files
                this.flushCache();
                if (map.dirHandle && map.fileName)
                    await this.writeToFolder(map, map.dirHandle, map.fileName.replace(/\.txt$/i, ''), false);
                this.editor && this.editor.toast('AUTOSAVED');
            };
            this.autosaveTimer = setInterval(tick, Math.max(0.5, this.settings.autosaveInterval) * 60000);
        }

        // ------------------------------------------------------------ saving (Mapping.Save / SaveAs)

        async writeToFolder(map, dir, name, interactive) {
            try {
                if (dir.queryPermission && await dir.queryPermission({ mode: 'readwrite' }) !== 'granted') {
                    if (!interactive || await dir.requestPermission({ mode: 'readwrite' }) !== 'granted')
                        return false;
                }
                const write = async (fileName, text) => {
                    const handle = await dir.getFileHandle(fileName, { create: true });
                    const w = await handle.createWritable();
                    await w.write(text);
                    await w.close();
                };
                await write(`${name}.txt`, Formats.writeTxt(map));
                await write(`${name}.ini`, Formats.writeIni(map));
                map.fileName = `${name}.txt`;
                map.savedText = this.mapText(map);
                return true;
            } catch (e) {
                console.warn('Failed to save', e);
                return false;
            }
        }

        async save(map) {
            if (map.dirHandle && map.fileName) {
                const ok = await this.writeToFolder(map, map.dirHandle, map.fileName.replace(/\.txt$/i, ''), true);
                this.afterSave(map, ok);
                return ok;
            }
            return this.saveAs(map);
        }

        async saveAs(map) {
            const canUseFolders = !!window.showDirectoryPicker;
            const result = await this.dialogs.saveAs(map, canUseFolders);
            if (!result)
                return false;

            const name = (result.name || map.fileId).replace(/\.(txt|ini)$/i, '').replace(/[\\/:*?"<>|]/g, '_');
            let ok = false;

            if (result.mode === 'folder') {
                try {
                    const dir = await window.showDirectoryPicker({ id: 'ssqe-maps', mode: 'readwrite' });
                    ok = await this.writeToFolder(map, dir, name, true);
                    if (ok) {
                        map.dirHandle = dir;
                        this.storage.putHandle(map.key, dir).catch(() => { });
                    }
                } catch (e) {
                    if (e.name !== 'AbortError')
                        console.warn(e);
                    return false;
                }
            } else {
                this.download(new Blob([Formats.writeTxt(map)], { type: 'text/plain' }), `${name}.txt`);
                this.download(new Blob([Formats.writeIni(map)], { type: 'text/plain' }), `${name}.ini`);
                map.fileName = `${name}.txt`;
                map.dirHandle = null;
                map.savedText = this.mapText(map);
                ok = true;
            }

            this.afterSave(map, ok);
            return ok;
        }

        afterSave(map, ok) {
            if (this.editor && this.editor.map === map)
                this.editor.toast(ok ? 'SAVED' : 'FAILED TO SAVE', ok ? 'info' : 'warn');
            const entry = this.openMaps.find(e => e.map === map);
            if (entry)
                this.persistEntry(entry);
        }

        // GuiWindowEditor CopyButton
        async copyMapData(map) {
            try {
                await this.writeClipboard(Formats.writeTxt(map, this.settings.correctOnCopy));
                this.editor && this.editor.toast('COPIED TO CLIPBOARD');
            } catch {
                this.editor && this.editor.toast('FAILED TO COPY', 'warn');
            }
        }

        // GuiWindowEditor ReplaceID
        async replaceAudioId(map, id) {
            id = (id || '').trim();
            if (!id)
                return;
            if (await this.dialogs.confirm('Are you sure you want to replace this ID?\nIf an asset exists with this ID, it will be overwritten.') !== 'yes')
                return;
            const audio = await this.storage.getAudio(map.soundId);
            if (audio)
                await this.storage.putAudio(id, audio);
            map.soundId = id;
            this.editor && this.editor.onMapChanged();
            this.editor && this.editor.toast(`REPLACED AUDIO ID WITH ${id}`);
        }

        async changeAudio(editor) {
            const file = await this.pickFile('audio/*,.asset,.mp3,.ogg,.wav,.flac,.m4a,.opus');
            if (!file)
                return;
            await this.storage.putAudio(editor.map.soundId, file);
            if (editor.music.isPlaying)
                editor.pauseMusic();
            try {
                await this.music.load(file);
                editor.map.duration = this.music.duration * 1000;
                this.music.setTempo(editor.map.tempo);
                editor.toast('AUDIO REPLACED');
            } catch (e) {
                this.dialogs.message(e.message);
            }
        }

        // ------------------------------------------------------------ playtest (GuiWindowEditor.Playtest + the web player)

        async playtest(editor, fromStart, autoplay) {
            if (!window.SSQEGame) {
                this.dialogs.message('The web player could not be loaded. Make sure the "Web Player" folder sits next to the "Web Editor" folder.');
                return;
            }
            if (editor.music.isPlaying)
                editor.pauseMusic();

            const map = editor.map;
            const s = this.settings;
            const ps = SSQESettings.load();
            Object.assign(ps, {
                tempo: map.tempoSlider,
                masterVolume: s.masterVolume,
                sfxVolume: s.sfxVolume,
                musicOffset: s.musicOffset,
                noteColors: s.noteColors,
                color1: s.color1,
                color2: s.color2,
                smoothAutoplay: s.smoothAutoplay,
                monoAudio: s.monoAudio,
                muteSfx: s.muteSfx,
                maxPolyphony: s.maxPolyphony,
            });

            const blob = await this.storage.getAudio(map.soundId);
            const audioElement = await new Promise((resolve, reject) => {
                const a = new Audio();
                a.preload = 'auto';
                a.onloadedmetadata = () => resolve(a);
                a.onerror = () => reject(new Error('audio failed to load'));
                a.src = URL.createObjectURL(blob);
            }).catch(() => null);

            if (ps.fullscreenPlayer && !document.fullscreenElement)
                document.documentElement.requestFullscreen().catch(() => { });

            editor.suspend();
            document.body.classList.add('playtesting');

            const finish = () => {
                document.body.classList.remove('playtesting');
                if (audioElement)
                    URL.revokeObjectURL(audioElement.src);
                if (document.fullscreenElement)
                    document.exitFullscreen().catch(() => { });
                editor.resume();
            };

            try {
                const game = new SSQEGame.Game({
                    canvas: document.getElementById('game'),
                    overlay: document.getElementById('overlay'),
                    settings: ps,
                    mapText: Formats.writeTxt(map),
                    audioElement,
                    audioCtx: SSQE.Audio.audioContext(),
                    hitBuffer: null,
                    replayBuffer: null,
                    mode: autoplay ? 'autoplay' : 'play',
                    fromStart,
                    startTime: editor.currentTime,
                    onExit: finish,
                });
                game.sound.buffer = await this.hitBuffer();
                game.start();
                if (!autoplay)
                    game.lockPointer();
            } catch (e) {
                finish();
                this.dialogs.message(`Failed to start the player: ${e.message}`);
            }
        }

        async hitBuffer() {
            await SSQE.Audio.loadSounds();
            const ac = SSQE.Audio.audioContext();
            try {
                const res = await fetch(window.SSQE_SOUNDS.hit);
                return await ac.decodeAudioData(await res.arrayBuffer());
            } catch {
                return null;
            }
        }
    }

    SSQE.App = App;

    window.addEventListener('DOMContentLoaded', () => {
        const app = new App();
        window.ssqeApp = app;
        app.init();
    });
})();
