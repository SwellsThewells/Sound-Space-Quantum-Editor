'use strict';

// Port of NewGUI/Forms (TimingsWindow, BookmarksWindow, ExportSSPM, BPMTapper) and NewGUI/Dialogs (MessageDialog)
(function () {
    const { TimingPoint, Bookmark, Timing, DIFFICULTIES } = SSQE;
    const el = (...a) => SSQE.el(...a);

    class Dialogs {
        constructor(app) {
            this.app = app;
            this.layer = document.getElementById('dialog-layer');
            this.modals = 0;
            this.windows = {};
        }

        isModalOpen() {
            return this.modals > 0;
        }

        // ------------------------------------------------------------ generic modal dialogs

        modal(title, body, buttons, opts = {}) {
            return new Promise(resolve => {
                const overlay = el('div', { class: 'dlg-overlay' });
                const close = value => {
                    overlay.remove();
                    this.modals--;
                    document.removeEventListener('keydown', onKey, true);
                    resolve(value);
                };
                const onKey = e => {
                    if (e.key === 'Escape') {
                        e.stopPropagation();
                        close(opts.cancelValue ?? null);
                    } else if (e.key === 'Enter' && opts.enterValue !== undefined && e.target.tagName !== 'TEXTAREA') {
                        e.stopPropagation();
                        close(typeof opts.enterValue === 'function' ? opts.enterValue() : opts.enterValue);
                    }
                };

                const box = el('div', { class: 'dlg-box' + (opts.wide ? ' wide' : '') },
                    el('div', { class: 'dlg-title' }, title),
                    el('div', { class: 'dlg-body' }, body),
                    el('div', { class: 'dlg-buttons' }, buttons.map(([text, value, cls]) =>
                        el('button', { class: `ss-button ${cls || ''}`, type: 'button', onclick: () => close(typeof value === 'function' ? value() : value) }, text))),
                );
                overlay.append(box);
                this.layer.append(overlay);
                this.modals++;
                document.addEventListener('keydown', onKey, true);

                const focus = box.querySelector('input, textarea, select') || box.querySelector('button');
                setTimeout(() => focus && focus.focus(), 0);
            });
        }

        message(text, title = 'Sound Space Quantum Editor') {
            return this.modal(title, el('pre', { class: 'dlg-text' }, text), [['OK', true]], { enterValue: true });
        }

        confirm(text, buttons = [['Yes', 'yes'], ['No', 'no']], title = 'Sound Space Quantum Editor') {
            return this.modal(title, el('pre', { class: 'dlg-text' }, text), buttons, { cancelValue: 'cancel' });
        }

        prompt(title, label, value = '', multiline = false) {
            const input = multiline ? el('textarea', { class: 'ss-input dlg-textarea' }) : el('input', { type: 'text', class: 'ss-input' });
            input.value = value;
            return this.modal(title, el('div', {}, el('div', { class: 'ss-label' }, label), input),
                [['OK', () => input.value, 'primary'], ['Cancel', null]], { enterValue: multiline ? undefined : () => input.value });
        }

        // ------------------------------------------------------------ floating windows (non-modal)

        floating(id, title, body, onClose) {
            this.windows[id]?.close();

            const win = el('div', { class: 'dlg-window' },
                el('div', { class: 'dlg-title' }, title, el('button', { class: 'dlg-x', type: 'button', onclick: () => close() }, '✕')),
                el('div', { class: 'dlg-body' }, body));

            const close = () => {
                win.remove();
                delete this.windows[id];
                onClose && onClose();
            };

            // drag by the title bar
            const titleBar = win.firstChild;
            titleBar.addEventListener('mousedown', e => {
                if (e.target.tagName === 'BUTTON')
                    return;
                const rect = win.getBoundingClientRect();
                const dx = e.clientX - rect.left, dy = e.clientY - rect.top;
                const move = ev => {
                    win.style.left = Math.max(0, ev.clientX - dx) + 'px';
                    win.style.top = Math.max(0, ev.clientY - dy) + 'px';
                };
                const up = () => {
                    window.removeEventListener('mousemove', move);
                    window.removeEventListener('mouseup', up);
                };
                window.addEventListener('mousemove', move);
                window.addEventListener('mouseup', up);
            });

            this.layer.append(win);
            this.windows[id] = { close, win };
            return this.windows[id];
        }

        closeAll() {
            for (const w of Object.values(this.windows))
                w.close();
        }

        // ------------------------------------------------------------ BPM setup (TimingsWindow)

        timings(editor) {
            const map = editor.map;
            const s = editor.settings;

            const list = el('select', { class: 'dlg-list', multiple: 'multiple', size: 10 });
            const bpmBox = el('input', { type: 'number', class: 'ss-input', step: 'any' });
            const offsetBox = el('input', { type: 'number', class: 'ss-input', step: '1' });
            const moveBox = el('input', { type: 'number', class: 'ss-input', step: '1', value: '0' });
            const adjust = el('input', { type: 'checkbox' });
            adjust.checked = s.adjustNotes;
            adjust.addEventListener('change', () => {
                s.adjustNotes = adjust.checked;
                SSQE.Settings.save(s);
            });

            let lastVersion = -1;
            const selectedPoints = () => [...list.selectedOptions].map(o => map.timingPoints[+o.value]).filter(Boolean);

            const resetList = () => {
                const selected = new Set(selectedPoints());
                list.innerHTML = '';
                map.timingPoints.forEach((p, i) => {
                    const o = el('option', { value: i }, `${+p.bpm.toFixed(3)} BPM  —  ${p.ms} ms`);
                    o.selected = selected.has(p) || p === map.selectedPoint;
                    list.append(o);
                });
                lastVersion = map.version;
            };

            list.addEventListener('change', () => {
                const p = selectedPoints()[0];
                if (p) {
                    bpmBox.value = p.bpm;
                    offsetBox.value = p.ms;
                }
            });

            offsetBox.addEventListener('change', () => {
                const v = parseInt(offsetBox.value, 10);
                if (Number.isFinite(v))
                    offsetBox.value = Math.min(v, Math.trunc(map.duration));
            });

            const add = () => {
                const bpm = parseFloat(bpmBox.value), ms = parseInt(offsetBox.value, 10);
                if (!Number.isFinite(bpm) || !Number.isFinite(ms) || map.timingPoints.some(p => p.ms === ms))
                    return;
                map.replacePoints('ADD POINT', [], [new TimingPoint(bpm, ms)]);
            };

            const update = () => {
                const point = selectedPoints()[0];
                const bpm = parseFloat(bpmBox.value), ms = parseInt(offsetBox.value, 10);
                if (!point || !Number.isFinite(bpm) || !Number.isFinite(ms))
                    return;
                if (map.timingPoints.some(p => p.ms === ms && p !== point))
                    return;
                if (s.adjustNotes)
                    Timing.updatePoint(map, point, bpm);
                map.editPoints('EDIT POINT', [point], n => {
                    n.bpm = bpm;
                    n.ms = ms;
                });
            };

            const del = () => {
                const points = selectedPoints();
                if (points.length)
                    map.replacePoints('DELETE POINT[S]', points, []);
            };

            const move = () => {
                const offset = parseInt(moveBox.value, 10);
                const points = selectedPoints();
                if (!Number.isFinite(offset) || offset === 0 || !points.length)
                    return;
                map.editPoints('MOVE POINT[S]', points, n => n.ms += offset);
                if (s.adjustNotes)
                    Timing.movePoints(map, points, offset);
            };

            const setPoints = points => {
                map.replacePoints('IMPORT POINTS', map.timingPoints, points);
            };

            const pasteOsu = async () => {
                const text = await this.app.readClipboard('Paste osu! [TimingPoints]');
                if (text)
                    this.tryParse('OSU', () => setPoints(parseOsuTiming(text)));
            };

            const pasteCh = async () => {
                const text = await this.app.readClipboard('Paste a Clone Hero .chart');
                if (text)
                    this.tryParse('CH', () => setPoints(parseChTiming(text)));
            };

            const openBeatmap = async () => {
                const file = await this.app.pickFile('.osu,.chart');
                if (!file)
                    return;
                const text = await file.text();
                if (file.name.toLowerCase().endsWith('.chart'))
                    this.tryParse('CH', () => setPoints(parseChTiming(text)));
                else
                    this.tryParse('OSU', () => setPoints(parseOsuTiming(text)));
            };

            const body = el('div', { class: 'timings' },
                list,
                el('div', { class: 'dlg-grid2' },
                    el('label', {}, 'BPM', bpmBox),
                    el('label', {}, 'Offset (ms)', offsetBox)),
                el('div', { class: 'dlg-row' },
                    btn('Add', add), btn('Update', update), btn('Delete', del),
                    btn('Current Pos', () => offsetBox.value = Math.trunc(editor.currentTime))),
                el('div', { class: 'dlg-grid2' },
                    el('label', {}, 'Move Selected Points (ms)', moveBox),
                    el('div', { class: 'dlg-bottom' }, btn('Move', move))),
                el('label', { class: 'ss-check' }, adjust, el('span', {}, 'Adjust notes when changing points')),
                el('div', { class: 'dlg-row' },
                    btn('BPM Tapper', () => this.tapper()),
                    btn('Paste osu! Timing', pasteOsu),
                    btn('Paste .chart', pasteCh),
                    btn('Open Beatmap', openBeatmap)),
            );

            const win = this.floating('timings', 'BPM Setup', body, () => clearInterval(timer));
            const timer = setInterval(() => {
                if (map.version !== lastVersion)
                    resetList();
            }, 100);

            resetList();
            const current = Timing.getCurrentBpm(map, editor.currentTime);
            const index = map.timingPoints.indexOf(current);
            if (index >= 0) {
                list.options[index].selected = true;
                bpmBox.value = current.bpm;
                offsetBox.value = current.ms;
            } else if (map.timingPoints.length) {
                bpmBox.value = map.timingPoints[0].bpm;
                offsetBox.value = map.timingPoints[0].ms;
            }
            return win;
        }

        tryParse(kind, fn) {
            try {
                fn();
            } catch (e) {
                console.warn(e);
                this.message(`Failed to parse beatmap\n[ ${kind} : ${e.name} ]`);
            }
        }

        // BPMTapper
        tapper() {
            let taps = 0, tapping = false, start = 0;
            const bpmLabel = el('div', { class: 'tap-bpm' }, '');
            const decLabel = el('div', { class: 'tap-dec' }, '');
            const decimals = el('input', { type: 'number', class: 'ss-input', value: '2', min: '0', max: '6' });

            const reset = () => {
                taps = 0;
                tapping = false;
                bpmLabel.textContent = '';
                decLabel.textContent = '';
            };

            const tap = () => {
                taps++;
                if (!tapping) {
                    tapping = true;
                    start = performance.now();
                    bpmLabel.textContent = '0';
                    decLabel.textContent = '0';
                } else {
                    const d = parseInt(decimals.value, 10) || 0;
                    const mins = (performance.now() - start) / 60000;
                    const bpm = (taps - 1) / mins;
                    bpmLabel.textContent = Math.round(bpm);
                    decLabel.textContent = bpm.toFixed(d);
                }
            };

            const tapButton = btn('TAP', tap, 'primary tap-button');
            const body = el('div', { class: 'tapper', tabindex: '0' },
                bpmLabel, decLabel,
                tapButton,
                el('div', { class: 'dlg-row' }, btn('Reset', reset), el('label', {}, 'Decimals ', decimals)),
                el('div', { class: 'ss-label' }, 'Click TAP or press any key while this window is focused.'));

            body.addEventListener('keydown', e => {
                if (e.target === decimals || e.repeat)
                    return;
                e.preventDefault();
                e.stopPropagation();
                tap();
            });

            this.floating('tapper', 'BPM Tapper', body);
            setTimeout(() => body.focus(), 0);
        }

        // ------------------------------------------------------------ bookmarks (BookmarksWindow)

        bookmarks(editor) {
            const map = editor.map;
            const list = el('select', { class: 'dlg-list', multiple: 'multiple', size: 10 });
            const textBox = el('input', { type: 'text', class: 'ss-input' });
            const startBox = el('input', { type: 'number', class: 'ss-input', step: '1' });
            const endBox = el('input', { type: 'number', class: 'ss-input', step: '1' });

            let lastVersion = -1;
            const selected = () => [...list.selectedOptions].map(o => map.bookmarks[+o.value]).filter(Boolean);

            const resetList = () => {
                const sel = new Set(selected());
                list.innerHTML = '';
                map.bookmarks.forEach((b, i) => {
                    const o = el('option', { value: i }, `${b.text}  —  ${b.ms}${b.endMs !== b.ms ? `-${b.endMs}` : ''} ms`);
                    o.selected = sel.has(b);
                    list.append(o);
                });
                lastVersion = map.version;
            };

            list.addEventListener('change', () => {
                const b = selected()[0];
                if (b) {
                    textBox.value = b.text;
                    startBox.value = b.ms;
                    endBox.value = b.endMs;
                }
            });
            list.addEventListener('dblclick', () => {
                const b = selected()[0];
                if (b) {
                    if (editor.music.isPlaying)
                        editor.pauseMusic();
                    editor.currentTime = b.ms;
                }
            });

            const add = () => {
                const ms = parseInt(startBox.value, 10), end = parseInt(endBox.value, 10);
                if (!Number.isFinite(ms) || !Number.isFinite(end))
                    return;
                if (map.bookmarks.some(b => b.text === textBox.value && b.ms === ms && b.endMs === end))
                    return;
                map.replaceBookmarks('ADD BOOKMARK', [], [new Bookmark(textBox.value || '', ms, end)]);
            };

            const update = () => {
                const b = selected()[0];
                const ms = parseInt(startBox.value, 10), end = parseInt(endBox.value, 10);
                if (!b || !Number.isFinite(ms) || !Number.isFinite(end))
                    return;
                map.editBookmarks('EDIT BOOKMARK', [b], n => {
                    n.text = textBox.value;
                    n.ms = ms;
                    n.endMs = end;
                });
            };

            const del = () => {
                const b = selected();
                if (b.length)
                    map.replaceBookmarks('DELETE BOOKMARK[S]', b, []);
            };

            const currentPos = () => {
                const t = Math.trunc(editor.currentTime);
                if (startBox.value !== endBox.value)
                    startBox.value = t;
                endBox.value = t;
            };

            const body = el('div', { class: 'bookmarks' },
                list,
                el('label', {}, 'Text', textBox),
                el('div', { class: 'dlg-grid2' },
                    el('label', {}, 'Start (ms)', startBox),
                    el('label', {}, 'End (ms)', endBox)),
                el('div', { class: 'dlg-row' }, btn('Add', add), btn('Update', update), btn('Delete', del), btn('Current Pos', currentPos)),
                el('div', { class: 'ss-label' }, 'Double-click a bookmark to jump to it.'),
            );

            const win = this.floating('bookmarks', 'Bookmarks', body, () => clearInterval(timer));
            const timer = setInterval(() => {
                if (map.version !== lastVersion)
                    resetList();
            }, 100);
            resetList();
            startBox.value = endBox.value = Math.trunc(editor.currentTime);
            return win;
        }

        // ------------------------------------------------------------ SSPM export (ExportSSPM)

        async exportSspm(editor) {
            const map = editor.map;
            const p = map.props;

            const idBox = el('input', { type: 'text', class: 'ss-input', value: map.soundId });
            const nameBox = el('input', { type: 'text', class: 'ss-input', value: p.songName });
            const diffBox = el('select', { class: 'ss-input' }, DIFFICULTIES.map(d => el('option', { value: d }, d)));
            diffBox.value = p.difficulty || 'N/A';
            const customBox = el('input', { type: 'text', class: 'ss-input', value: p.customDifficulty });
            const mapperBox = el('textarea', { class: 'ss-input dlg-textarea' });
            mapperBox.value = p.mappers;
            const useCover = el('input', { type: 'checkbox' });
            useCover.checked = p.useCover;
            const coverInput = el('input', { type: 'file', accept: 'image/png,image/jpeg' });
            const coverLabel = el('span', { class: 'ss-label' }, map.coverBytes ? 'Using cover from the loaded map' : 'Default cover');

            const body = el('div', { class: 'export' },
                el('label', {}, 'Map ID', idBox),
                el('label', {}, 'Song Name', nameBox),
                el('div', { class: 'dlg-grid2' },
                    el('label', {}, 'Difficulty', diffBox),
                    el('label', {}, 'Custom Difficulty', customBox)),
                el('label', {}, 'Mappers (one per line)', mapperBox),
                el('label', { class: 'ss-check' }, useCover, el('span', {}, 'Include cover')),
                el('div', { class: 'dlg-row' }, coverInput, coverLabel),
            );

            const result = await this.modal('Export SSPM', body, [['Export', 'export', 'primary'], ['Cancel', null]], { wide: true });
            if (result !== 'export')
                return;

            p.songName = nameBox.value;
            p.difficulty = diffBox.value;
            p.customDifficulty = customBox.value;
            p.mappers = mapperBox.value;
            p.useCover = useCover.checked;
            editor.onMapChanged();

            let cover = null;
            if (useCover.checked) {
                if (coverInput.files[0]) {
                    cover = new Uint8Array(await coverInput.files[0].arrayBuffer());
                    map.coverBytes = cover;
                } else if (map.coverBytes)
                    cover = map.coverBytes;
                else {
                    try {
                        cover = new Uint8Array(await (await fetch('assets/Cover.png')).arrayBuffer());
                    } catch {
                        this.message('The default cover could not be loaded (open the editor through a web server, or choose a cover image). Exporting without a cover.');
                    }
                }
            }

            const id = SSQE.Formats.fixId(idBox.value.trim() || map.soundId);
            const audio = await this.app.storage.getAudio(map.soundId);
            if (!audio) {
                this.message('No audio is loaded for this map.');
                return;
            }

            const mappers = mapperBox.value.split('\n').map(m => m.trim()).filter(Boolean);
            const bytes = SSQE.Formats.writeSspm(map, {
                songId: id,
                mapName: nameBox.value,
                mappers: (mappers.length ? mappers : ['None']).join('\n'),
                difficulty: diffBox.value,
                customDifficulty: customBox.value,
            }, new Uint8Array(await audio.arrayBuffer()), cover);

            this.app.download(new Blob([bytes], { type: 'application/octet-stream' }), `${id}.sspm`);
            editor.toast('EXPORTED SSPM');
        }

        // ------------------------------------------------------------ save as

        saveAs(map, canUseFolders) {
            const nameBox = el('input', { type: 'text', class: 'ss-input', value: map.fileId });
            const info = canUseFolders
                ? 'Choose a folder to save the map (.txt) and its properties (.ini) into. Later saves go to the same files.'
                : 'Your browser can\'t write to folders, so the map (.txt) and its properties (.ini) will be downloaded.';
            const buttons = canUseFolders
                ? [['Choose Folder', () => ({ name: nameBox.value, mode: 'folder' }), 'primary'], ['Download', () => ({ name: nameBox.value, mode: 'download' })], ['Cancel', null]]
                : [['Download', () => ({ name: nameBox.value, mode: 'download' }), 'primary'], ['Cancel', null]];

            return this.modal('Save Map As', el('div', {}, el('label', {}, 'File name', nameBox), el('div', { class: 'ss-label' }, info)), buttons,
                { enterValue: () => ({ name: nameBox.value, mode: canUseFolders ? 'folder' : 'download' }) });
        }
    }

    function btn(text, onClick, cls = '') {
        return el('button', { class: `ss-button ${cls}`, type: 'button', onclick: onClick }, text);
    }

    // TimingsWindow.ParseOSU
    function parseOsuTiming(data) {
        data = data.replace(/\r\n/g, '\n');
        if (data.includes('TimingPoints')) {
            data = data.slice(data.indexOf('TimingPoints') + 13);
            if (data.includes('['))
                data = data.slice(0, data.indexOf('['));
        }

        const points = [];
        for (const line of data.split('\n')) {
            if (!line.includes(','))
                continue;
            const s = line.split(',');
            const time = Math.trunc(parseFloat(s[0]));
            let bpm = parseFloat(s[1]);
            if (!Number.isFinite(time) || !Number.isFinite(bpm))
                throw new SyntaxError('FormatException');
            const inherited = s.length > 6 ? s[6].trim() === '1' : bpm > 0;
            bpm = Math.abs(Math.round(60000 / bpm * 1000) / 1000);
            if (bpm > 0 && inherited)
                points.push(new TimingPoint(bpm, time));
        }
        return points;
    }

    // TimingsWindow.ParseCH
    function parseChTiming(data) {
        data = data.replace(/\r\n/g, '\n');
        let res = data.slice(data.indexOf('Resolution'));
        res = res.slice(0, res.indexOf('\n')).replace('Resolution = ', '');
        const resolution = parseFloat(res);
        if (!Number.isFinite(resolution))
            throw new SyntaxError('FormatException');

        data = data.slice(data.indexOf('SyncTrack'));
        data = data.slice(0, data.indexOf('}')).replace('SyncTrack]\n{', '');

        const bpms = [], times = [], ms = [];
        for (const line of data.split('\n')) {
            if (!line.includes(' B '))
                continue;
            bpms.push(parseFloat(line.slice(line.indexOf(' B ') + 3)) / 1000);
            times.push(parseFloat(line.slice(0, line.indexOf(' B ')).replace(' =', '')));
        }

        for (let i = 0; i < times.length; i++) {
            if (i > 0) {
                const diff = Math.round(1000 * ((times[i] - times[i - 1]) / (bpms[i - 1] * resolution / 60)) * 100) / 100;
                ms.push(diff + ms[i - 1]);
            } else
                ms.push(times[i]);
        }

        return ms.map((m, i) => new TimingPoint(bpms[i], Math.trunc(m)));
    }

    SSQE.Dialogs = Dialogs;
})();
