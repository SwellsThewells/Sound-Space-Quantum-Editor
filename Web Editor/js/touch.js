'use strict';

// Touch support for the canvas UI. Touches on the canvas are turned into the mouse and wheel events the screens and
// the editor already handle, and canvas textboxes get a real <input> so phones and tablets show their keyboard.
//
//   tap            -> left click
//   drag           -> left drag (sliders, scrubbing the track, moving notes)
//   long press     -> right button (held until the finger lifts, so long press + drag is a right drag)
//   two fingers    -> pinch to zoom (Ctrl + scroll), swipe to scroll
(function () {
    const MOVE_THRESHOLD = 8;
    const LONG_PRESS_MS = 550;
    const WHEEL_STEP = 40;

    const Touch = {
        active: false,
        listeners: [],
        onChange(fn) {
            this.listeners.push(fn);
        },
    };

    let canvas = null;
    let state = 'idle'; // idle | pending | left | right | gesture
    let start = null, last = null, timer = null;
    let gesture = null;

    function fire(type, x, y, button = 0) {
        canvas.dispatchEvent(new MouseEvent(type, {
            clientX: x, clientY: y, button, buttons: type === 'mouseup' ? 0 : button === 2 ? 2 : 1,
            bubbles: true, cancelable: true, view: window,
        }));
    }

    function wheel(x, y, deltaY, ctrlKey) {
        canvas.dispatchEvent(new WheelEvent('wheel', { clientX: x, clientY: y, deltaY, ctrlKey, bubbles: true, cancelable: true, view: window }));
    }

    // lift the virtual mouse away so nothing stays hovered after the finger is gone
    function release() {
        fire('mousemove', -10000, -10000);
    }

    function enable() {
        if (Touch.active)
            return;
        Touch.active = true;
        document.body.classList.add('touch');
        Touch.listeners.forEach(fn => fn(true));
    }

    function onStart(e) {
        e.preventDefault();
        enable();
        if (input.style.display !== 'none')
            input.blur();

        if (e.touches.length === 1 && state === 'idle') {
            const t = e.touches[0];
            start = last = { x: t.clientX, y: t.clientY };
            state = 'pending';
            fire('mousemove', start.x, start.y);
            timer = setTimeout(() => {
                if (state !== 'pending')
                    return;
                state = 'right';
                navigator.vibrate && navigator.vibrate(15);
                fire('mousedown', start.x, start.y, 2);
            }, LONG_PRESS_MS);
            return;
        }

        // a second finger cancels whatever the first one was doing and starts a gesture
        clearTimeout(timer);
        if (state === 'left' || state === 'right') {
            release();
            fire('mouseup', -10000, -10000, state === 'right' ? 2 : 0);
        }
        if (e.touches.length >= 2) {
            const [a, b] = e.touches;
            gesture = {
                dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
                x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2,
            };
            state = 'gesture';
        }
    }

    function onMove(e) {
        e.preventDefault();
        if (state === 'gesture' && e.touches.length >= 2) {
            const [a, b] = e.touches;
            const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
            const x = (a.clientX + b.clientX) / 2, y = (a.clientY + b.clientY) / 2;
            while (Math.abs(dist - gesture.dist) >= WHEEL_STEP) {
                const out = dist > gesture.dist;
                wheel(x, y, out ? -100 : 100, true);
                gesture.dist += out ? WHEEL_STEP : -WHEEL_STEP;
            }
            const dx = x - gesture.x, dy = y - gesture.y;
            const d = Math.abs(dx) > Math.abs(dy) ? dx : dy;
            if (Math.abs(d) >= WHEEL_STEP) {
                wheel(x, y, d > 0 ? -100 : 100, false);
                gesture.x = x;
                gesture.y = y;
            }
            return;
        }

        const t = e.touches[0];
        if (!t)
            return;
        last = { x: t.clientX, y: t.clientY };
        if (state === 'pending' && Math.hypot(last.x - start.x, last.y - start.y) > MOVE_THRESHOLD) {
            clearTimeout(timer);
            state = 'left';
            fire('mousedown', start.x, start.y, 0);
        }
        if (state === 'left' || state === 'right')
            fire('mousemove', last.x, last.y);
    }

    function onEnd(e) {
        e.preventDefault();
        if (e.touches.length)
            return;
        clearTimeout(timer);
        if (state === 'pending') {
            fire('mousedown', start.x, start.y, 0);
            fire('mouseup', start.x, start.y, 0);
        } else if (state === 'left' || state === 'right')
            fire('mouseup', last.x, last.y, state === 'right' ? 2 : 0);
        state = 'idle';
        release();
        showKeyboard();
    }

    // ------------------------------------------------ keyboard for canvas textboxes

    const input = document.createElement('input');
    input.id = 'touch-input';
    input.type = 'text';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.style.display = 'none';
    let target = null;

    function showKeyboard() {
        const win = SSQE.GUI.activeWindow;
        const box = win && win.root.focusedTextbox();
        if (!box || box.readOnly || !box.insert || box.onKey)
            return;
        target = box;
        const r = box.rect;
        Object.assign(input.style, {
            display: 'block',
            left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px',
            fontSize: Math.max(16, box.scaledTextSize * 0.8) + 'px',
            textAlign: box.centerMode & SSQE.GUI.CenterMode.X ? 'center' : 'left',
        });
        input.inputMode = box instanceof SSQE.GUI.NumericTextbox ? 'decimal' : 'text';
        input.value = box.text;
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
    }

    function hideKeyboard() {
        input.style.display = 'none';
        target = null;
    }

    input.addEventListener('input', () => {
        if (!target)
            return;
        target.finish(input.value, input.selectionStart);
        if (target.text !== input.value)
            input.value = target.text;
    });
    input.addEventListener('keydown', e => {
        // keep these keys away from the editor's own textbox handling and keybinds
        e.stopPropagation();
        if (!target)
            return;
        if (e.key === 'Enter') {
            e.preventDefault();
            const box = target;
            box.focused = false;
            box.textEntered();
            input.blur();
        } else if (e.key === 'Escape') {
            target.focused = false;
            input.blur();
        }
    });
    input.addEventListener('paste', e => e.stopPropagation());
    input.addEventListener('blur', () => {
        if (target)
            target.focused = false;
        hideKeyboard();
    });

    // the textbox can lose focus from the GUI side too (another control was clicked)
    setInterval(() => {
        if (target && !target.focused)
            input.blur();
    }, 100);

    window.addEventListener('DOMContentLoaded', () => {
        canvas = document.getElementById('editor-canvas');
        document.body.append(input);
        for (const [type, fn] of [['touchstart', onStart], ['touchmove', onMove], ['touchend', onEnd], ['touchcancel', onEnd]])
            canvas.addEventListener(type, fn, { passive: false });
        if (window.matchMedia && matchMedia('(pointer: coarse)').matches)
            enable();
    });

    SSQE.Touch = Touch;
})();
