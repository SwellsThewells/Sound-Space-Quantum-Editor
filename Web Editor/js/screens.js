'use strict';

// Ports of GuiWindowMenu, GuiWindowCreate, GuiWindowSettings and GuiWindowKeybinds (layouts copied from their
// *.Controls.cs files), drawn with the canvas GUI toolkit in gui.js.
(function () {
    const G = SSQE.GUI;
    const None = G.CenterMode.None;

    // FontRenderer.WrapText
    function wrapText(text, size, font, width) {
        const out = [];
        for (const line of text.split('\n')) {
            const words = line.split(' ');
            let current = null;
            for (const word of words) {
                const next = current !== null ? `${current} ${word}` : word;
                if (current && G.Text.width(next, size, font) > width) {
                    out.push(current);
                    current = ' ' + word; // the desktop wrapper keeps the separating space on the next line
                } else
                    current = next;
            }
            out.push(current ?? '');
        }
        return out.join('\n');
    }

    // GuiScrollingList holding one wrapped label (the changelog)
    class ScrollingText extends G.Interactive {
        init() {
            super.init();
            this.scroll = 0;
            this.scrollScale = 2;
            this.textSize = 20;
            this.font = 'semibold';
            this.content = '';
            this.wrapped = '';
            this.wrappedFor = '';
            this.playLeftClickSound = false;
            this.playRightClickSound = false;
            this.draggingBar = false;
        }

        get barWidth() {
            return Math.min(20, this.origin.w / 10) * this.rect.w / (this.origin.w + Math.min(20, this.origin.w / 10));
        }

        layout() {
            const key = `${this.content}|${this.rect.w}|${this.scaledTextSize}`;
            if (key !== this.wrappedFor) {
                this.wrapped = wrapText(this.content, this.scaledTextSize, this.font, this.rect.w);
                this.wrappedFor = key;
            }
            const lines = this.wrapped.split('\n').length;
            const contentH = lines * this.scaledTextSize;
            this.maxScroll = Math.max(0, contentH - this.rect.h);
            this.scroll = Math.min(Math.max(this.scroll, 0), this.maxScroll);
        }

        contains(x, y) {
            const r = this.rect;
            return x >= r.x && x <= r.x + r.w + this.barWidth && y >= r.y && y <= r.y + r.h;
        }

        mouseScroll(x, y, delta) {
            this.scroll -= 10 * delta * this.scrollScale * this.textScale;
            this.layout();
        }

        mouseDownLeft(x, y, window) {
            super.mouseDownLeft(x, y, window);
            this.draggingBar = x >= this.rect.x + this.rect.w - this.barWidth / 2;
            this.mouseMove(x, y);
        }

        mouseMove(x, y) {
            if (this.dragging && this.draggingBar) {
                const top = this.rect.y + 6, h = this.rect.h - 12;
                this.scroll = Math.min(1, Math.max(0, (y - top) / h)) * this.maxScroll;
            }
        }

        draw(ctx) {
            this.layout();
            // slider (Style = Slider_Uncolored): grey line + white marker
            const bx = this.rect.x + this.rect.w + this.barWidth / 2; // the bar sits just right of the list
            const top = this.rect.y + 6, h = this.rect.h - 12;
            ctx.fillStyle = 'rgb(75,75,75)';
            ctx.fillRect(bx - 1.5, top, 3, h);
            const p = this.maxScroll ? this.scroll / this.maxScroll : 0;
            ctx.beginPath();
            ctx.arc(bx, top + h * p, 4, 0, Math.PI * 2);
            ctx.fillStyle = '#fff';
            ctx.fill();
        }

        drawText(ctx) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(this.rect.x, this.rect.y, this.rect.w, this.rect.h);
            ctx.clip();
            G.Text.draw(ctx, this.wrapped, this.rect.x, this.rect.y - this.scroll, this.scaledTextSize, this.font, [255, 255, 255]);
            ctx.restore();
        }
    }

    // GuiPathBox: a CHOOSE button followed by the chosen file name
    function pathBox(x, y, w, h, text, textSize, getLabel, onChoose) {
        const button = new G.Button(0, 0, w / 4, h, { text, textSize, onLeftClick: onChoose });
        const label = new G.Label(w / 4 + 8, 0, w * 3 / 4 - 8, h, { textSize, centerMode: G.CenterMode.Y });
        const backdrop = new G.Square(w / 4, 0, w * 3 / 4, h, { color: [26, 26, 26] });
        const outline = new G.Square(w / 4, 0, w * 3 / 4, h, { color: [52, 52, 52], outline: true });
        const box = new G.Container(x, y, w, h, [button, label, backdrop, outline]);
        box.process = function (dt) {
            G.Container.prototype.process.call(this, dt);
            label.text = getLabel();
        };
        return box;
    }

    // GuiTextboxKeybind / GuiTextboxGridKeybind
    class KeybindBox extends G.Textbox {
        init() {
            super.init();
            this.style = G.Styles.Textbox_Uncolored;
            this.getText = () => '';
            this.onKey = null;
        }

        process(dt) {
            super.process(dt);
            this.text = this.getText();
            this.cursorPos = this.text.length;
        }

        keyDown(e) {
            if (!this.focused)
                return false;
            if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key))
                return true;
            this.onKey(e.code === 'Backspace' ? 'Delete' : e.code, e.ctrlKey || e.metaKey, e.altKey, e.shiftKey);
            return true;
        }

        paste() { }
    }

    // ---------------------------------------------------------------- shared runner

    class Screen {
        constructor(app, controls) {
            this.app = app;
            this.win = new G.Window(app, controls);
            this.canvas = document.getElementById('editor-canvas');
            this.ctx = this.canvas.getContext('2d');
            this.running = false;
        }

        start() {
            this.running = true;
            this.handlers = {
                mousemove: e => this.win.mouseMove(e.clientX, e.clientY),
                mousedown: e => {
                    if (e.target !== this.canvas)
                        return;
                    this.win.mouseMove(e.clientX, e.clientY);
                    this.win.mouseDown(e.clientX, e.clientY, e.button);
                },
                mouseup: e => this.win.mouseUp(e.clientX, e.clientY, e.button),
                wheel: e => {
                    if (e.target !== this.canvas)
                        return;
                    e.preventDefault();
                    if (e.deltaY)
                        this.win.scroll(e.clientX, e.clientY, e.deltaY < 0 ? 1 : -1);
                },
                keydown: e => {
                    this.win.keys.ctrl = e.ctrlKey || e.metaKey;
                    this.win.keys.alt = e.altKey;
                    this.win.keys.shift = e.shiftKey;
                    if (this.app.dialogOpen())
                        return;
                    const r = this.win.keyDown(e);
                    if (r === true)
                        e.preventDefault();
                    this.onKeyDown && this.onKeyDown(e);
                },
                keyup: e => {
                    this.win.keys.ctrl = e.ctrlKey || e.metaKey;
                    this.win.keys.alt = e.altKey;
                    this.win.keys.shift = e.shiftKey;
                },
                paste: e => {
                    if (this.win.textboxFocused()) {
                        e.preventDefault();
                        this.win.paste(e.clipboardData.getData('text'));
                    }
                },
                resize: () => this.resize(),
                contextmenu: e => e.target === this.canvas && e.preventDefault(),
            };
            for (const [k, h] of Object.entries(this.handlers))
                window.addEventListener(k, h, k === 'wheel' ? { passive: false } : undefined);
            this.resize();
            this.last = performance.now();
            const frame = now => {
                if (!this.running)
                    return;
                const dt = Math.max(0, (now - this.last) / 1000);
                this.last = now;
                this.update && this.update(dt);
                this.win.process(dt);
                const ctx = this.ctx;
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                ctx.fillStyle = '#000';
                ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
                ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
                this.win.render(ctx);
                this.raf = requestAnimationFrame(frame);
            };
            this.raf = requestAnimationFrame(frame);
        }

        stop() {
            this.running = false;
            cancelAnimationFrame(this.raf);
            for (const [k, h] of Object.entries(this.handlers || {}))
                window.removeEventListener(k, h);
        }

        resize() {
            const dpr = window.devicePixelRatio || 1;
            const w = window.innerWidth, h = window.innerHeight;
            this.canvas.width = Math.floor(w * dpr);
            this.canvas.height = Math.floor(h * dpr);
            this.canvas.style.width = w + 'px';
            this.canvas.style.height = h + 'px';
            this.dpr = dpr;
            this.win.resize(w, h);
        }
    }

    const background = () => new G.Square(0, 0, 1920, 1080, { color: [30, 30, 30] });

    // ---------------------------------------------------------------- GuiWindowMenu

    function menu(app) {
        const s = app.settings;
        const label = (x, y, w, h, props) => new G.Label(x, y, w, h, { centerMode: None, ...props });
        const button = (x, y, w, h, text, textSize, onClick) => new G.Button(x, y, w, h, { text, textSize, onLeftClick: onClick });

        const changelog = new ScrollingText(60, 230, 890, 715, { content: app.changelog || 'Loading...' });
        const autosaved = button(1190, 640, 600, 100, 'AUTOSAVED MAP', 54, () => app.openAutosaved());
        const lastMap = button(1190, 755, 600, 100, 'EDIT LAST MAP', 54, () => app.openLastMap());

        const navLeft = button(0, 1040, 40, 40, '<', 34, () => { app.mapIndex--; });
        const navRight = button(1880, 1040, 40, 40, '>', 34, () => { app.mapIndex++; });
        const selects = [], closes = [];
        for (let i = 0; i < 5; i++) {
            const x = 40 + 368 * i;
            selects.push(button(x, 1040, 368, 40, '', 20, () => {
                const entry = app.openMaps[app.mapIndex + i];
                if (entry)
                    app.openEntry(entry);
            }));
            closes.push(button(x, 1040, 40, 40, 'X', 26, () => {
                const entry = app.openMaps[app.mapIndex + i];
                if (entry)
                    app.closeEntry(entry);
            }));
        }

        const controls = [
            background(),
            new G.Square(35, 180, 950, 790, { color: [0, 0, 0, 40] }),
            new G.Square(55, 230, 900, 715, { color: [0, 0, 0, 50] }),
            new G.Square(0, 1040, 1920, 40, { color: [0, 0, 0, 50] }),
            button(1190, 180, 600, 100, 'CREATE NEW MAP', 54, () => app.openCreate()),
            button(1190, 295, 600, 100, 'LOAD MAP', 54, () => app.loadMapDialog()),
            button(1190, 410, 600, 100, 'PASTE MAP', 54, () => app.pasteMap()),
            button(1190, 525, 600, 100, 'SETTINGS', 54, () => app.openSettings()),
            autosaved, lastMap, navLeft, navRight,
            ...selects, ...closes,
            button(35, 140, 100, 40, 'Feedback?', 20, () => window.open('https://forms.gle/Rh4RXKT9KyttJ9Dc6', '_blank', 'noopener')),
            changelog,
            label(60, 195, 200, 40, { text: 'CHANGELOG', textSize: 42 }),
            label(35, 0, 750, 100, { text: 'SOUND SPACE', textSize: 156, font: 'square' }),
            label(615, 140, 150, 40, { text: 'QUANTUM EDITOR', textSize: 38, font: 'square' }),
        ];

        const screen = new Screen(app, controls);
        screen.update = () => {
            changelog.content = app.changelog || 'Loading...';

            // GuiWindowMenu.FixButtonsChangelog
            autosaved.visible = false;
            lastMap.visible = !!app.lastMapEntry();
            const r = lastMap.origin;
            lastMap.origin = { ...r, y: autosaved.visible ? 755 : 640 };

            // GuiWindowMenu.AssembleMapList / Render
            const count = app.openMaps.length;
            app.mapIndex = Math.max(0, Math.min(app.mapIndex, Math.max(count - 5, 0)));
            navLeft.visible = app.mapIndex > 0;
            navRight.visible = app.mapIndex < count - 5;
            for (let i = 0; i < 5; i++) {
                const entry = app.openMaps[app.mapIndex + i];
                selects[i].visible = !!entry;
                closes[i].visible = !!entry && selects[i].hovering;
                if (entry) {
                    const name = (app.isSaved(entry) ? '' : '[!] ') + app.entryName(entry);
                    selects[i].text = closes[i].visible ? 'Open Map' : trimText(name, selects[i].scaledTextSize, 'main', selects[i].rect.w - 10);
                }
            }
            screen.win.resize(screen.win.width, screen.win.height);
        };
        const scrollMaps = screen.win.scroll.bind(screen.win);
        screen.win.scroll = (x, y, delta) => {
            scrollMaps(x, y, delta);
            if ([navLeft, navRight, ...selects, ...closes].some(b => b.visible && b.hovering))
                app.mapIndex += delta > 0 ? 1 : -1;
        };
        return screen;
    }

    // FontRenderer.TrimText
    function trimText(text, size, font, width) {
        if (G.Text.width(text, size, font) <= width)
            return text;
        while (text.length > 1 && G.Text.width(text + '...', size, font) > width)
            text = text.slice(0, -1);
        return text + '...';
    }

    // ---------------------------------------------------------------- GuiWindowCreate

    function create(app) {
        const s = app.settings;
        const unc = G.Styles.Checkbox_Uncolored = [[255, 255, 255], [75, 75, 75], [13, 13, 13], [52, 52, 52], [255, 255, 255]];
        let audioFile = null;
        const fileLabel = () => audioFile ? audioFile.name : '';
        const choose = async () => {
            const f = await app.pickFile('audio/*,.asset,.mp3,.ogg,.wav,.flac,.m4a,.opus');
            if (f)
                audioFile = f;
        };

        const games = ['Sound Space', 'Rhythia', 'Novastra/Phoenyx/Other'];
        const idBox = new G.Textbox(470, 5, 340, 50, { textSize: 36 });
        const ssContainer = new G.Container(0, 0, 1920, 1080, [
            new G.Label(370, -45, 540, 50, { text: 'Audio ID', textSize: 36 }),
            idBox,
            new G.Label(370, 55, 540, 50, { text: 'Import Audio', textSize: 36 }),
            pathBox(370, 105, 540, 50, 'CHOOSE', 28, fileLabel, choose),
        ]);
        const rhythiaContainer = new G.Container(0, 0, 1920, 1080, [
            new G.Label(370, -45, 540, 50, { text: 'Import Audio', textSize: 36 }),
            pathBox(370, 5, 540, 50, 'CHOOSE', 28, fileLabel, choose),
            new G.Label(370, 85, 540, 100, { text: 'Rhythia Online is no longer supported for importing\nand should not be used for new work.\n\ndiscord.gg/rhythia -> #Announcements', textSize: 20 }),
        ], { visible: false });
        const novaContainer = new G.Container(0, 0, 1920, 1080, [
            pathBox(370, 5, 540, 50, 'CHOOSE', 28, fileLabel, choose),
            new G.Label(370, -45, 540, 50, { text: 'Import Audio', textSize: 36 }),
        ], { visible: false });
        const panels = [ssContainer, rhythiaContainer, novaContainer];

        let active = Math.max(0, games.indexOf(s.createGame || 'Sound Space'));
        const navs = games.map((g, i) => new G.Checkbox(0, i * 100, 50, 50, {
            text: g, textSize: 30, style: unc,
            get: () => active === i,
            set: () => {
                active = i;
                s.createGame = games[i];
                SSQE.Settings.save(s);
            },
        }));
        const gameNavs = new G.Container(320, 415, 180, 250, [...navs, ...panels]);

        const controls = [
            background(),
            new G.Container(0, 0, 1920, 1080, [
                new G.Button(750, 705, 420, 50, {
                    text: 'CREATE MAP', textSize: 38, onLeftClick: async () => {
                        if (!audioFile) {
                            app.dialogs.message('Choose an audio file first.');
                            return;
                        }
                        let id = SSQE.Formats.fixId(audioFile.name.replace(/\.[^.]*$/, ''));
                        if (active === 0 && idBox.text.trim())
                            id = SSQE.Formats.fixId(idBox.text.trim());
                        await app.storage.putAudio(id, audioFile);
                        const map = new SSQE.Map();
                        map.soundId = id;
                        await app.openNewMap(map, null);
                    },
                }),
                new G.Button(690, 920, 540, 75, { text: 'BACK TO MENU', textSize: 48, onLeftClick: () => app.showMenu() }),
            ]),
            gameNavs,
        ];

        const screen = new Screen(app, controls);
        screen.update = () => panels.forEach((p, i) => p.visible = i === active);
        return screen;
    }

    // ---------------------------------------------------------------- GuiWindowSettings

    function settings(app) {
        const s = app.settings;
        const unc = [[255, 255, 255], [75, 75, 75], [13, 13, 13], [52, 52, 52], [255, 255, 255]];
        const save = () => {
            SSQE.Settings.save(s);
            app.applyTheme();
        };
        const lbl = (x, y, w, h, text, textSize = 30) => new G.Label(x, y, w, h, { text, textSize, centerMode: None });
        const btn = (x, y, w, h, text, textSize, onClick) => new G.Button(x, y, w, h, { text, textSize, onLeftClick: onClick });
        const chk = (x, y, text, key, onChange) => new G.Checkbox(x, y, 45, 45, {
            text, textSize: 34, style: unc, get: () => s[key], set: v => { s[key] = v; save(); onChange && onChange(v); },
        });
        const num = (x, y, w, h, key, props) => new G.NumberBox(x, y, w, h, {
            textSize: 34, get: () => s[key], set: v => { s[key] = v; save(); }, ...props,
        });

        const pick = key => app.pickColor(s[key]).then(c => {
            if (c) {
                s[key] = c;
                save();
            }
        });

        const colorRow = (i, y, text) => [
            btn(0, y, 200, 50, 'PICK COLOR', 30, () => pick(`color${i}`)),
            lbl(0, y - 30, 200, 26, text),
            new G.Square(210, y, 75, 50, { color: () => s[`color${i}`] }),
        ];

        // note colour squares (LMB: remove, RMB: move left)
        class NoteColors extends G.Interactive {
            init() {
                super.init();
                this.playLeftClickSound = true;
                this.hoverIndex = -1;
            }

            mouseMove(x) {
                const colors = s.noteColors;
                const w = this.rect.w / colors.length;
                this.hoverIndex = this.hovering ? Math.min(Math.max(Math.trunc((x - this.rect.x) / w), 0), colors.length - 1) : -1;
            }

            mouseLeave() {
                super.mouseLeave();
                this.hoverIndex = -1;
            }

            mouseUpLeft(x, y) {
                super.mouseUpLeft(x, y);
                if (this.hovering && this.hoverIndex >= 0 && s.noteColors.length > 1) {
                    s.noteColors.splice(this.hoverIndex, 1);
                    save();
                }
            }

            mouseUpRight(x, y) {
                super.mouseUpRight(x, y);
                const i = this.hoverIndex;
                if (this.hovering && i > 0 && s.noteColors.length > 1) {
                    [s.noteColors[i], s.noteColors[i - 1]] = [s.noteColors[i - 1], s.noteColors[i]];
                    save();
                }
            }

            draw(ctx) {
                const colors = s.noteColors;
                const w = this.rect.w / colors.length;
                colors.forEach((c, i) => {
                    ctx.fillStyle = G.rgb(c);
                    ctx.fillRect(this.rect.x + w * i, this.rect.y, w, this.rect.h);
                });
                if (this.hoverIndex >= 0) {
                    ctx.strokeStyle = 'rgb(0,127,255)';
                    ctx.lineWidth = 2;
                    ctx.strokeRect(this.rect.x + w * this.hoverIndex, this.rect.y, w, this.rect.h);
                }
            }
        }

        const opacityRow = (y, key, text) => [
            num(650, y, 200, 50, key, { increment: 5, isPositive: true, bounds: [0, 255], style: G.Styles.Textbox_Uncolored }),
            lbl(650, y - 30, 200, 26, text),
            new G.Square(860, y, 75, 50, { color: () => [255, 255, 255, Math.min(255, Math.max(0, s[key]))] }),
        ];

        const ColorsNav = new G.Container(320, 0, 1220, 700, [
            ...colorRow(1, 0, 'Color 1 (1/X BPM + Primary):'),
            ...colorRow(2, 100, 'Color 2 (1/1 BPM + Secondary):'),
            ...colorRow(3, 200, 'Color 3 (1/2 BPM + Preview):'),
            ...colorRow(4, 300, 'Color 4 (Waveform):'),
            ...colorRow(5, 400, 'Color 5 (Special Objects):'),
            btn(0, 500, 200, 50, 'ADD COLOR', 30, () => app.pickColor([255, 255, 255]).then(c => {
                if (c && s.noteColors.length < 32) {
                    s.noteColors.push(c);
                    save();
                }
            })),
            lbl(0, 470, 200, 26, 'Note Colors:'),
            lbl(0, 555, 195, 26, 'LMB: Remove\nRMB: Move left'),
            new NoteColors(210, 500, 75, 50),
            ...opacityRow(0, 'editorBGOpacity', 'Editor Background Opacity:'),
            ...opacityRow(100, 'gridOpacity', 'Grid Opacity:'),
            ...opacityRow(200, 'trackOpacity', 'Track Opacity:'),
        ]);

        const fpsLimit = { value: s.fpsLimit ?? 60 };
        const GraphicsNav = new G.Container(320, 0, 1220, 700, [
            chk(0, 0, 'Enable Waveform', 'waveform'),
            chk(0, 60, 'Use Classic Waveform', 'classicWaveform'),
            num(0, 150, 200, 50, 'waveformDetail', { increment: 1, isPositive: true, textSize: 30, bounds: [1, 250], style: G.Styles.Textbox_Uncolored }),
            lbl(0, 120, 200, 26, 'Waveform Level of Detail:'),
            chk(0, 300, 'Enable VSync', 'useVSync'),
            chk(0, 360, 'Limit Player FPS', 'limitPlayerFPS'),
            new G.Slider(0, 410, 400, 55, { get: () => fpsLimit.value, set: v => { fpsLimit.value = v; s.fpsLimit = v; save(); }, max: 305, step: 5, def: 60 }),
            new G.Label(0, 460, 400, 55, { textSize: 34, centerMode: None, text: '' }),
            chk(0, 510, 'Lower FPS in Background', 'lowerBackgroundFPS'),
            chk(700, 0, 'Use Anti-Aliasing', 'msaa'),
            chk(700, 60, 'Show Control Gradients', 'controlGradients'),
            lbl(700, 120, 200, 26, 'Font Scale:'),
            num(700, 150, 200, 50, 'fontScale', { increment: 0.05, isPositive: true, isFloat: true, textSize: 30, bounds: [0.25, 2.5], style: G.Styles.Textbox_Uncolored }),
            chk(700, 300, 'Grid Squircles', 'gridSquircles'),
            num(700, 390, 200, 50, 'gridSquircleDetail', { increment: 1, isPositive: true, textSize: 30, bounds: [1, 16], style: G.Styles.Textbox_Uncolored }),
            lbl(700, 360, 200, 26, 'Grid Squircle Corner Detail:'),
            num(700, 485, 200, 50, 'gridSquircleRadius', { increment: 0.025, isPositive: true, isFloat: true, textSize: 30, bounds: [0, 0.5], style: G.Styles.Textbox_Uncolored }),
            lbl(700, 455, 200, 26, 'Grid Squircle Corner Radius:'),
            new G.Square(955, 395, 40, 40, { color: [255, 255, 255], outline: true, stretch: 'None', cornerRadius: s.gridSquircleRadius }),
        ]);
        const fpsLabel = GraphicsNav.controls[7];
        const squirclePreview = GraphicsNav.controls[GraphicsNav.controls.length - 1];

        const MappingNav = new G.Container(320, 0, 1220, 700, [
            chk(0, 0, 'Enable Autosave', 'enableAutosave'),
            num(0, 90, 200, 50, 'autosaveInterval', { increment: 1, isPositive: true, isFloat: true, bounds: [0.1, 60], style: G.Styles.Textbox_Uncolored }),
            lbl(0, 60, 200, 26, 'Autosave Interval (min):'),
            chk(0, 215, 'Correct Errors on Copy', 'correctOnCopy'),
            chk(0, 275, 'Reverse Scroll Direction', 'reverseScroll'),
        ]);

        const games = ['Rhythia', 'Novastra', 'SSQE Player'];
        const notOnWeb = () => app.dialogs.message('Playtesting in Rhythia or Novastra isn\'t available in the web editor. Playtests always use the web player.');
        const PlayerNav = new G.Container(320, 0, 1220, 700, [
            ...games.map((g, i) => new G.Checkbox(0, i * 60, 45, 45, {
                text: g, textSize: 34, style: unc,
                get: () => (s.playtestGame || 'SSQE Player') === g,
                set: () => { s.playtestGame = g; save(); if (g !== 'SSQE Player') notOnWeb(); },
            })),
            pathBox(300, 0, 750, 50, 'RHYTHIA PATH', 30, () => '', notOnWeb),
            pathBox(300, 60, 750, 50, 'NOVASTRA PATH', 30, () => '', notOnWeb),
            new G.Checkbox(0, 180, 45, 45, {
                text: 'Open SSQE Player in Fullscreen', textSize: 34, style: unc,
                get: () => SSQESettings.load().fullscreenPlayer, set: v => { const ps = SSQESettings.load(); ps.fullscreenPlayer = v; SSQESettings.save(ps); },
            }),
        ]);

        const AudioNav = new G.Container(320, 0, 1220, 700, [
            chk(0, 0, 'Mono Audio', 'monoAudio'),
            num(0, 90, 200, 50, 'maxPolyphony', { increment: 1, isPositive: true, bounds: [1, 16], style: G.Styles.Textbox_Uncolored }),
            lbl(0, 60, 200, 26, 'Maximum Polyphony:'),
        ]);

        const OtherNav = new G.Container(320, 0, 1220, 700, [
            chk(0, 0, 'Skip Download From Roblox', 'skipDownload'),
            chk(0, 60, 'Check For Updates', 'checkUpdates'),
        ]);

        const navs = [['COLORS', ColorsNav], ['GRAPHICS', GraphicsNav], ['MAPPING', MappingNav], ['PLAYER', PlayerNav], ['AUDIO', AudioNav], ['OTHER', OtherNav]];
        const navButtons = navs.map(([t], i) => new G.Button(0, i * 100, 200, 50, { text: t, textSize: 30 }));
        const NavController = new G.Container(180, 80, 200, 550, [...navButtons, ...navs.map(n => n[1])]);
        new G.Radio(navButtons, 0, active => navs.forEach(([, panel], i) => panel.visible = navButtons[i] === active));

        let resetQuery = false, resetTimer = null;
        const resetButton = btn(700, 865, 500, 50, 'RESET TO DEFAULT', 30, () => {
            if (resetQuery) {
                const fresh = SSQE.Settings.clone(SSQE.Settings.DEFAULTS);
                for (const k of Object.keys(s))
                    delete s[k];
                Object.assign(s, fresh);
                save();
                resetQuery = false;
                resetButton.text = 'RESET TO DEFAULT';
            } else {
                resetQuery = true;
                resetButton.text = 'ARE YOU SURE?';
                clearTimeout(resetTimer);
                resetTimer = setTimeout(() => {
                    resetQuery = false;
                    resetButton.text = 'RESET TO DEFAULT';
                }, 5000);
            }
        });

        const controls = [
            background(),
            NavController,
            btn(660, 930, 600, 100, 'SAVE AND RETURN', 54, () => { save(); app.showMenu(); }),
            resetButton,
            btn(700, 810, 500, 50, 'OPEN EDITOR FOLDER', 30, () => app.dialogs.message('The web editor keeps its maps and audio in your browser, so there is no editor folder to open.')),
            btn(700, 755, 500, 50, 'CHANGE KEYBINDS', 30, () => app.openKeybinds()),
        ];

        const screen = new Screen(app, controls);
        screen.update = () => {
            const max = 305;
            fpsLabel.text = `FPS Limit: ${Math.round(fpsLimit.value) === Math.round(max) ? 'Unlimited' : Math.round(fpsLimit.value + 60)}`;
            squirclePreview.cornerRadius = s.gridSquircleRadius;
        };
        return screen;
    }

    // ---------------------------------------------------------------- GuiWindowKeybinds

    function keybinds(app) {
        const s = app.settings;
        const unc = [[255, 255, 255], [75, 75, 75], [13, 13, 13], [52, 52, 52], [255, 255, 255]];
        const D = SSQE.Settings.KEYBINDS;
        const save = () => SSQE.Settings.save(s);
        const name = code => SSQE.Settings.keyName(code).toUpperCase();
        const cas = b => [b.ctrl && 'CTRL', b.alt && 'ALT', b.shift && 'SHIFT'].filter(Boolean).join(' + ');

        const controls = [background()];
        const keybind = (x, y, label, key) => {
            controls.push(
                new G.Label(x, y, 128, 26, { text: label, textSize: 28, centerMode: None }),
                new G.Label(x + 276, y + 30, 256, 40, { textSize: 28, centerMode: None, process() { this.text = cas(s.keybinds[key]); } }),
                new KeybindBox(x, y + 30, 128, 40, {
                    textSize: 28, getText: () => name(s.keybinds[key].key),
                    onKey: (code, ctrl, alt, shift) => { s.keybinds[key] = { key: code, ctrl, alt, shift }; save(); },
                }),
                new G.Button(x + 138, y + 30, 128, 40, { text: 'RESET', textSize: 28, onLeftClick: () => { s.keybinds[key] = { ...D[key] }; save(); } }),
            );
        };

        keybind(1366, 100, 'Horizontal Flip', 'hFlip');
        keybind(1366, 180, 'Vertical Flip', 'vFlip');
        keybind(1366, 260, 'Store Bezier Nodes', 'storeNodes');
        keybind(1366, 340, 'Anchor Bezier Node', 'anchorNode');
        keybind(1366, 420, 'Draw Bezier Curve', 'drawBezier');
        keybind(150, 100, 'Switch Click Function', 'switchClickTool');
        keybind(150, 180, 'Toggle Quantum', 'quantum');
        keybind(150, 300, 'Open Timings', 'openTimings');
        keybind(150, 380, 'Open Bookmarks', 'openBookmarks');
        keybind(150, 540, 'Export SSPM', 'exportSSPM');
        keybind(150, 620, 'Create Timing Point', 'createBPM');

        controls.push(new G.Label(778, 49, 128, 26, { text: 'Grid', textSize: 28, centerMode: None }));
        const defaults = SSQE.Settings.GRID_KEYS;
        for (let i = 0; i < 9; i++) {
            const x = 778 + (i % 3) * 138, y = 75 + Math.trunc(i / 3) * 94;
            controls.push(
                new KeybindBox(x, y, 128, 40, {
                    textSize: 28, getText: () => name(s.gridKeys[i]),
                    onKey: code => { s.gridKeys[i] = code; save(); },
                }),
                new G.Button(x, y + 44, 128, 40, { text: 'RESET', textSize: 36, onLeftClick: () => { s.gridKeys[i] = defaults[i]; save(); } }),
            );
        }

        controls.push(new G.Label(480, 375, 960, 555, {
            textSize: 20,
            text: ['Static keybinds:', '', '> Zoom: CTRL + SCROLL', '', '> Beat Divisor: SHIFT + SCROLL', '>> Hold CTRL to increment by 0.5', '',
                '> Seek: SCROLL/LEFT/RIGHT', '> Play/Pause: SPACE', '', '> Select all: CTRL + A', '> Deselect all: ESCAPE', '',
                '> Delete: DELETE/BACKSPACE', '> Copy: CTRL + C', '> Paste: CTRL + V', '> Cut: CTRL + X', '> Undo: CTRL + Z', '> Redo: CTRL + Y', '',
                '> Fullscreen: F11', '> Save: CTRL + S', '> Save as: CTRL + SHIFT + S', '', '> Place stored patterns: 0-9',
                '>> Hold SHIFT to store selected notes as the key\'s pattern', '>> Hold CTRL to clear the key\'s pattern'].join('\n'),
        }));

        const screen = new Screen(app, controls);
        const held = key => new G.Checkbox(64, 0, 64, 64, { textSize: 36, style: unc, get: () => screen.win.keys[key], set: () => { } });
        const ctrl = held('ctrl'), alt = held('alt'), shift = held('shift');
        ctrl.origin.y = 828; ctrl.text = 'CTRL Held';
        alt.origin.y = 912; alt.text = 'ALT Held';
        shift.origin.y = 996; shift.text = 'SHIFT Held';
        screen.win.root.controls.push(
            new G.Button(655, 930, 600, 100, { text: 'RETURN TO SETTINGS', textSize: 52, onLeftClick: () => app.openSettings() }),
            ctrl, alt, shift);
        screen.win.setWindowRefs(screen.win.root);
        return screen;
    }

    SSQE.Screens = { Screen, menu, create, settings, keybinds, wrapText };
})();
