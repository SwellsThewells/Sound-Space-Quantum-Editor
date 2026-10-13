'use strict';

// Port of the editor's own GUI toolkit (NewGUI/Base and NewGUI/Controls) onto a 2D canvas, so the web version draws
// the same controls, at the same positions, with the same fonts and colours as the desktop editor.
//
// Coordinates follow the original: every control has an origin rect in 1920x1080 space that is stretched to the
// window (Control.Resize), and text is laid out exactly like StbFont does.
(function () {
    const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

    // ---------------------------------------------------------------- colours

    const C = {
        rgb: (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${(c[3] ?? 255) / 255 * a})`,
    };

    let settings = null; // editor settings (color1-5)
    const styleColor = (style, i) => {
        const v = style[i];
        if (v !== undefined && v !== null)
            return v;
        return settings ? settings[`color${i + 1}`] : [255, 255, 255];
    };

    // ControlStyle presets: [primary, secondary, tertiary, quaternary, quinary] (null = color1..5)
    const Styles = {
        None: [null, null, null, null, null],
        Button_Uncolored: [[26, 26, 26], [52, 52, 52], [255, 255, 255], null, null],
        Checkbox_Colored: [null, null, [13, 13, 13], [52, 52, 52], [255, 255, 255]],
        Textbox_Colored: [[26, 26, 26], null, [128, 128, 128], null, null],
        Textbox_Uncolored: [[26, 26, 26], [255, 255, 255], [128, 128, 128], null, null],
        Slider_Uncolored: [[255, 255, 255], [75, 75, 75], null, null, null],
        Transparent: [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
    };

    // ---------------------------------------------------------------- fonts (NewGUI/Font/StbFont.cs)

    const FONT_FAMILIES = { main: 'SSQE-main', semibold: 'SSQE-semibold', square: 'SSQE-square' };
    const fontInfo = {};

    function prepareFont(name, originSize) {
        const key = `${name}|${originSize}`;
        if (fontInfo[key])
            return fontInfo[key];

        const m = window.SSQE_FONT_METRICS[name];
        const scale = originSize / (m.ascent - m.descent);
        const extents = new Array(128).fill(0);
        const bearings = new Array(128).fill(0);

        for (let i = 0; i < 128; i++) {
            const g = m.glyphs[i];
            if (!g) {
                extents[i] = i === 32 ? originSize / 4 : 0;
                continue;
            }
            const ix0 = Math.floor(g[0] * scale);
            const ix1 = Math.ceil(g[1] * scale);
            extents[i] = ix1;
            bearings[i] = ix0;
        }

        const baselineAscent = Math.trunc(scale * m.ascent);
        const info = {
            family: FONT_FAMILIES[name],
            originSize,
            extents,
            bearings,
            baselineAscent,
            baseline: baselineAscent - Math.trunc(scale * m.descent),
            // canvas font size giving the same glyph scale as stbtt_ScaleForPixelHeight
            emPerPixelHeight: m.unitsPerEm / (m.ascent - m.descent),
        };
        fontInfo[key] = info;
        return info;
    }

    function fontKey(font) {
        const small = font.endsWith('-s');
        return [small ? font.slice(0, -2) : font, small ? 24 : 128];
    }

    function charCode(c) {
        let code = c.charCodeAt(0);
        if (code === 0x202F || code === 0x00A0)
            code = 32;
        return code;
    }

    const Text = {
        // FontRenderer.GetWidth
        width(text, size, font = 'main') {
            const f = prepareFont(...fontKey(font));
            let max = 0;
            for (const line of String(text).split('\n')) {
                let x = 0;
                for (const c of line) {
                    const code = charCode(c);
                    x += f.extents[code < 128 ? code : 0] + f.originSize / 32;
                }
                max = Math.max(max, x);
            }
            return max * size / f.originSize;
        },

        // FontRenderer.GetHeight
        height(size, font = 'main') {
            const f = prepareFont(...fontKey(font));
            return f.baseline * size / f.originSize;
        },

        // FontRenderer.Print + render, (x, y) is the top-left of the first line
        draw(ctx, text, x, y, size, font, color, alpha = 1) {
            if (!text || size <= 0)
                return;
            const f = prepareFont(...fontKey(font));
            const k = size / f.originSize;
            ctx.font = `${size * f.emPerPixelHeight}px "${f.family}"`;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'alphabetic';
            ctx.fillStyle = typeof color === 'string' ? color : C.rgb(color, alpha);

            let cx = x, cy = y;
            for (const c of String(text)) {
                if (c === '\n') {
                    cx = x;
                    cy += size;
                    continue;
                }
                let code = charCode(c);
                if (code > 127)
                    code = 0;

                if (cx > x)
                    cx += f.bearings[code] * k;
                // glyph bitmap left edge sits at cx; the canvas origin is one bearing further left
                if (c !== ' ')
                    ctx.fillText(code === 0 && c.charCodeAt(0) !== 0 ? c : String.fromCharCode(code), cx - f.bearings[code] * k, cy + f.baselineAscent * k);
                cx += f.extents[code] * k;
                cx -= (f.bearings[code] - f.originSize / 32) * k;
            }
        },
    };

    function loadFonts() {
        const loads = Object.entries(FONT_FAMILIES).map(([name, family]) => {
            const face = new FontFace(family, `url("assets/fonts/${name}.ttf")`);
            document.fonts.add(face);
            return face.load().catch(e => console.warn('Font failed to load', name, e));
        });
        return Promise.all(loads);
    }

    // ---------------------------------------------------------------- textures

    const textures = {};
    function texture(name) {
        if (!textures[name]) {
            const img = new Image();
            img.src = `assets/${name}.png`;
            textures[name] = img;
        }
        return textures[name];
    }

    function drawTile(ctx, img, rect, tileSize, tileIndex, alpha = 1) {
        if (!img.complete || !img.naturalWidth)
            return;
        const tw = img.naturalWidth / tileSize[0], th = img.naturalHeight / tileSize[1];
        const tx = tileIndex % tileSize[0], ty = Math.trunc(tileIndex / tileSize[0]);
        ctx.globalAlpha = alpha;
        ctx.drawImage(img, tx * tw, ty * th, tw, th, rect.x, rect.y, rect.w, rect.h);
        ctx.globalAlpha = 1;
    }

    // ---------------------------------------------------------------- shapes (GLVerts.Squircle / SquircleOutline)

    function squirclePath(ctx, r, cornerRadius) {
        const min = Math.min(r.w, r.h);
        const rad = cornerRadius > 0 ? Math.min(cornerRadius * min, min / 2) : 0;
        ctx.beginPath();
        if (rad > 0 && ctx.roundRect)
            ctx.roundRect(r.x, r.y, r.w, r.h, rad);
        else
            ctx.rect(r.x, r.y, r.w, r.h);
    }

    function fillSquircle(ctx, r, cornerRadius, color, alpha = 1) {
        if (alpha <= 0)
            return;
        squirclePath(ctx, r, cornerRadius);
        ctx.fillStyle = C.rgb(color, alpha);
        ctx.fill();
    }

    function strokeSquircle(ctx, r, cornerRadius, lineWidth, color, alpha = 1) {
        squirclePath(ctx, r, cornerRadius);
        ctx.strokeStyle = C.rgb(color, alpha);
        ctx.lineWidth = lineWidth;
        ctx.stroke();
    }

    // ---------------------------------------------------------------- animation (Base/Animator.cs)

    class AnimatedValue {
        constructor(duration, scale, style = 8, direction = 1) {
            this.duration = duration;
            this.scale = scale;
            this.style = style;
            this.direction = direction;
            this.time = 0;
            this.reversed = false;
            this.playing = false;
            this.speed = 1;
        }

        get value() {
            return SSQE.Easing.process(0, 1, this.time / this.duration, this.style, this.direction) * this.scale;
        }

        process(dt) {
            if (!this.playing)
                return;
            this.time = clamp(this.time + (this.reversed ? -dt : dt) * this.speed, 0, this.duration);
        }
    }

    // ---------------------------------------------------------------- controls (Base/Control.cs, TextControl.cs, InteractiveControl.cs)

    const CenterMode = { None: 0, X: 1, Y: 2, XY: 3 };

    class Control {
        constructor(x, y, w, h, props = {}) {
            this.origin = { x, y, w, h };
            this.rect = { x, y, w, h };
            this.offset = { x: 0, y: 0 };
            this.stretch = 'XY';
            this.visible = true;
            this.cornerRadius = 0.125;
            this.lineThickness = 2;
            this.style = Styles.None;
            this.renderOnTop = false;
            this.anims = {};

            // TextControl
            this.text = '';
            this.textSize = 0;
            this.font = 'main';
            this.textAlpha = 1;
            this.textColor = [255, 255, 255];
            this.colorSetting = null;
            this.centerMode = CenterMode.XY;
            this.xOffset = 0;
            this.yOffset = 0;
            this.prefix = '';
            this.suffix = '';
            this.textPadding = { x: 0, y: 0 };

            this.init && this.init();
            Object.assign(this, props);
        }

        // Control.Resize
        resize(sw, sh) {
            const wd = sw / 1920, hd = sh / 1080;
            let x = this.origin.x * wd, y = this.origin.y * hd, w = this.origin.w * wd, h = this.origin.h * hd;
            const min = Math.min(wd, hd);

            if (!this.stretch.includes('X')) {
                const width = this.origin.w * min;
                x += (w - width) / 2;
                w = width;
            }
            if (!this.stretch.includes('Y')) {
                const height = this.origin.h * min;
                y += (h - height) / 2;
                h = height;
            }

            this.rect = { x: x + this.offset.x * wd, y: y + this.offset.y * hd, w, h };
        }

        get textScale() {
            return Math.min(this.rect.w / this.origin.w, this.rect.h / this.origin.h);
        }

        get scaledTextSize() {
            return this.textSize * this.textScale;
        }

        get renderedText() {
            return this.prefix + this.text + this.suffix;
        }

        contains(x, y) {
            const r = this.rect;
            return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
        }

        process(dt) {
            for (const a of Object.values(this.anims))
                a.process(dt);
        }

        draw() { }

        // TextControl.Update + PostRender
        drawText(ctx) {
            const text = this.renderedText;
            if (!text || !this.textSize)
                return;
            const size = this.scaledTextSize;
            let tx = this.rect.x + this.xOffset, ty = this.rect.y + this.yOffset;

            if (this.centerMode & CenterMode.X)
                tx = this.rect.x + this.rect.w / 2 - Text.width(text, size, this.font) / 2 + this.xOffset;
            else
                tx += this.textPadding.x;

            if (this.centerMode & CenterMode.Y)
                ty = this.rect.y + this.rect.h / 2 - Text.height(size, this.font) * text.split('\n').length / 2 + this.yOffset;
            else
                ty += this.textPadding.y;

            const color = this.colorSetting ? settings[this.colorSetting] : this.textColor;
            Text.draw(ctx, text, tx, ty, size, this.font, color, this.textAlpha);
        }
    }

    class Interactive extends Control {
        init() {
            this.hovering = false;
            this.dragging = false;
            this.focused = false;
            this.rightDragging = false;
            this.playLeftClickSound = true;
            this.playRightClickSound = true;
            this.onLeftClick = null;
            this.onRightClick = null;
            this.onLeftDown = null;
        }

        mouseEnter() {
            this.hovering = true;
        }

        mouseLeave() {
            this.hovering = false;
        }

        mouseDownLeft(x, y, window) {
            if (this.playLeftClickSound)
                SSQE.Audio.SoundPlayer.play('click', 0.035);
            this.focused = true;
            this.dragging = true;
            this.mouseMove(x, y);
            if (!(this instanceof Container))
                window.buttonClicked = true;
            this.onLeftDown && this.onLeftDown(x, y);
        }

        mouseDownLeftGlobal(x, y, window) {
            if (this.hovering && !window.buttonClicked)
                this.mouseDownLeft(x, y, window);
            else
                this.focused = false;
        }

        mouseDownRight(x, y, window) {
            if (this.playRightClickSound)
                SSQE.Audio.SoundPlayer.play('click', 0.035);
            this.rightDragging = true;
            window.buttonClicked = true;
        }

        mouseDownRightGlobal(x, y, window) {
            if (this.hovering)
                this.mouseDownRight(x, y, window);
        }

        mouseUpLeft(x, y) {
            this.dragging = false;
            if (this.hovering && this.onLeftClick)
                this.onLeftClick(x, y);
        }

        mouseUpLeftGlobal(x, y) {
            if (this.dragging)
                this.mouseUpLeft(x, y);
        }

        mouseUpRight(x, y) {
            this.rightDragging = false;
            if (this.hovering && this.onRightClick)
                this.onRightClick(x, y);
        }

        mouseUpRightGlobal(x, y) {
            if (this.rightDragging)
                this.mouseUpRight(x, y);
        }

        mouseMove() { }
        mouseScroll() { }
        mouseScrollGlobal(x, y, delta) {
            if (this.hovering)
                this.mouseScroll(x, y, delta);
        }
        keyDown() { }
        textInput() { }
        paste() { }
    }

    // ---------------------------------------------------------------- GuiLabel / GuiSquare

    class Label extends Control { }

    class Square extends Control {
        init() {
            this.cornerRadius = 0;
            this.color = [0, 0, 0, 0];
            this.outline = false;
            this.image = null;
        }

        // GuiSquareTextured: the square is drawn first and the texture on top with the colour's alpha
        draw(ctx) {
            const color = typeof this.color === 'function' ? this.color() : this.color;
            if (this.outline)
                strokeSquircle(ctx, this.rect, this.cornerRadius, this.lineThickness, color);
            else
                fillSquircle(ctx, this.rect, this.cornerRadius, color);
            if (this.image) {
                const img = texture(this.image);
                if (img.complete && img.naturalWidth) {
                    ctx.globalAlpha = (color[3] ?? 255) / 255;
                    ctx.drawImage(img, this.rect.x, this.rect.y, this.rect.w, this.rect.h);
                    ctx.globalAlpha = 1;
                }
            }
        }
    }

    // ---------------------------------------------------------------- GuiButton

    class Button extends Interactive {
        init() {
            super.init();
            this.style = Styles.Button_Uncolored;
            this.playRightClickSound = false;
            this.hoverIntensity = 0.05;
            this.clickIntensity = 0.04;
            this.gradient = true;
            this.anims.hover = new AnimatedValue(0.05, 1, 0);
            this.anims.hover.reversed = true;
            this.anims.hover.playing = true;
        }

        mouseEnter() {
            super.mouseEnter();
            this.anims.hover.reversed = false;
            this.anims.hover.speed = 1;
        }

        mouseLeave() {
            super.mouseLeave();
            this.anims.hover.reversed = true;
            this.anims.hover.speed = 0.35;
        }

        draw(ctx) {
            const s = this.style;
            fillSquircle(ctx, this.rect, this.cornerRadius, styleColor(s, 0));

            if (this.gradient && settings.controlGradients !== false) {
                ctx.save();
                squirclePath(ctx, this.rect, this.cornerRadius);
                ctx.clip();
                const g = ctx.createLinearGradient(0, this.rect.y, 0, this.rect.y + this.rect.h);
                g.addColorStop(0, 'rgba(255,255,255,0)');
                g.addColorStop(1, `rgba(255,255,255,${11 / 255})`);
                ctx.fillStyle = g;
                ctx.fillRect(this.rect.x, this.rect.y, this.rect.w, this.rect.h);
                ctx.restore();
            }

            fillSquircle(ctx, this.rect, this.cornerRadius, styleColor(s, 2), this.anims.hover.value * this.hoverIntensity);
            fillSquircle(ctx, this.rect, this.cornerRadius, styleColor(s, 2), this.dragging ? this.clickIntensity : 0);
            strokeSquircle(ctx, this.rect, this.cornerRadius, this.lineThickness, styleColor(s, 1));
        }
    }

    // GuiButtonTextured / GuiButtonToggle / GuiButtonPlayPause
    class TexturedButton extends Button {
        init() {
            super.init();
            this.stretch = 'None';
            this.gradient = false;
            this.textureName = '';
            this.tileSize = [1, 1];
            this.tileIndex = 0;
        }

        // Control.Render draws the button shapes first and the texture on top
        draw(ctx) {
            super.draw(ctx);
            drawTile(ctx, texture(this.textureName), this.rect, this.tileSize, typeof this.tileIndex === 'function' ? this.tileIndex() : this.tileIndex);
        }
    }

    // ---------------------------------------------------------------- GuiCheckbox

    class Checkbox extends Interactive {
        init() {
            super.init();
            this.style = Styles.Checkbox_Colored;
            this.playRightClickSound = false;
            this.centerMode = CenterMode.Y;
            this.cornerRadius = 0.5;
            this.get = () => false;
            this.set = () => { };
            this.anims.check = new AnimatedValue(0.125, 0.75);
            this.anims.check.playing = true;
            this.anims.hover = new AnimatedValue(0.075, 0.05, 0);
            this.anims.hover.reversed = true;
            this.anims.hover.playing = true;
            this.onLeftClick = () => this.set(!this.get());
            this.first = true;
        }

        mouseEnter() {
            super.mouseEnter();
            this.anims.hover.reversed = false;
        }

        mouseLeave() {
            super.mouseLeave();
            this.anims.hover.reversed = true;
        }

        process(dt) {
            const on = !!this.get();
            this.anims.check.reversed = !on;
            if (this.first) {
                this.anims.check.time = on ? this.anims.check.duration : 0;
                this.first = false;
            }
            super.process(dt);
        }

        draw(ctx) {
            const s = this.style;
            const r = this.rect;
            const width = Math.min(r.w, r.h);
            const hGap = (r.h - width) / 2;
            const square = { x: r.x, y: r.y + hGap, w: width, h: width };
            const cWidth = width * this.anims.check.value;
            const cGap = (width - cWidth) / 2;
            const check = { x: r.x + cGap, y: r.y + hGap + cGap, w: cWidth, h: cWidth };

            this.textColor = styleColor(s, 0);
            this.xOffset = width * 1.15;

            fillSquircle(ctx, square, this.cornerRadius, styleColor(s, 2));
            strokeSquircle(ctx, square, this.cornerRadius, this.lineThickness, styleColor(s, 3));
            if (cWidth > 0.5)
                fillSquircle(ctx, check, this.cornerRadius, styleColor(s, 1));
            fillSquircle(ctx, square, this.cornerRadius, styleColor(s, 4), this.anims.hover.value);
            fillSquircle(ctx, square, this.cornerRadius, styleColor(s, 4), this.dragging ? 0.04 : 0);
        }
    }

    // ---------------------------------------------------------------- GuiSlider

    class Slider extends Interactive {
        init() {
            super.init();
            this.style = Styles.Slider_Uncolored;
            this.reverse = false;
            this.canReset = true;
            this.shiftIncrement = 1;
            this.get = () => 0;
            this.set = () => { };
            this.max = 1;
            this.step = 0.01;
            this.def = 0;
            this.anims.hover = new AnimatedValue(0.1, 1);
            this.anims.hover.reversed = true;
            this.anims.hover.playing = true;
            this.playLeftClickSound = true;
        }

        get horizontal() {
            return this.rect.w > this.rect.h;
        }

        lineRect() {
            const r = this.rect;
            return this.horizontal
                ? { x: r.x + r.h / 2, y: r.y + r.h / 2 - 1.5, w: r.w - r.h, h: 3 }
                : { x: r.x + r.w / 2 - 1.5, y: r.y + r.w / 2, w: 3, h: r.h - r.w };
        }

        progress() {
            const max = typeof this.max === 'function' ? this.max() : this.max;
            let p = max === 0 ? 0.5 : this.get() / max;
            if (this.reverse)
                p = 1 - p;
            return p;
        }

        markerPos() {
            const line = this.lineRect();
            const p = this.progress();
            return this.horizontal ? [line.x + line.w * p, line.y + line.h / 2] : [line.x + line.w / 2, line.y + line.h * p];
        }

        mouseEnter() {
            super.mouseEnter();
            this.anims.hover.reversed = false;
        }

        mouseLeave() {
            super.mouseLeave();
            if (!this.dragging)
                this.anims.hover.reversed = true;
        }

        mouseUpLeft(x, y) {
            super.mouseUpLeft(x, y);
            if (!this.hovering)
                this.anims.hover.reversed = true;
        }

        mouseDownRight(x, y, window) {
            if (this.canReset) {
                this.set(this.def);
                this.onChange && this.onChange();
            }
            super.mouseDownRight(x, y, window);
        }

        mouseMove(x, y) {
            if (!this.dragging)
                return;
            const r = this.rect;
            const horizontal = this.horizontal;
            const max = typeof this.max === 'function' ? this.max() : this.max;
            const width = (r.h - r.w) * (horizontal ? -1 : 1);
            let step = this.step / max;
            if (!(this.window && this.window.keys.shift))
                step /= this.shiftIncrement;
            const pos = horizontal ? r.x + r.h / 2 : r.y + r.w / 2;
            const mouse = horizontal ? x : y;
            const raw = horizontal ? mouse - pos : this.reverse ? (width - mouse + pos) : mouse - pos;
            const progress = Math.round(raw / width / step) * step;
            this.set(clamp(max * progress, 0, max));
            this.onChange && this.onChange();
        }

        draw(ctx) {
            const s = this.style;
            const line = this.lineRect();
            fillSquircle(ctx, line, this.cornerRadius, styleColor(s, 1));

            const [cx, cy] = this.markerPos();
            ctx.beginPath();
            ctx.arc(cx, cy, 4, 0, Math.PI * 2);
            ctx.fillStyle = C.rgb(styleColor(s, 0));
            ctx.fill();

            const hover = this.anims.hover.value;
            if (hover > 0) {
                ctx.beginPath();
                const radius = 12 * hover, rot = (90 * hover) * Math.PI / 180;
                for (let k = 0; k < 6; k++) {
                    const a = rot + k * Math.PI / 3;
                    k ? ctx.lineTo(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius) : ctx.moveTo(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius);
                }
                ctx.closePath();
                ctx.strokeStyle = C.rgb(styleColor(s, 0));
                ctx.lineWidth = 2;
                ctx.stroke();
            }
        }
    }

    // ---------------------------------------------------------------- GuiTextbox / GuiTextboxNumeric

    class Textbox extends Interactive {
        init() {
            super.init();
            this.style = Styles.Textbox_Colored;
            this.playLeftClickSound = false;
            this.playRightClickSound = false;
            this.cursorPos = 0;
            this.cursorTime = 0;
            this.readOnly = false;
            this.multiLine = false;
            this.onTextEntered = null;
            this.onChange = null;
        }

        process(dt) {
            super.process(dt);
            this.cursorTime += dt * 2;
        }

        draw(ctx) {
            const s = this.style;
            this.textColor = styleColor(s, 1);
            fillSquircle(ctx, this.rect, this.cornerRadius, styleColor(s, 0));
            strokeSquircle(ctx, this.rect, this.cornerRadius, this.lineThickness, styleColor(s, 2));
        }

        drawText(ctx) {
            super.drawText(ctx);
            if (!this.focused || Math.trunc(this.cursorTime) % 2 !== 0)
                return;

            const size = this.scaledTextSize;
            this.cursorPos = clamp(this.cursorPos, 0, this.text.length);
            const before = this.text.slice(0, this.cursorPos);
            let x = Text.width(before, size, this.font) + this.rect.x;
            let y = this.rect.y;
            const h = Text.height(size, this.font);
            if (this.centerMode & CenterMode.X)
                x += this.rect.w / 2 - Text.width(this.text, size, this.font) / 2;
            else
                x += this.textPadding.x;
            if (this.centerMode & CenterMode.Y)
                y += this.rect.h / 2 - h / 2;
            else
                y += this.textPadding.y;

            ctx.fillStyle = C.rgb(styleColor(this.style, 1));
            ctx.fillRect(x - 1, y, 2, h);
        }

        setText(text) {
            this.text = text;
            this.onChange && this.onChange(text);
        }

        mouseDownLeft(x, y, window) {
            this.cursorTime = 0;
            super.mouseDownLeft(x, y, window);
            if (!this.text.length)
                return;
            const size = this.scaledTextSize;
            const width = Text.width(this.text, size, this.font);
            let posX = x - this.rect.x - (this.rect.w - width) / 2;
            posX = clamp(posX, 0, width);
            this.cursorPos = Math.floor(posX / (width / this.text.length) + 0.3);
        }

        wordIndex(stop, forward) {
            const t = this.text;
            if (forward) {
                let i = t.indexOf(' ', Math.max(stop, 0));
                return i < 0 ? t.length : i;
            }
            const i = t.lastIndexOf(' ', Math.max(stop - 1, 0));
            return Math.max(i, 0);
        }

        keyDown(e, window) {
            if (!this.focused)
                return false;
            const ctrl = e.ctrlKey || e.metaKey;
            this.cursorPos = clamp(this.cursorPos, 0, this.text.length);
            this.cursorTime = 0;
            const t = this.text;

            switch (e.key) {
                case 'c':
                case 'C':
                    if (ctrl && t.trim())
                        window.app.writeClipboard(t);
                    else if (!ctrl)
                        return this.insert(e.key);
                    return true;
                case 'x':
                case 'X':
                    if (ctrl && !this.readOnly) {
                        if (t.trim())
                            window.app.writeClipboard(t);
                        this.cursorPos = 0;
                        this.finish('');
                        return true;
                    }
                    return ctrl ? true : this.insert(e.key);
                case 'v':
                case 'V':
                    // pasting is handled by the paste event
                    return ctrl ? 'paste' : this.insert(e.key);
                case 'ArrowLeft':
                    this.cursorPos = ctrl ? this.wordIndex(this.cursorPos - 1, false) : this.cursorPos - 1;
                    break;
                case 'ArrowRight':
                    this.cursorPos = ctrl ? this.wordIndex(this.cursorPos + 1, true) : this.cursorPos + 1;
                    break;
                case 'Home':
                    this.cursorPos = 0;
                    break;
                case 'End':
                    this.cursorPos = t.length;
                    break;
                case 'Backspace':
                    if (this.readOnly)
                        break;
                    if (ctrl) {
                        const i = this.wordIndex(this.cursorPos - 1, false);
                        this.finish(t.slice(0, i) + t.slice(this.cursorPos), i);
                    } else if (t.length && this.cursorPos > 0)
                        this.finish(t.slice(0, this.cursorPos - 1) + t.slice(this.cursorPos), this.cursorPos - 1);
                    return true;
                case 'Delete':
                    if (this.readOnly)
                        break;
                    if (ctrl) {
                        const i = this.wordIndex(this.cursorPos + 1, true);
                        this.finish(t.slice(0, this.cursorPos) + t.slice(i), this.cursorPos);
                    } else if (this.cursorPos < t.length)
                        this.finish(t.slice(0, this.cursorPos) + t.slice(this.cursorPos + 1), this.cursorPos);
                    return true;
                case 'Enter':
                    if (this.readOnly)
                        break;
                    if (this.multiLine)
                        return this.insert('\n');
                    this.focused = false;
                    this.textEntered();
                    return true;
                case 'Escape':
                    this.focused = false;
                    return true;
                default:
                    if (e.key.length === 1 && !ctrl && !e.altKey)
                        return this.insert(e.key);
                    return false;
            }
            this.cursorPos = clamp(this.cursorPos, 0, this.text.length);
            return true;
        }

        textEntered() {
            this.onTextEntered && this.onTextEntered(this.text);
        }

        insert(str) {
            if (this.readOnly)
                return true;
            const t = this.text;
            this.finish(t.slice(0, this.cursorPos) + str + t.slice(this.cursorPos), this.cursorPos + str.length);
            return true;
        }

        paste(str) {
            if (!this.focused || this.readOnly || !str.trim())
                return;
            this.insert(this.multiLine ? str : str.replace(/\r?\n/g, ' '));
        }

        finish(text, cursor) {
            this.setText(text);
            if (cursor !== undefined)
                this.cursorPos = cursor;
            this.cursorPos = clamp(this.cursorPos, 0, this.text.length);
        }
    }

    class NumericTextbox extends Textbox {
        init() {
            super.init();
            this.isFloat = false;
            this.isPositive = false;
            this.bounds = [-Number.MAX_VALUE, Number.MAX_VALUE];
            this.get = null;
            this.set = null;
        }

        refresh() {
            if (this.get && !this.focused)
                this.text = String(+this.get().toFixed(6));
        }

        process(dt) {
            super.process(dt);
            this.refresh();
        }

        keyDown(e, window) {
            if (!this.focused)
                return false;
            const ctrl = e.ctrlKey || e.metaKey;
            const allowed = ['ArrowLeft', 'ArrowRight', 'Backspace', 'Delete', 'Enter', 'Escape', 'Home', 'End'];
            if (allowed.includes(e.key) || (ctrl && 'cvxCVX'.includes(e.key)))
                return super.keyDown(e, window);
            if (e.key.length === 1 && !ctrl) {
                if (this.isPositive && e.key === '-')
                    return true;
                return this.insert(e.key);
            }
            return false;
        }

        // GuiTextboxNumeric.FinishInput
        finish(text, cursor) {
            const prevText = this.text, prevCursor = this.cursorPos;
            let temp = text;
            if (!temp || temp === '-' || temp === '.')
                temp = '0';
            const valid = this.isFloat ? /^-?(\d+\.?\d*|\.\d+)$/.test(temp) : /^-?\d+$/.test(temp);

            if (valid) {
                this.text = text;
                if (cursor !== undefined)
                    this.cursorPos = cursor;
                let value = Math.max(parseFloat(temp), this.bounds[0]);
                if (value > this.bounds[1]) {
                    value = this.bounds[1];
                    this.text = String(value);
                }
                this.set && this.set(value);
                this.onValue && this.onValue(value);
            } else {
                this.text = prevText;
                this.cursorPos = prevCursor;
            }
            this.cursorPos = clamp(this.cursorPos, 0, this.text.length);
        }

        textEntered() {
            const v = parseFloat(this.text);
            if (!Number.isFinite(v) || v < this.bounds[0])
                this.text = String(this.bounds[0] === -Number.MAX_VALUE ? 0 : this.bounds[0]);
            super.textEntered();
        }
    }

    // ---------------------------------------------------------------- ControlContainer

    class Container extends Interactive {
        constructor(x, y, w, h, controls = [], props = {}) {
            super(x, y, w, h, props);
            this.controls = controls;
            this.playLeftClickSound = false;
            this.playRightClickSound = false;
        }

        get interactives() {
            const list = this.controls.filter(c => c instanceof Interactive);
            return [...list.filter(c => !c.renderOnTop), ...list.filter(c => c.renderOnTop)];
        }

        resize(sw, sh) {
            super.resize(sw, sh);
            for (const c of this.controls) {
                c.offset = { x: this.origin.x + this.offset.x, y: this.origin.y + this.offset.y };
                c.resize(sw, sh);
            }
        }

        process(dt) {
            super.process(dt);
            for (const c of this.controls)
                c.process(dt);
        }

        draw(ctx) {
            if (!this.visible)
                return;
            for (const c of this.controls)
                if (c.visible && !c.renderOnTop)
                    c.draw(ctx);
        }

        drawText(ctx) {
            if (!this.visible)
                return;
            for (const c of this.controls)
                if (c.visible && !c.renderOnTop)
                    c.drawText(ctx);
            for (const c of this.controls)
                if (c.visible && c.renderOnTop) {
                    c.draw(ctx);
                    c.drawText(ctx);
                }
        }

        mouseMove(x, y) {
            if (!this.visible)
                return;
            for (const c of this.interactives) {
                if (c.hovering && !c.contains(x, y))
                    c.mouseLeave(x, y);
                else if (c.visible && !c.hovering && c.contains(x, y))
                    c.mouseEnter(x, y);
                if (c.visible)
                    c.mouseMove(x, y);
            }
        }

        mouseDownLeftGlobal(x, y, window) {
            if (!this.visible)
                return;
            super.mouseDownLeftGlobal(x, y, window);
            const list = this.interactives;
            for (let i = list.length - 1; i >= 0; i--)
                if (list[i].visible)
                    list[i].mouseDownLeftGlobal(x, y, window);
        }

        mouseDownRightGlobal(x, y, window) {
            if (!this.visible)
                return;
            super.mouseDownRightGlobal(x, y, window);
            const list = this.interactives;
            for (let i = list.length - 1; i >= 0; i--)
                if (list[i].visible)
                    list[i].mouseDownRightGlobal(x, y, window);
        }

        mouseUpLeftGlobal(x, y) {
            if (!this.visible)
                return;
            super.mouseUpLeftGlobal(x, y);
            for (const c of this.interactives)
                if (c.visible)
                    c.mouseUpLeftGlobal(x, y);
        }

        mouseUpRightGlobal(x, y) {
            if (!this.visible)
                return;
            super.mouseUpRightGlobal(x, y);
            for (const c of this.interactives)
                if (c.visible)
                    c.mouseUpRightGlobal(x, y);
        }

        mouseScrollGlobal(x, y, delta) {
            if (!this.visible)
                return;
            super.mouseScrollGlobal(x, y, delta);
            for (const c of this.interactives)
                if (c.visible)
                    c.mouseScrollGlobal(x, y, delta);
        }

        keyDown(e, window) {
            if (!this.visible)
                return false;
            let handled = false;
            const list = this.interactives;
            for (let i = list.length - 1; i >= 0; i--)
                if (list[i].visible) {
                    const r = list[i].keyDown(e, window);
                    if (r === 'paste')
                        return 'paste';
                    handled = r || handled;
                }
            return handled;
        }

        paste(str) {
            for (const c of this.interactives)
                if (c.visible)
                    c.paste(str);
        }

        focusedTextbox() {
            for (const c of this.interactives) {
                if (!c.visible)
                    continue;
                if (c instanceof Container) {
                    const t = c.focusedTextbox();
                    if (t)
                        return t;
                } else if (c instanceof Textbox && c.focused)
                    return c;
            }
            return null;
        }

        hoveringInteractive(exclude) {
            for (const c of this.interactives) {
                if (!c.visible)
                    continue;
                if (c instanceof Container) {
                    if (c.hoveringInteractive(exclude))
                        return true;
                } else if (c.hovering && c !== exclude)
                    return true;
            }
            return false;
        }

        // GuiScrollingList / dropdown support: whether any child consumes scroll
        consumesScroll() {
            for (const c of this.interactives) {
                if (!c.visible)
                    continue;
                if (c instanceof Container ? c.consumesScroll() : (c.consumeScroll && c.hovering))
                    return true;
            }
            return false;
        }
    }

    // GuiNumberBox
    class NumberBox extends Container {
        constructor(x, y, w, h, props = {}) {
            const box = new NumericTextbox(0, 0, w - w / 8 - 2, h, { stretch: 'XY' });
            const up = new TexturedButton(w - w / 8, 0, w / 8, h / 2, { stretch: 'XY', textureName: 'Arrows', tileSize: [2, 1], tileIndex: 0 });
            const down = new TexturedButton(w - w / 8, h / 2, w / 8, h / 2, { stretch: 'XY', textureName: 'Arrows', tileSize: [2, 1], tileIndex: 1 });
            super(x, y, w, h, [box, up, down]);
            this.box = box;
            this.increment = 1;
            Object.assign(this, props);
            box.textSize = props.textSize ?? 31;
            box.isFloat = !!props.isFloat;
            box.isPositive = !!props.isPositive;
            if (props.bounds)
                box.bounds = props.bounds;
            if (props.style)
                box.style = props.style;
            box.get = props.get;
            box.set = props.set;
            up.onLeftClick = () => this.apply(this.increment);
            down.onLeftClick = () => this.apply(-this.increment);
        }

        apply(inc) {
            let value = (this.box.get ? this.box.get() : parseFloat(this.box.text) || 0) + inc;
            if (this.box.isPositive)
                value = Math.max(value, this.increment);
            if (!this.box.isFloat)
                value = Math.trunc(value);
            value = clamp(value, this.box.bounds[0], this.box.bounds[1]);
            value = Math.round(value * 1000) / 1000;
            this.box.set && this.box.set(value);
            this.box.text = String(value);
        }
    }

    // GuiButtonDropdown
    class Dropdown extends Container {
        constructor(x, y, w, h, props) {
            const options = props.options;
            const shown = Math.min(props.toShow ?? options.length, options.length);
            const main = new Button(0, 0, w, h, { cornerRadius: 0, textSize: props.textSize, prefix: props.prefix || '' });
            const buttons = options.map((o, i) => new Button(0, h * i, w, h, { text: o.toUpperCase(), cornerRadius: 0, textSize: props.textSize }));
            const list = new ScrollList(0, h, w, h * shown, buttons, { visible: false });
            super(x, y, w, h, [main, list]);
            this.renderOnTop = true;
            this.main = main;
            this.list = list;
            this.get = props.get;
            main.onLeftClick = () => list.visible = !list.visible;
            buttons.forEach((b, i) => b.onLeftClick = () => {
                list.visible = false;
                props.set(i);
            });
        }

        process(dt) {
            super.process(dt);
            this.main.text = String(this.get()).toUpperCase();
        }

        mouseDownLeftGlobal(x, y, window) {
            super.mouseDownLeftGlobal(x, y, window);
            if (!this.main.hovering && !this.list.hovering)
                this.list.visible = false;
        }
    }

    // GuiScrollingList (only what the dropdowns need)
    class ScrollList extends Container {
        constructor(x, y, w, h, controls, props) {
            super(x, y, w, h, controls, props);
            this.scroll = 0;
            this.consumeScroll = true;
        }

        resize(sw, sh) {
            super.resize(sw, sh);
            const hd = sh / 1080;
            for (const c of this.controls)
                c.rect.y -= this.scroll * hd;
        }

        mouseMove(x, y) {
            this.hovering = this.contains(x, y);
            super.mouseMove(x, y);
        }

        draw(ctx) {
            if (!this.visible)
                return;
            ctx.save();
            ctx.beginPath();
            ctx.rect(this.rect.x, this.rect.y, this.rect.w, this.rect.h);
            ctx.clip();
            super.draw(ctx);
            ctx.restore();
        }

        drawText(ctx) {
            if (!this.visible)
                return;
            ctx.save();
            ctx.beginPath();
            ctx.rect(this.rect.x, this.rect.y, this.rect.w, this.rect.h);
            ctx.clip();
            super.drawText(ctx);
            ctx.restore();
        }

        mouseScroll(x, y, delta) {
            const total = this.controls.length * (this.controls[0]?.origin.h || 0);
            this.scroll = clamp(this.scroll - delta * (this.controls[0]?.origin.h || 0), 0, Math.max(0, total - this.origin.h));
            if (this.window)
                this.resize(this.window.width, this.window.height);
        }
    }

    // GuiButtonList
    class ButtonList extends Button {
        init() {
            super.init();
            this.playRightClickSound = true;
            this.options = [];
            this.get = () => 0;
            this.set = () => { };
        }

        process(dt) {
            super.process(dt);
            this.text = String(this.options[this.get()] ?? '').toUpperCase();
        }

        mouseDownLeft(x, y, window) {
            this.set((this.get() + 1) % this.options.length);
            super.mouseDownLeft(x, y, window);
        }

        mouseDownRight(x, y, window) {
            this.set((this.options.length + this.get() - 1) % this.options.length);
            super.mouseDownRight(x, y, window);
        }
    }

    // RadioButtonController / GuiRadioPanelButton - the active button's text is shown as [TEXT]
    class Radio {
        constructor(buttons, activeIndex, onChange) {
            this.buttons = buttons;
            this.texts = buttons.map(b => b.text);
            this.active = null;
            this.onChange = onChange;
            buttons.forEach(b => b.onLeftClick = () => this.select(b));
            if (activeIndex !== null && activeIndex !== undefined)
                this.select(buttons[activeIndex], true);
        }

        select(button, silent = false) {
            if (this.active)
                this.active.text = this.texts[this.buttons.indexOf(this.active)];
            this.active = this.active === button ? null : button;
            if (this.active)
                this.active.text = `[${this.texts[this.buttons.indexOf(button)]}]`;
            this.onChange && this.onChange(this.active, silent);
        }

        clear() {
            if (this.active)
                this.active.text = this.texts[this.buttons.indexOf(this.active)];
            this.active = null;
            this.onChange && this.onChange(null, false);
        }
    }

    // ---------------------------------------------------------------- GuiLabelToast

    class Toast extends Label {
        init() {
            this.time = 2;
        }

        show(text, color) {
            this.text = text;
            this.textColor = color;
            this.time = 0;
        }

        process(dt) {
            this.time = Math.min(2, this.time + dt);
        }

        drawText(ctx) {
            const t = this.time;
            let offset = 1;
            if (t <= 0.5)
                offset = Math.sin(t / 0.5 * Math.PI / 2);
            else if (t >= 1.75)
                offset = Math.cos((t - 1.75) / 0.25 * Math.PI / 2);
            this.textAlpha = Math.min(1, Math.pow(Math.max(offset, 0), 3));
            this.yOffset = -offset * this.rect.h;
            if (this.textAlpha > 0.001)
                super.drawText(ctx);
        }
    }

    // ---------------------------------------------------------------- window (Base/GuiWindow.cs)

    class Window {
        constructor(app, controls) {
            this.app = app;
            this.root = new Container(0, 0, 1920, 1080, controls);
            this.buttonClicked = false;
            this.keys = { ctrl: false, alt: false, shift: false };
            this.width = 1920;
            this.height = 1080;
            this.mouse = { x: -1, y: -1 };
            this.setWindowRefs(this.root);
        }

        setWindowRefs(c) {
            c.window = this;
            if (c.controls)
                c.controls.forEach(ch => this.setWindowRefs(ch));
        }

        resize(w, h) {
            this.width = w;
            this.height = h;
            this.root.resize(w, h);
        }

        process(dt) {
            SSQE.GUI.activeWindow = this;
            this.root.process(dt);
        }

        // shapes first, then text, like PreRender/Render/PostRender
        render(ctx, before, after) {
            before && before(ctx);
            this.root.draw(ctx);
            after && after(ctx);
            this.root.drawText(ctx);
        }

        mouseMove(x, y) {
            this.mouse = { x, y };
            this.root.hovering = true;
            this.root.mouseMove(x, y);
        }

        mouseDown(x, y, button) {
            this.buttonClicked = false;
            if (button === 0)
                this.root.mouseDownLeftGlobal(x, y, this);
            else if (button === 2)
                this.root.mouseDownRightGlobal(x, y, this);
        }

        mouseUp(x, y, button) {
            if (button === 0)
                this.root.mouseUpLeftGlobal(x, y);
            else if (button === 2)
                this.root.mouseUpRightGlobal(x, y);
        }

        scroll(x, y, delta) {
            this.root.mouseScrollGlobal(x, y, delta);
        }

        keyDown(e) {
            return this.root.keyDown(e, this);
        }

        paste(text) {
            this.root.paste(text);
        }

        textboxFocused() {
            return !!this.root.focusedTextbox();
        }

        hoveringInteractive(exclude) {
            return this.root.hoveringInteractive(exclude);
        }
    }

    // small DOM helper used by the HTML dialogs and screens
    SSQE.el = function el(tag, attrs = {}, ...children) {
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
    };

    SSQE.GUI = {
        setSettings: s => settings = s,
        Styles, CenterMode, Text, loadFonts, texture, drawTile, fillSquircle, strokeSquircle, squirclePath, rgb: C.rgb,
        AnimatedValue, Control, Interactive, Label, Square, Button, TexturedButton, Checkbox, Slider, Textbox, NumericTextbox,
        Container, NumberBox, Dropdown, ScrollList, ButtonList, Radio, Toast, Window,
    };
})();
