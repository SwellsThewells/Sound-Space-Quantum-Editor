'use strict';

// Spectating someone (web and desktop, see online.js): the screen becomes a copy of their editor, as they see it 5
// seconds ago. A real editor (editor.js), with their map, panels, zoom, selection and settings, scrolling and playing
// as theirs did, their mouse moving over it (buttons light up under it as they did for them), and nothing in it can
// be changed: the only things that work are STOP WATCHING and Escape.
(function () {
    const G = SSQE.GUI;
    const { Note, clamp } = SSQE;

    // What came in, played back DELAY later on the mapper's own clock: each message carries the time it was sent,
    // and the gap between that and when it came in (the shortest yet: the clocks' difference plus the quickest the
    // connection has been) turns it into a time here. So the view runs as evenly as the mapper's editor did, however
    // unevenly the messages arrive.
    class Feed {
        constructor(delay) {
            this.delay = delay;
            this.offset = null;
            this.queue = [];
            this.samples = [];
            this.heard = 0;
        }

        push(p, at) {
            const off = at - p.st;
            this.offset = this.offset === null ? off : Math.min(this.offset, off);
            this.queue.push(p);
            for (const s of p.s || [])
                this.samples.push({ at: p.st + s[0], x: s[1], y: s[2], b: s[3], t: s[4], p: s[5] });
            this.heard = at;
        }

        // the sender's time shown now
        get now() {
            return this.offset === null ? -Infinity : Date.now() - this.offset - this.delay;
        }

        // the messages due by now, oldest first
        due() {
            const now = this.now, out = [];
            while (this.queue.length && this.queue[0].st <= now)
                out.push(this.queue.shift());
            return out;
        }

        // the mouse and song position now, in between the samples either side
        pointer(rate) {
            const now = this.now, s = this.samples;
            while (s.length > 2 && s[1].at <= now - 1000)
                s.shift();
            if (!s.length || s[0].at > now)
                return null;
            let i = 0;
            while (i + 1 < s.length && s[i + 1].at <= now)
                i++;
            const a = s[i], b = s[i + 1];
            if (!b) {
                // (past the last one: a song that's playing goes on playing)
                const ahead = Math.min(1000, now - a.at);
                return { x: a.x, y: a.y, b: a.b, t: a.p ? a.t + ahead * rate : a.t, p: a.p };
            }
            const f = (now - a.at) / Math.max(1, b.at - a.at);
            // (a jump in the song, a seek, isn't swept through)
            const t = Math.abs(b.t - a.t) > 2000 ? a.t : a.t + (b.t - a.t) * f;
            return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, b: a.b, t, p: a.p };
        }
    }

    const parseRanges = text => {
        const out = [];
        for (const part of (text || '').split(',')) {
            if (!part)
                continue;
            const [a, b] = part.split('-').map(Number);
            for (let i = a; i <= (b ?? a) && out.length < 200000; i++)
                out.push(i);
        }
        return out;
    };

    class MirrorEditor extends SSQE.Editor {
        constructor(app, mapper, onExit) {
            // (their settings land on a copy: the watcher's own are never touched, and never saved)
            const settings = SSQE.Settings.load();
            settings.mirror = true;
            const view = Object.create(app);
            view.settings = settings;
            const map = new SSQE.Map();
            map.duration = 1;
            const music = {
                isPlaying: false, ended: false, tempo: 1, waveform: null, musicOffset: 0,
                setTempo() { }, play() { }, seek() { }, updateVolume() { },
                pause: () => this.currentTime,
                currentTimeMs: () => this.currentTime,
            };
            super(view, map, music);
            this.mapper = mapper;
            this.onExit = onExit;
            this.feed = new Feed(SSQEOnline.DELAY);
            this.state = null;
            this.pointerNow = null;
            this.navs = '';
            this.own = { x: -1, y: -1 };
            this.stopRect = null;
            this.started = Date.now();
        }

        // ------------------------------------------------ input: only leaving
        attachInput() {
            this.handlers = {
                mousemove: e => {
                    this.own = { x: e.clientX, y: e.clientY };
                },
                mousedown: e => {
                    if (e.target !== this.canvas)
                        return;
                    const r = this.stopRect;
                    if (r && e.clientX >= r.x && e.clientX <= r.x + r.w && e.clientY >= r.y && e.clientY <= r.y + r.h) {
                        SSQE.Sounds && SSQE.Sounds.click && SSQE.Sounds.click();
                        this.exit();
                    }
                },
                keydown: e => {
                    if (e.key === 'Escape')
                        this.exit();
                },
                contextmenu: e => {
                    if (e.target === this.canvas)
                        e.preventDefault();
                },
            };
            for (const [k, h] of Object.entries(this.handlers))
                window.addEventListener(k, h);
            this.fit = G.fitCanvas(this.canvas, (w, h) => this.resize(w, h));
        }

        detachInput() {
            for (const [k, h] of Object.entries(this.handlers))
                window.removeEventListener(k, h);
            this.fit.dispose();
        }

        exit() {
            if (!this.running)
                return;
            this.stop();
            SSQEOnline.unwatch();
            this.onExit && this.onExit();
        }

        start() {
            super.start();
            SSQEOnline.watch(this.mapper.id, (p, at) => this.feed.push(p, at));
        }

        // ------------------------------------------------ what came in
        rebuild() {
            const s = this.settings;
            this.ui = SSQE.buildEditorWindow(this);
            this.win = new G.Window(this.app, this.ui.controls);
            this.win.keys = this.keys;
            if (this.map.renderMode === SSQE.RenderMode.Special) {
                const om = this.map.objectMode;
                this.ui.setSpecial(true);
                this.map.objectMode = om;
            }
            this.navs = `${s.lastLeftNav}|${s.lastRightNav}|${this.map.renderMode}`;
            this.fit && this.resize(this.canvas.clientWidth || window.innerWidth, this.canvas.clientHeight || window.innerHeight);
        }

        apply(p) {
            const map = this.map, s = this.settings;
            this.state = p;
            map.duration = Math.max(1, p.dur || 1);
            if (p.set) {
                for (const [k, v] of Object.entries(p.set))
                    if (k in SSQE.Settings.DEFAULTS && typeof v === typeof SSQE.Settings.DEFAULTS[k])
                        s[k] = v;
                s.lastLeftNav = p.set.leftNav || '';
                s.lastRightNav = p.set.rightNav || '';
            }
            if (p.map) {
                const items = [];
                for (const part of (p.map.notes || '').split(',')) {
                    if (!part)
                        continue;
                    const [x, y, ms] = part.split('|').map(Number);
                    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(ms))
                        items.push(new Note(x, y, ms));
                }
                map.notes.items = items;
                try {
                    SSQE.Formats.readIni(map, p.map.extra || '{}');
                } catch { /* what could be read stays */ }
            }
            const v = p.v || {};
            map.zoom = v.zoom ?? map.zoom;
            map.beatDivisor = v.div ?? map.beatDivisor;
            map.tempoSlider = v.tempo ?? map.tempoSlider;
            map.renderMode = v.rm ?? map.renderMode;
            map.objectMode = v.om ?? map.objectMode;
            if (p.sel !== undefined) {
                const [n, sp, vfx] = p.sel.split('/');
                map.notes.selected = parseRanges(n).map(i => map.notes.items[i]).filter(Boolean);
                map.specialObjects.selected = parseRanges(sp).map(i => map.specialObjects.items[i]).filter(Boolean);
                map.vfxObjects.selected = parseRanges(vfx).map(i => map.vfxObjects.items[i]).filter(Boolean);
            }
            this.selecting = v.sel !== null && v.sel !== undefined;
            if (this.selecting)
                this.selectMsStart = v.sel;
            if (`${s.lastLeftNav}|${s.lastRightNav}|${map.renderMode}` !== this.navs)
                this.rebuild();
        }

        // ------------------------------------------------ frame
        frame(now) {
            if (!this.running)
                return;
            const frametime = Math.max(0, (now - this.lastFrame) / 1000);
            this.lastFrame = now;

            for (const p of this.feed.due())
                this.apply(p);
            const ptr = this.state && this.feed.pointer((this.state.v && this.state.v.rate) || 1);
            this.pointerNow = ptr;
            const W = this.win.width, H = this.win.height;
            if (ptr) {
                this.music.isPlaying = !!ptr.p;
                this.currentTime = clamp(ptr.t, 0, this.totalTime);
                // (their mouse over their editor: what lit up under it for them lights up here)
                const x = ptr.x * W, y = ptr.y * H;
                this.mouse.x = x;
                this.mouse.y = y;
                this.win.mouseMove(x, y);
                this.gridMouseMove(x, y);
                this.trackMouseMove(x, y);
            }
            this.trackPreRender();
            this.render(frametime);
            this.overlay(W, H);

            this.raf = requestAnimationFrame(t => this.frame(t));
        }

        overlay(W, H) {
            const ctx = this.ctx, k = H / 1080;
            const st = this.state, ptr = this.pointerNow;
            const scr = st && st.v ? st.v.scr : 'editor';
            // (waiting, or they're not in the editor right now: say so over it)
            let msg = '';
            if (!st || !ptr)
                msg = Date.now() - this.started > 15000 && !this.feed.heard
                    ? `Nothing from ${this.mapper.name} yet.\nThey may have stopped mapping, or turned watching off.`
                    : `Watching ${this.mapper.name}...\n(everything shows ${SSQEOnline.DELAY / 1000} seconds after it happens)`;
            else if (Date.now() - this.feed.heard > 10000)
                msg = `${this.mapper.name} has stopped sending.\nThey may have closed the map, or turned watching off.`;
            else if (scr === 'playtest')
                msg = `${this.mapper.name} is playtesting the map`;
            else if (scr === 'away')
                msg = `${this.mapper.name} is in the menu`;
            if (msg) {
                ctx.fillStyle = 'rgba(0,0,0,0.6)';
                ctx.fillRect(0, 0, W, H);
                const lines = msg.split('\n');
                lines.forEach((line, i) => this.text(line, W / 2, H / 2 + (i - lines.length / 2) * 50 * k, (i ? 26 : 40) * k, '#fff', 'center', 'top'));
            }
            // their mouse
            if (ptr && !msg) {
                const x = ptr.x * W, y = ptr.y * H, c = 22 * k;
                if (ptr.b) {
                    ctx.beginPath();
                    ctx.arc(x, y, 14 * k, 0, Math.PI * 2);
                    ctx.fillStyle = ptr.b & 2 ? 'rgba(255,90,90,0.45)' : 'rgba(255,255,255,0.4)';
                    ctx.fill();
                }
                ctx.beginPath();
                ctx.moveTo(x, y);
                ctx.lineTo(x, y + c);
                ctx.lineTo(x + c * 0.28, y + c * 0.75);
                ctx.lineTo(x + c * 0.48, y + c * 1.15);
                ctx.lineTo(x + c * 0.62, y + c * 1.08);
                ctx.lineTo(x + c * 0.43, y + c * 0.7);
                ctx.lineTo(x + c * 0.75, y + c * 0.7);
                ctx.closePath();
                ctx.fillStyle = '#fff';
                ctx.fill();
                ctx.lineWidth = Math.max(1, 1.5 * k);
                ctx.strokeStyle = '#000';
                ctx.stroke();
                this.text(this.mapper.name, x + c * 0.8, y + c * 1.1, 20 * k, '#fff');
            }
            // the bar: who, and the way out
            const bw = 760 * k, bh = 54 * k, bx = (W - bw) / 2, by = 880 * k;
            ctx.fillStyle = 'rgba(0,0,0,0.7)';
            ctx.fillRect(bx, by, bw, bh);
            ctx.strokeStyle = 'rgba(255,255,255,0.35)';
            ctx.lineWidth = Math.max(1, 2 * k);
            ctx.strokeRect(bx, by, bw, bh);
            const title = st ? st.title : this.mapper.map;
            this.text(`WATCHING ${this.mapper.name} - ${title}`.slice(0, 44), bx + 16 * k, by + 8 * k, 22 * k, '#fff');
            this.text(`${SSQEOnline.DELAY / 1000} s behind${st && st.v && st.v.dlg ? ' - they have a window open' : ''}`, bx + 16 * k, by + 32 * k, 16 * k, '#aaa');
            const sw = 210 * k, sx = bx + bw - sw - 8 * k, sy = by + 8 * k, sh = bh - 16 * k;
            const hover = this.own.x >= sx && this.own.x <= sx + sw && this.own.y >= sy && this.own.y <= sy + sh;
            ctx.fillStyle = hover ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.1)';
            ctx.fillRect(sx, sy, sw, sh);
            this.text('STOP WATCHING', sx + sw / 2, sy + sh / 2, 22 * k, '#fff', 'center', 'middle');
            this.stopRect = { x: sx, y: sy, w: sw, h: sh };
        }
    }

    // watch a mapper ({ id, name, map } from the live list); back to the spectate screen when done
    function start(app, mapper) {
        if (app.screen) {
            app.screen.stop();
            app.screen = null;
        }
        G.crossfade && G.crossfade(document.getElementById('editor-canvas'));
        document.body.dataset.screen = 'spectating';
        const ed = new MirrorEditor(app, mapper, () => {
            app.spectating = null;
            app.showScreen('spectate');
        });
        app.spectating = ed;
        ed.start();
        return ed;
    }

    SSQE.Spectator = { start, MirrorEditor, Feed };
})();
