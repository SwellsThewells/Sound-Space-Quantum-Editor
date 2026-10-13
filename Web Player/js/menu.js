'use strict';

(function () {
    const $ = id => document.getElementById(id);

    let settings = SSQESettings.load();
    let audioFile = null;
    let replayBuffer = null;
    let audioCtx = null;
    let hitBuffer = null;
    let game = null;

    // ---------------------------------------------------------------- settings UI

    const toHex = c => '#' + c.map(n => Math.round(n).toString(16).padStart(2, '0')).join('');
    const fromHex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));

    function buildSettings() {
        const root = $('settings');
        root.innerHTML = '';

        for (const [title, items] of SSQESettings.SCHEMA) {
            const h = document.createElement('h3');
            h.textContent = title;
            root.appendChild(h);

            for (const item of items) {
                const row = document.createElement('label');
                row.className = 'field';
                const name = document.createElement('span');
                name.textContent = item.label;
                const control = document.createElement('span');
                control.className = 'control';
                row.append(name, control);

                const value = settings[item.key];

                if (item.type === 'bool') {
                    const input = document.createElement('input');
                    input.type = 'checkbox';
                    input.checked = value;
                    input.addEventListener('change', () => update(item.key, input.checked));
                    control.appendChild(input);
                } else if (item.type === 'select') {
                    const select = document.createElement('select');
                    for (const opt of item.options) {
                        const o = document.createElement('option');
                        o.value = o.textContent = opt;
                        select.appendChild(o);
                    }
                    select.value = value;
                    select.addEventListener('change', () => update(item.key, select.value));
                    control.appendChild(select);
                } else if (item.type === 'range') {
                    const input = document.createElement('input');
                    input.type = 'range';
                    input.min = item.min;
                    input.max = item.max;
                    input.step = item.step;
                    input.value = value;
                    const out = document.createElement('output');
                    const fmt = item.format || (v => String(v));
                    out.textContent = fmt(value);
                    input.addEventListener('input', () => {
                        const v = parseFloat(input.value);
                        out.textContent = fmt(v);
                        update(item.key, v);
                    });
                    control.append(input, out);
                } else if (item.type === 'number') {
                    const input = document.createElement('input');
                    input.type = 'number';
                    if (item.min !== undefined) input.min = item.min;
                    if (item.max !== undefined) input.max = item.max;
                    input.step = item.step;
                    input.value = value;
                    input.addEventListener('change', () => {
                        let v = parseFloat(input.value);
                        if (!Number.isFinite(v))
                            v = SSQESettings.DEFAULTS[item.key];
                        if (item.min !== undefined) v = Math.max(item.min, v);
                        if (item.max !== undefined) v = Math.min(item.max, v);
                        input.value = v;
                        update(item.key, v);
                    });
                    control.appendChild(input);
                } else if (item.type === 'color') {
                    const input = document.createElement('input');
                    input.type = 'color';
                    input.value = toHex(value);
                    input.addEventListener('input', () => update(item.key, fromHex(input.value)));
                    control.appendChild(input);
                } else if (item.type === 'colorlist') {
                    const list = document.createElement('span');
                    list.className = 'colorlist';
                    const render = () => {
                        list.innerHTML = '';
                        settings.noteColors.forEach((c, i) => {
                            const input = document.createElement('input');
                            input.type = 'color';
                            input.value = toHex(c);
                            input.title = 'Right-click to remove';
                            input.addEventListener('input', () => {
                                settings.noteColors[i] = fromHex(input.value);
                                SSQESettings.save(settings);
                            });
                            input.addEventListener('contextmenu', e => {
                                e.preventDefault();
                                if (settings.noteColors.length > 1) {
                                    settings.noteColors.splice(i, 1);
                                    SSQESettings.save(settings);
                                    render();
                                }
                            });
                            list.appendChild(input);
                        });
                        const add = document.createElement('button');
                        add.className = 'small';
                        add.type = 'button';
                        add.textContent = '+';
                        add.title = 'Add colour';
                        add.addEventListener('click', e => {
                            e.preventDefault();
                            settings.noteColors.push([255, 255, 255]);
                            SSQESettings.save(settings);
                            render();
                        });
                        list.appendChild(add);
                    };
                    render();
                    control.appendChild(list);
                }

                root.appendChild(row);
            }
        }
    }

    function update(key, value) {
        settings[key] = value;
        SSQESettings.save(settings);
    }

    $('btn-defaults').addEventListener('click', () => {
        settings = SSQESettings.clone(SSQESettings.DEFAULTS);
        SSQESettings.save(settings);
        buildSettings();
        setStatus('settings-status', 'Settings reset to defaults', 'ok');
    });

    $('btn-import').addEventListener('click', () => $('settings-file').click());
    $('settings-file').addEventListener('change', async e => {
        const file = e.target.files[0];
        e.target.value = '';
        if (!file)
            return;
        try {
            const count = SSQESettings.applyObject(settings, JSON.parse(await file.text()), true);
            SSQESettings.save(settings);
            buildSettings();
            setStatus('settings-status', `Imported ${count} settings from ${file.name}`, 'ok');
        } catch (err) {
            setStatus('settings-status', `Failed to load settings: ${err.message}`, 'err');
        }
    });

    // ---------------------------------------------------------------- map / audio / replay inputs

    function setStatus(id, text, cls = '') {
        const el = $(id);
        el.textContent = text;
        el.className = 'status ' + cls;
    }

    function validateMap() {
        const text = $('map-text').value;
        if (!text.trim()) {
            setStatus('map-status', 'No map loaded');
            return null;
        }
        try {
            const { id, notes } = SSQEGame.parseMap(text, settings.noteColors);
            const last = notes.length ? notes[notes.length - 1].Ms : 0;
            setStatus('map-status', `${notes.length} notes · id "${id}" · length ${formatTime(last)}`, 'ok');
            return notes;
        } catch (err) {
            setStatus('map-status', err.message, 'err');
            return null;
        }
    }

    function formatTime(ms) {
        const m = Math.trunc(ms / 60000);
        const s = Math.trunc(ms % 60000 / 1000);
        return `${m}:${String(s).padStart(2, '0')}`;
    }

    function parseStartTime(text) {
        text = text.trim();
        if (text.includes(':')) {
            const [m, s] = text.split(':');
            return (parseFloat(m) || 0) * 60000 + (parseFloat(s) || 0) * 1000;
        }
        return parseFloat(text) || 0;
    }

    async function loadMapFile(file) {
        $('map-text').value = await file.text();
        validateMap();
    }

    function loadAudioFile(file) {
        audioFile = file;
        setStatus('audio-status', `${file.name} (${(file.size / 1048576).toFixed(1)} MB)`, 'ok');
    }

    async function loadReplayFile(file) {
        try {
            const buffer = await file.arrayBuffer();
            const r = SSQEGame.parseReplay(buffer);
            replayBuffer = buffer;
            setStatus('replay-status', `${file.name} · ${r.cursor.length} cursor nodes · tempo ${Math.round(r.tempo * 100)}%`, 'ok');
        } catch (err) {
            replayBuffer = null;
            setStatus('replay-status', `Invalid replay: ${err.message}`, 'err');
        }
        $('btn-replay').disabled = !replayBuffer;
    }

    $('map-file').addEventListener('change', e => e.target.files[0] && loadMapFile(e.target.files[0]));
    $('audio-file').addEventListener('change', e => e.target.files[0] && loadAudioFile(e.target.files[0]));
    $('replay-file').addEventListener('change', e => e.target.files[0] && loadReplayFile(e.target.files[0]));
    $('map-text').addEventListener('input', validateMap);
    $('from-start').addEventListener('change', () => $('start-time').disabled = $('from-start').checked);

    // drag & drop anywhere on the menu
    let dragDepth = 0;
    window.addEventListener('dragenter', e => { e.preventDefault(); if (!game) { dragDepth++; $('drop').classList.add('show'); } });
    window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('drop').classList.remove('show'); } });
    window.addEventListener('dragover', e => e.preventDefault());
    window.addEventListener('drop', e => {
        e.preventDefault();
        dragDepth = 0;
        $('drop').classList.remove('show');
        if (game)
            return;
        for (const file of e.dataTransfer.files) {
            const name = file.name.toLowerCase();
            if (name.endsWith('.qer'))
                loadReplayFile(file);
            else if (name.endsWith('.txt') && !file.type.startsWith('audio'))
                loadMapFile(file);
            else
                loadAudioFile(file);
        }
    });

    $('btn-demo').addEventListener('click', () => {
        const notes = [];
        let x = 1, y = 1;
        const beat = 60000 / 130;
        for (let i = 0; i < 160; i++) {
            const step = i % 16 === 15 ? 2 : 1;
            for (let k = 0; k < step; k++) {
                x = Math.max(0, Math.min(2, x + Math.round(Math.random() * 2 - 1)));
                y = Math.max(0, Math.min(2, y + Math.round(Math.random() * 2 - 1)));
            }
            notes.push(`${x}|${y}|${Math.round(1000 + i * beat / (i % 32 < 16 ? 1 : 2))}`);
        }
        $('map-text').value = 'demo,' + notes.join(',');
        validateMap();
    });

    // ---------------------------------------------------------------- starting a game

    async function ensureAudio() {
        if (!audioCtx)
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === 'suspended')
            await audioCtx.resume().catch(() => { });
        if (!hitBuffer) {
            try {
                const res = await fetch(window.SSQE_HIT_WAV);
                hitBuffer = await audioCtx.decodeAudioData(await res.arrayBuffer());
            } catch {
                hitBuffer = null;
            }
        }
    }

    function loadAudioElement(file) {
        return new Promise((resolve, reject) => {
            const el = new Audio();
            el.preload = 'auto';
            el.onloadedmetadata = () => resolve(el);
            el.onerror = () => reject(new Error(`${file.name} could not be decoded by this browser`));
            el.src = URL.createObjectURL(file);
        });
    }

    async function start(mode) {
        if (game)
            return;
        if (!validateMap())
            return;
        if (mode === 'replay' && !replayBuffer)
            return;

        // must happen synchronously inside the click for the browser to allow it
        if (settings.fullscreenPlayer && !document.fullscreenElement)
            document.documentElement.requestFullscreen().catch(() => { });

        await ensureAudio();

        let audioElement = null;
        if (audioFile) {
            try {
                audioElement = await loadAudioElement(audioFile);
            } catch (err) {
                setStatus('audio-status', err.message, 'err');
                if (document.fullscreenElement)
                    document.exitFullscreen().catch(() => { });
                return;
            }
        }

        if (document.activeElement)
            document.activeElement.blur();
        $('results').classList.remove('show');
        document.body.classList.add('playing');

        try {
            game = new SSQEGame.Game({
                canvas: $('game'),
                overlay: $('overlay'),
                settings: SSQESettings.clone(settings),
                mapText: $('map-text').value,
                audioElement,
                audioCtx,
                hitBuffer,
                replayBuffer: mode === 'replay' ? replayBuffer : null,
                mode,
                fromStart: $('from-start').checked,
                startTime: parseStartTime($('start-time').value),
                onExit: results => finish(results, audioElement),
            });
        } catch (err) {
            document.body.classList.remove('playing');
            setStatus('map-status', `Failed to start: ${err.message}`, 'err');
            if (audioElement)
                URL.revokeObjectURL(audioElement.src);
            return;
        }

        game.start();
        if (mode === 'play')
            game.lockPointer();
    }

    function finish(results, audioElement) {
        game = null;
        document.body.classList.remove('playing');
        if (document.fullscreenElement)
            document.exitFullscreen().catch(() => { });
        if (audioElement)
            URL.revokeObjectURL(audioElement.src);

        const stats = [
            ['Accuracy', results.accuracy],
            ['Hits', results.hits],
            ['Misses', results.misses],
            ['Max combo', results.maxCombo],
            ['Pauses', results.pauses],
            ['Mode', results.mode],
        ];
        $('results-stats').innerHTML = '';
        for (const [label, value] of stats) {
            const d = document.createElement('div');
            d.className = 'stat';
            const b = document.createElement('b');
            b.textContent = value;
            const s = document.createElement('span');
            s.textContent = label;
            d.append(b, s);
            $('results-stats').appendChild(d);
        }
        $('results').classList.add('show');
    }

    $('btn-play').addEventListener('click', () => start('play'));
    $('btn-auto').addEventListener('click', () => start('autoplay'));
    $('btn-replay').addEventListener('click', () => start('replay'));

    buildSettings();
})();
