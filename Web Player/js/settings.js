'use strict';

// Port of Map Player/SSQE Player/Settings.cs
// Slider settings only keep their value here; their max/step live in the UI schema below.
window.SSQESettings = (function () {
    const STORAGE_KEY = 'ssqe-web-player-settings';

    const DEFAULTS = {
        sensitivity: 1,
        parallax: 1,
        approachDistance: 1,
        hitWindow: 55,
        fov: 70,
        noteScale: 1,
        cursorScale: 1,
        musicOffset: 0,
        maxPolyphony: 1,

        cameraMode: 'half lock',

        lockCursor: true,
        fullscreenPlayer: false,
        settingsVersion: 2,
        approachFade: false,
        gridGuides: false,
        notePushback: false,
        smoothAutoplay: true,
        monoAudio: false,
        muteSfx: false,

        tempo: 0.9,
        playerApproachRate: 11,

        masterVolume: 0.05,
        sfxVolume: 0.1,

        color1: [0, 255, 200],
        color2: [255, 0, 255],

        noteColors: [[255, 0, 255], [0, 255, 200]],

        // web only: 3D world behind the grid (worlds.js)
        background: 'None',
    };

    const BACKGROUNDS = ['None', 'Grid', 'Vaporwave', 'Neon Tunnel', 'Space Tunnel', 'Deep Space', 'Cubic', 'Custom Image'];

    const SCHEMA = [
        ['Gameplay', [
            { key: 'playerApproachRate', label: 'Approach rate', type: 'range', min: 0, max: 29, step: 1 },
            { key: 'approachDistance', label: 'Approach distance', type: 'number', min: 0.1, step: 0.05 },
            { key: 'hitWindow', label: 'Hit window (ms)', type: 'number', min: 1, step: 1 },
            { key: 'tempo', label: 'Tempo', type: 'range', min: 0, max: 1.4, step: 0.05, format: v => `${Math.round(tempoFromSlider(v) * 100)}%` },
            { key: 'maxPolyphony', label: 'Max hit sounds per frame', type: 'number', min: 0, step: 1 },
            { key: 'notePushback', label: 'Note pushback', type: 'bool' },
            { key: 'approachFade', label: 'Approach fade', type: 'bool' },
            { key: 'gridGuides', label: 'Grid guides', type: 'bool' },
            { key: 'smoothAutoplay', label: 'Smooth autoplay', type: 'bool' },
        ]],
        ['Camera & cursor', [
            { key: 'cameraMode', label: 'Camera mode', type: 'select', options: ['half lock', 'full lock', 'spin'] },
            { key: 'sensitivity', label: 'Sensitivity', type: 'number', min: 0.01, step: 0.05 },
            { key: 'parallax', label: 'Parallax', type: 'number', step: 0.05 },
            { key: 'fov', label: 'Field of view', type: 'number', min: 10, max: 170, step: 1 },
            { key: 'noteScale', label: 'Note scale', type: 'number', min: 0.05, step: 0.05 },
            { key: 'cursorScale', label: 'Cursor scale', type: 'number', min: 0.05, step: 0.05 },
            { key: 'lockCursor', label: 'Lock cursor to grid', type: 'bool' },
            { key: 'fullscreenPlayer', label: 'Fullscreen', type: 'bool' },
        ]],
        ['Audio', [
            { key: 'masterVolume', label: 'Music volume', type: 'range', min: 0, max: 1, step: 0.01, format: v => `${Math.round(v * 100)}%` },
            { key: 'sfxVolume', label: 'Hit sound volume', type: 'range', min: 0, max: 1, step: 0.01, format: v => `${Math.round(v * 100)}%` },
            { key: 'musicOffset', label: 'Music offset (ms)', type: 'number', step: 1 },
            { key: 'monoAudio', label: 'Mono audio', type: 'bool' },
            { key: 'muteSfx', label: 'Mute hit sounds', type: 'bool' },
        ]],
        ['Visuals', [
            { key: 'background', label: 'Background', type: 'dropdown', options: BACKGROUNDS },
            { key: 'backgroundImage', label: 'Custom background image', type: 'customImage' },
            { key: 'noteMesh', label: 'Custom note mesh (.obj)', type: 'customMesh' },
        ]],
        ['Colours', [
            { key: 'color1', label: 'Primary (grid, accuracy, combo)', type: 'color' },
            { key: 'color2', label: 'Secondary (cursor, misses, info)', type: 'color' },
            { key: 'noteColors', label: 'Note colours', type: 'colorlist' },
        ]],
    ];

    // MainWindow.SetTempo
    function tempoFromSlider(value) {
        const a = Math.min(value, 0.9);
        const b = (value - a) * 2;
        return a + b + 0.1;
    }

    function clone(v) {
        return JSON.parse(JSON.stringify(v));
    }

    function load() {
        const s = clone(DEFAULTS);
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
                const saved = JSON.parse(raw);
                applyObject(s, saved, false);
                // version 2 turned fullscreen off by default; older saves only had it on because it was the default
                if (!(saved.settingsVersion >= 2)) {
                    s.fullscreenPlayer = false;
                    s.settingsVersion = 2;
                }
            }
        } catch { /* storage unavailable */ }
        return s;
    }

    function save(s) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
        } catch { /* storage unavailable */ }
    }

    function isColor(v) {
        return Array.isArray(v) && v.length >= 3 && v.slice(0, 3).every(n => typeof n === 'number');
    }

    // Accepts both our own saved format and the editor's settings.txt
    // (where sliders are [value, max, step] and list settings are strings).
    function applyObject(target, obj, fromEditor) {
        let applied = 0;
        for (const key of Object.keys(DEFAULTS)) {
            if (!(key in obj))
                continue;
            const def = DEFAULTS[key];
            let value = obj[key];

            try {
                if (key === 'noteColors') {
                    if (!Array.isArray(value) || !value.length || !value.every(isColor))
                        continue;
                    value = value.map(c => c.slice(0, 3).map(Number));
                } else if (isColor(def)) {
                    if (!isColor(value))
                        continue;
                    value = value.slice(0, 3).map(Number);
                } else if (typeof def === 'number') {
                    if (Array.isArray(value))
                        value = value[0];
                    value = Number(value);
                    if (!Number.isFinite(value))
                        continue;
                } else if (typeof def === 'boolean') {
                    if (typeof value !== 'boolean')
                        continue;
                } else if (typeof def === 'string') {
                    if (typeof value === 'object' && value && 'Current' in value)
                        value = value.Current;
                    if (typeof value !== 'string')
                        continue;
                }
                target[key] = value;
                applied++;
            } catch {
                if (fromEditor)
                    console.warn(`Failed to update setting - ${key}`);
            }
        }
        return applied;
    }

    return { DEFAULTS, SCHEMA, BACKGROUNDS, load, save, applyObject, tempoFromSlider, clone };
})();
