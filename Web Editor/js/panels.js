'use strict';

// Port of GuiWindowEditor.Controls.cs - the side panels of the editor, built as HTML on top of the canvas stage
(function () {
    const { RenderMode, ObjectMode, Lyric, Note, Timing, clamp, EASING_STYLES } = SSQE;

    function el(tag, attrs = {}, ...children) {
        const e = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs)) {
            if (k === 'class')
                e.className = v;
            else if (k === 'style')
                Object.assign(e.style, v);
            else if (k.startsWith('on'))
                e.addEventListener(k.slice(2), v);
            else
                e.setAttribute(k, v);
        }
        for (const c of children.flat())
            if (c != null)
                e.append(c);
        return e;
    }

    class Panels {
        constructor(editor) {
            this.editor = editor;
            this.app = editor.app;
            this.settings = editor.settings;
            this.map = editor.map;
            this.root = document.getElementById('editor-panels');
            this.root.innerHTML = '';
            this.refreshers = [];
            this.left = this.settings.lastLeftNav || null;
            this.right = this.settings.lastRightNav || null;
            this.build();
            this.refresh();
        }

        destroy() {
            this.root.innerHTML = '';
        }

        save() {
            SSQE.Settings.save(this.settings);
        }

        // ------------------------------------------------------------ control helpers

        button(text, onClick, cls = '') {
            return el('button', { class: `ss-button ${cls}`, type: 'button', onclick: e => onClick(e) }, text);
        }

        checkbox(text, key, onChange) {
            const input = el('input', { type: 'checkbox' });
            input.addEventListener('change', () => {
                this.settings[key] = input.checked;
                this.save();
                onChange && onChange(input.checked);
                this.editor.settingsChanged();
            });
            this.refreshers.push(() => input.checked = !!this.settings[key]);
            return el('label', { class: 'ss-check' }, input, el('span', {}, text));
        }

        // a numeric textbox bound to a getter/setter
        numberBox(get, set, opts = {}) {
            const input = el('input', { type: 'number', class: 'ss-input', step: opts.step ?? 'any' });
            if (opts.width)
                input.style.width = opts.width;
            input.addEventListener('change', () => {
                const v = parseFloat(input.value);
                if (Number.isFinite(v))
                    set(v);
                input.value = get();
            });
            input.addEventListener('keydown', e => {
                if (e.key === 'Enter')
                    input.blur();
            });
            this.refreshers.push(() => {
                if (document.activeElement !== input)
                    input.value = get();
            });
            return input;
        }

        slider(get, set, min, max, step, labelFn) {
            const label = el('div', { class: 'ss-label' });
            const input = el('input', { type: 'range', class: 'ss-range', min, max, step });
            input.addEventListener('input', () => {
                set(parseFloat(input.value));
                label.textContent = labelFn(get());
            });
            input.addEventListener('contextmenu', e => {
                e.preventDefault();
            });
            this.refreshers.push(() => {
                input.value = get();
                label.textContent = labelFn(get());
            });
            return el('div', { class: 'ss-slider' }, label, input);
        }

        select(options, get, set) {
            const s = el('select', { class: 'ss-input' }, options.map((o, i) => el('option', { value: i }, o)));
            s.addEventListener('change', () => set(parseInt(s.value, 10)));
            this.refreshers.push(() => s.value = get());
            return s;
        }

        label(text) {
            return el('div', { class: 'ss-label' }, text);
        }

        row(...children) {
            return el('div', { class: 'ss-row' }, ...children);
        }

        // ------------------------------------------------------------ layout

        build() {
            const editor = this.editor;
            const s = this.settings;
            const map = this.map;
            const app = this.app;
            const ps = this.playerSettings();

            // ----- standard left navigation (OPTIONS / TIMING / PATTERNS / PLAYTEST)
            const optionsNav = el('div', { class: 'ss-container' },
                this.checkbox('Use Numpad', 'numpad'),
                this.checkbox('Separate Click Tools', 'separateClickTools'),
                this.button('Swap Click Mode', () => editor.runKeybind('switchClickTool'), 'wide'),
                this.checkbox('Jump on Paste', 'jumpPaste'),
                this.checkbox('Pause on Seek', 'pauseScroll'),
                this.checkbox('Use Old Quantum Divisor', 'oldQuantumSnap'),
                el('div', { class: 'ss-gap' }),
                this.button('Edit Extra Objects', () => this.setRenderMode(RenderMode.Special), 'wide'),
            );

            const timingNav = el('div', { class: 'ss-container' },
                el('div', { class: 'ss-grid3' },
                    el('div', {}, this.label('Export Offset:'), this.numberBox(() => map.props.exportOffset, v => {
                        SSQE.Formats.setExportOffset(map, Math.trunc(v));
                        editor.onMapChanged();
                    })),
                    el('div', {}, this.label('SFX Offset:'), this.numberBox(() => s.sfxOffset, v => { s.sfxOffset = v; this.save(); })),
                    el('div', {}, this.label('Music Offset:'), this.numberBox(() => s.musicOffset, v => { s.musicOffset = v; this.save(); })),
                ),
                this.button('OPEN BPM SETUP', () => app.dialogs.timings(editor), 'wide'),
                this.button('IMPORT INI', () => app.importIni(map), 'wide'),
                this.checkbox('Metronome', 'metronome'),
                this.checkbox('Scale Metronome With Divisor', 'scaleMetronome'),
                this.button('EDIT BOOKMARKS', () => app.dialogs.bookmarks(editor), 'wide'),
                this.button('COPY BOOKMARKS', () => this.copyBookmarks(), 'wide'),
                this.button('PASTE BOOKMARKS', () => this.pasteBookmarks(), 'wide'),
            );

            const patternsNav = el('div', { class: 'ss-container' },
                this.row(this.button('HORIZONTAL FLIP', () => editor.hFlip()), this.button('VERTICAL FLIP', () => editor.vFlip())),
                this.label('Rotate by Degrees:'),
                this.row(this.numberBox(() => s.rotateBy, v => { s.rotateBy = v; this.save(); }, { width: '100px' }), this.button('ROTATE', () => editor.rotate(s.rotateBy))),
                this.label('Scale by Percent:'),
                this.row(this.numberBox(() => s.scaleBy, v => { s.scaleBy = v; this.save(); }, { width: '100px' }), this.button('SCALE', () => editor.scaleNotes(s.scaleBy))),
                this.checkbox('Apply Rotate/Scale on Paste', 'applyOnPaste'),
                this.checkbox('Clamp Rotate/Scale in Bounds', 'clampSR'),
                this.checkbox('Paste Reversed', 'pasteReversed'),
                this.checkbox('Move Selected on Grid Key Pressed', 'moveOnGridKey'),
                this.row(this.button('STORE NODES', () => editor.storeNodes()), this.button('CLEAR NODES', () => editor.clearNodes())),
                this.checkbox('Curve Bezier', 'curveBezier'),
                this.label('Draw Bezier with Divisor:'),
                this.row(this.numberBox(() => s.bezierDivisor, v => { s.bezierDivisor = Math.max(0, v); this.save(); }, { width: '100px' }), this.button('DRAW', () => editor.runBezier())),
                this.label('Patterns: Shift+0-9 stores the selection, 0-9 places it, Ctrl+0-9 clears it.'),
            );

            const savePlayer = () => {
                SSQESettings.save(ps);
            };
            const playerNav = el('div', { class: 'ss-container' },
                el('div', { class: 'ss-grid3' },
                    el('div', {}, this.label('Camera Mode:'), this.select(['half lock', 'full lock', 'spin'], () => ['half lock', 'full lock', 'spin'].indexOf(ps.cameraMode), v => { ps.cameraMode = ['half lock', 'full lock', 'spin'][v]; savePlayer(); })),
                    el('div', {}, this.label('Note Size:'), this.numberBox(() => ps.noteScale, v => { ps.noteScale = Math.max(0.05, v); savePlayer(); })),
                    el('div', {}, this.label('Cursor Size:'), this.numberBox(() => ps.cursorScale, v => { ps.cursorScale = Math.max(0.05, v); savePlayer(); })),
                ),
                this.playerCheckbox('Lock Cursor Within Grid', ps, 'lockCursor'),
                this.playerCheckbox('Grid Guides', ps, 'gridGuides'),
                el('div', { class: 'ss-grid3' },
                    el('div', {}, this.label('Sensitivity:'), this.numberBox(() => ps.sensitivity, v => { ps.sensitivity = v; savePlayer(); })),
                    el('div', {}, this.label('Parallax:'), this.numberBox(() => ps.parallax, v => { ps.parallax = v; savePlayer(); })),
                    el('div', {}, this.label('FOV:'), this.numberBox(() => ps.fov, v => { ps.fov = clamp(v, 10, 170); savePlayer(); })),
                ),
                el('div', { class: 'ss-grid3' },
                    el('div', {}, this.label('Approach Distance:'), this.numberBox(() => ps.approachDistance, v => { ps.approachDistance = Math.max(0.1, v); savePlayer(); })),
                    el('div', {}, this.label('Hit Window:'), this.numberBox(() => ps.hitWindow, v => { ps.hitWindow = Math.max(1, v); savePlayer(); })),
                ),
                this.slider(() => ps.playerApproachRate, v => { ps.playerApproachRate = v; savePlayer(); }, 0, 29, 1, v => `Player Approach Rate: ${Math.round(v + 1)}`),
                this.playerCheckbox('Approach Fade', ps, 'approachFade'),
                this.row(this.button('PLAY FROM START', e => app.playtest(editor, true, e.altKey)), this.button('PLAY HERE', e => app.playtest(editor, false, e.altKey))),
                this.label('Hold Alt while clicking to watch autoplay.'),
            );

            this.leftNavs = { OPTIONS: optionsNav, TIMING: timingNav, PATTERNS: patternsNav, PLAYTEST: playerNav };

            // ----- right navigation (SNAPPING / GRAPHICS / EXPORT)
            const quantumOffsets = el('div', {},
                this.slider(() => s.quantumXOffset, v => { s.quantumXOffset = v; this.save(); }, 0, 2, 0.05, v => `Quantum X Offset: ${Math.round((v - 1) * 100) / 100}`),
                this.slider(() => s.quantumYOffset, v => { s.quantumYOffset = v; this.save(); }, 0, 2, 0.05, v => `Quantum Y Offset: ${Math.round((v - 1) * 100) / 100}`),
            );
            this.refreshers.push(() => quantumOffsets.style.display = s.oldQuantumSnap ? 'none' : '');

            const snappingNav = el('div', { class: 'ss-container' },
                this.checkbox('Quantum', 'enableQuantum'),
                this.checkbox('Snap to Grid', 'quantumGridSnap'),
                this.checkbox('Auto-Advance', 'autoAdvance'),
                this.slider(() => map.beatDivisor, v => { map.beatDivisor = v; }, 0, 31, 0.5, v => `Beat Divisor: ${Math.round(v * 10) / 10 + 1}`),
                this.slider(() => s.quantumSnapping, v => { s.quantumSnapping = v; this.save(); }, 0, 57, 1, v => `Quantum Divisor: ${Math.round(v + 3)}`),
                quantumOffsets,
            );

            const graphicsNav = el('div', { class: 'ss-container' },
                this.checkbox('Autoplay', 'autoplay'),
                this.checkbox('Smooth Autoplay Cursor', 'smoothAutoplay'),
                this.checkbox('Approach Squares', 'approachSquares'),
                this.checkbox('Grid Numbers', 'gridNumbers'),
                this.checkbox('Grid Letters', 'gridLetters'),
                this.checkbox('Quantum Grid Lines', 'quantumGridLines'),
                this.checkbox('Waveform', 'waveform'),
                this.slider(() => s.approachRate, v => { s.approachRate = v; this.save(); }, 0, 29, 1, v => `Approach Rate: ${Math.round(v + 1)}`),
                this.slider(() => s.cursorPos, v => { s.cursorPos = v; this.save(); }, 0, 100, 1, v => `Cursor Position: ${Math.abs(Math.round(v))}%`),
            );

            const replaceBox = el('input', { type: 'text', class: 'ss-input', placeholder: 'new audio ID' });
            const exportNav = el('div', { class: 'ss-container' },
                this.row(this.button('SAVE', () => app.save(map)), this.button('SAVE AS', () => app.saveAs(map))),
                this.label('Export Type:'),
                el('select', { class: 'ss-input' }, el('option', {}, 'Nightly (SSPM)')),
                this.button('EXPORT MAP', () => app.dialogs.exportSspm(editor), 'wide'),
                this.label('Replace Audio ID'),
                replaceBox,
                this.button('REPLACE', () => app.replaceAudioId(map, replaceBox.value), 'wide'),
                this.button('CHANGE AUDIO FILE', () => app.changeAudio(editor), 'wide'),
            );

            this.rightNavs = { SNAPPING: snappingNav, GRAPHICS: graphicsNav, EXPORT: exportNav };

            // ----- extra objects (special) navigation
            const objButtons = {};
            const objectModes = [['Beats', ObjectMode.Beat], ['Mines', ObjectMode.Mine], ['Glides', ObjectMode.Glide], ['Lyrics', ObjectMode.Lyric], ['Fevers', ObjectMode.Fever]];
            const objectList = el('div', { class: 'ss-objlist' },
                objectModes.map(([name, mode]) => objButtons[mode] = this.button(name, () => this.setObjectMode(mode))),
                el('div', { class: 'ss-spacer' }),
                objButtons[ObjectMode.Note] = this.button('Modify Notes', () => this.setObjectMode(ObjectMode.Note)),
            );
            this.objButtons = objButtons;

            // lyric editor
            this.lyricBox = el('input', { type: 'text', class: 'ss-input', placeholder: 'lyric' });
            this.lyricFadeIn = el('input', { type: 'checkbox' });
            this.lyricFadeOut = el('input', { type: 'checkbox' });
            this.lyricFadeIn.addEventListener('change', () => this.lyricFadeIn.checked && (this.lyricFadeOut.checked = false));
            this.lyricFadeOut.addEventListener('change', () => this.lyricFadeOut.checked && (this.lyricFadeIn.checked = false));
            this.lyricCreate = this.button('CREATE', () => this.createLyric(), 'wide');
            this.lyricBox.addEventListener('keydown', e => {
                if (e.key === 'Enter') {
                    this.createLyric();
                    this.lyricBox.focus();
                }
            });
            this.lyricNav = el('div', { class: 'ss-subnav' },
                this.lyricBox,
                el('label', { class: 'ss-check' }, this.lyricFadeIn, el('span', {}, 'Fade In')),
                el('label', { class: 'ss-check' }, this.lyricFadeOut, el('span', {}, 'Fade Out')),
                this.lyricCreate,
                el('pre', { class: 'ss-info' }, 'Lyric usage:\n> "-" prefix: Replace previous line\n> "-" suffix: Apply next lyric as a syllable\n    (Without a space in between)\n> Press \'Enter\' in the lyric textbox to quickly place a lyric'),
            );

            // note easing editor
            this.noteEasing = el('input', { type: 'checkbox' });
            this.noteStyle = el('select', { class: 'ss-input' }, EASING_STYLES.map((n, i) => el('option', { value: i }, n)));
            this.noteDirection = el('select', { class: 'ss-input' }, ['In', 'Out'].map((n, i) => el('option', { value: i }, n)));
            this.noteNav = el('div', { class: 'ss-subnav' },
                el('label', { class: 'ss-check' }, this.noteEasing, el('span', {}, 'Enable Easing')),
                this.noteStyle,
                this.noteDirection,
                this.button('Apply Modifications', () => {
                    const easing = this.noteEasing.checked, style = +this.noteStyle.value, direction = +this.noteDirection.value;
                    map.notes.edit('MODIFY NOTE[S]', n => {
                        n.enableEasing = easing;
                        n.style = style;
                        n.direction = direction;
                    });
                }, 'wide'),
            );

            this.gameSwitch = this.button('', () => {
                s.modchartGame = s.modchartGame === 'Novastra' ? 'Rhythia' : 'Novastra';
                this.save();
                this.refresh();
            }, 'ss-bottom-left');

            this.specialRoot = el('div', { class: 'ss-special' },
                this.button('CLOSE EXTRA OBJECTS', () => this.setRenderMode(RenderMode.Notes), 'ss-close-special'),
                el('div', { class: 'ss-special-body' }, objectList, this.lyricNav, this.noteNav),
                this.gameSwitch,
            );
            this.objectList = objectList;

            // ----- nav buttons
            this.leftButtons = {};
            const leftBar = el('div', { class: 'ss-navbar ss-left' },
                ['OPTIONS', 'TIMING', 'PATTERNS'].map(n => this.leftButtons[n] = this.button(n, () => this.toggleLeft(n))));
            this.leftButtons.PLAYTEST = this.button('PLAYTEST', () => this.toggleLeft('PLAYTEST'), 'ss-bottom-left');

            this.rightButtons = {};
            const rightBar = el('div', { class: 'ss-navbar ss-right' },
                ['SNAPPING', 'GRAPHICS', 'EXPORT'].map(n => this.rightButtons[n] = this.button(n, () => this.toggleRight(n))));

            this.leftHost = el('div', { class: 'ss-host ss-host-left' }, Object.values(this.leftNavs));
            this.rightHost = el('div', { class: 'ss-host ss-host-right' }, Object.values(this.rightNavs));

            this.standardRoot = el('div', {}, leftBar, this.leftButtons.PLAYTEST, this.leftHost);

            // ----- center buttons
            const center = el('div', {},
                this.button('COPY MAP DATA', e => app.copyMapData(map, e.altKey), 'ss-copy'),
                this.button('BACK TO MENU', () => app.backToMenu(), 'ss-back'),
            );

            this.root.append(this.standardRoot, this.specialRoot, rightBar, this.rightHost, center);
        }

        playerSettings() {
            if (!this._ps)
                this._ps = window.SSQESettings ? SSQESettings.load() : {};
            return this._ps;
        }

        playerCheckbox(text, ps, key) {
            const input = el('input', { type: 'checkbox' });
            input.addEventListener('change', () => {
                ps[key] = input.checked;
                SSQESettings.save(ps);
            });
            this.refreshers.push(() => input.checked = !!ps[key]);
            return el('label', { class: 'ss-check' }, input, el('span', {}, text));
        }

        toggleLeft(name) {
            this.left = this.left === name ? null : name;
            this.settings.lastLeftNav = this.left || '';
            this.save();
            this.refresh();
        }

        toggleRight(name) {
            this.right = this.right === name ? null : name;
            this.settings.lastRightNav = this.right || '';
            this.save();
            this.refresh();
        }

        setRenderMode(mode) {
            this.map.renderMode = mode;
            this.map.objectMode = ObjectMode.Disabled;
            this.map.clearSelected();
            this.refresh();
        }

        setObjectMode(mode) {
            this.map.objectMode = this.map.objectMode === mode ? ObjectMode.Disabled : mode;
            this.map.clearSelected();
            this.refresh();
        }

        copyBookmarks() {
            const text = this.map.copyBookmarksText();
            if (!text)
                return;
            this.app.writeClipboard(text).then(() => this.editor.toast('COPIED TO CLIPBOARD', 'other'));
        }

        async pasteBookmarks() {
            const text = await this.app.readClipboard('Paste bookmarks ("ms ~ text" per line)');
            if (text)
                this.map.pasteBookmarksText(text);
        }

        // GuiWindowEditor.CreateLyric
        createLyric() {
            const map = this.map;
            const editor = this.editor;
            const text = this.lyricBox.value;
            const fadeIn = this.lyricFadeIn.checked, fadeOut = this.lyricFadeOut.checked;
            const selected = map.specialObjects.selected;

            if (selected.length === 1 && selected[0] instanceof Lyric) {
                map.specialObjects.edit('EDIT LYRIC', [selected[0]], n => {
                    n.text = text;
                    n.fadeIn = fadeIn;
                    n.fadeOut = fadeOut;
                });
            } else {
                let ms = editor.closestBeat(editor.currentTime);
                ms = Math.trunc(clamp(ms >= 0 ? ms : editor.currentTime, 0, editor.totalTime));
                map.specialObjects.addObjects('ADD LYRIC', new Lyric(ms, text, fadeIn, fadeOut));
                if (this.settings.autoAdvance)
                    editor.advance();
            }

            map.clearSelected();
            this.lyricBox.value = '';
            this.lyricFadeIn.checked = false;
            this.lyricFadeOut.checked = false;
        }

        // ------------------------------------------------------------ state sync

        refresh() {
            const special = this.map.renderMode === RenderMode.Special;
            this.standardRoot.style.display = special ? 'none' : '';
            this.specialRoot.style.display = special ? '' : 'none';

            for (const [name, nav] of Object.entries(this.leftNavs)) {
                nav.style.display = this.left === name ? '' : 'none';
                this.leftButtons[name].classList.toggle('active', this.left === name);
            }
            for (const [name, nav] of Object.entries(this.rightNavs)) {
                nav.style.display = this.right === name ? '' : 'none';
                this.rightButtons[name].classList.toggle('active', this.right === name);
            }

            const mode = this.map.objectMode;
            for (const [m, b] of Object.entries(this.objButtons))
                b.classList.toggle('active', +m === mode);
            this.objectList.style.display = this.settings.modchartGame === 'Novastra' ? '' : 'none';
            this.gameSwitch.textContent = this.settings.modchartGame.toUpperCase();
            this.lyricNav.style.display = mode === ObjectMode.Lyric ? '' : 'none';
            this.noteNav.style.display = mode === ObjectMode.Note ? '' : 'none';

            for (const r of this.refreshers)
                r();
        }

        // per-frame updates for state that changes without UI interaction
        update() {
            const map = this.map;
            if (map.renderMode !== RenderMode.Special)
                return;

            const sel = map.objectMode === ObjectMode.Lyric ? map.specialObjects.selected : [];
            const editing = sel.length === 1 && sel[0] instanceof Lyric;
            this.lyricCreate.textContent = editing ? 'EDIT' : 'CREATE';
            if (editing && this.lastLyric !== sel[0]) {
                this.lyricBox.value = sel[0].text;
                this.lyricFadeIn.checked = sel[0].fadeIn;
                this.lyricFadeOut.checked = sel[0].fadeOut;
            }
            this.lastLyric = editing ? sel[0] : null;

            const notes = map.objectMode === ObjectMode.Note ? map.notes.selected : [];
            if (notes.length && this.lastNote !== notes[0]) {
                this.noteEasing.checked = notes[0].enableEasing;
                this.noteStyle.value = notes[0].style;
                this.noteDirection.value = Math.min(notes[0].direction, 1);
            }
            this.lastNote = notes[0] || null;
        }
    }

    SSQE.Panels = Panels;
    SSQE.el = el;
})();
