'use strict';

// Port of Audio/MusicPlayer.cs, SoundPlayer.cs and Waveform.cs using an <audio> element (pitch-preserving tempo)
// for playback and a decoded AudioBuffer for the waveform.
(function () {
    const VOLUME_MULT = 2;
    let ctx = null;

    function audioContext() {
        if (!ctx)
            ctx = new (window.AudioContext || window.webkitAudioContext)();
        if (ctx.state === 'suspended')
            ctx.resume().catch(() => { });
        return ctx;
    }

    // ---------------------------------------------------------------- sound effects

    const buffers = {};
    let loadingSounds = null;

    function loadSounds() {
        if (!loadingSounds) {
            const ac = audioContext();
            loadingSounds = Promise.all(Object.entries(window.SSQE_SOUNDS || {}).map(async ([name, url]) => {
                try {
                    const res = await fetch(url);
                    buffers[name] = await ac.decodeAudioData(await res.arrayBuffer());
                } catch (e) {
                    console.warn('Failed to load sound', name, e);
                }
            }));
        }
        return loadingSounds;
    }

    const SoundPlayer = {
        settings: null,

        play(name, volume) {
            const s = SoundPlayer.settings;
            const buffer = buffers[name];
            if (!buffer || !s || s.muteSfx)
                return;

            const ac = audioContext();
            const src = ac.createBufferSource();
            src.buffer = buffer;
            const gain = ac.createGain();
            gain.gain.value = Math.max((volume ?? s.sfxVolume) * VOLUME_MULT, 0);
            src.connect(gain);
            gain.connect(ac.destination);
            src.start();
        },
    };

    // ---------------------------------------------------------------- music

    class MusicPlayer {
        constructor(settings) {
            this.settings = settings;
            this.el = null;
            this.url = null;
            this.state = 'stopped';
            this.pos = 0;
            this.basePos = 0;
            this.basePerf = 0;
            this.started = false;
            this.tempo = 1;
            this.duration = 0; // seconds
            this.ended = false;
            this.waveform = null;
            this.onEnded = null;
        }

        // MusicPlayer.MusicOffset (ms)
        get musicOffset() {
            return this.settings.musicOffset - 28;
        }

        get loaded() {
            return !!this.el;
        }

        async load(blob) {
            this.dispose();
            const ac = audioContext();

            const url = URL.createObjectURL(blob);
            const el = new Audio();
            el.preload = 'auto';
            el.preservesPitch = el.mozPreservesPitch = el.webkitPreservesPitch = true;

            await new Promise((resolve, reject) => {
                el.onloadedmetadata = resolve;
                el.onerror = () => reject(new Error('This audio file could not be decoded by your browser'));
                el.src = url;
            });

            this.el = el;
            this.url = url;
            this.duration = el.duration;

            this.gain = ac.createGain();
            if (this.settings.monoAudio) {
                this.gain.channelCount = 1;
                this.gain.channelCountMode = 'explicit';
            }
            this.source = ac.createMediaElementSource(el);
            this.source.connect(this.gain);
            this.gain.connect(ac.destination);
            this.updateVolume();

            el.addEventListener('playing', () => {
                if (this.state === 'playing') {
                    this.basePos = el.currentTime;
                    this.basePerf = performance.now();
                    this.started = true;
                }
            });
            el.addEventListener('ended', () => {
                this.ended = true;
            });

            this.stop();

            // decode in the background for the waveform
            blob.arrayBuffer()
                .then(buf => ac.decodeAudioData(buf))
                .then(audio => this.waveform = new Waveform(audio))
                .catch(e => console.warn('Waveform decode failed', e));
        }

        dispose() {
            if (this.el) {
                this.el.pause();
                try { this.source.disconnect(); this.gain.disconnect(); } catch { }
                URL.revokeObjectURL(this.url);
            }
            this.el = null;
            this.waveform = null;
            this.state = 'stopped';
        }

        updateVolume() {
            if (this.gain)
                this.gain.gain.value = this.settings.muteMusic ? 0 : Math.max(this.settings.masterVolume * VOLUME_MULT, 0);
        }

        setTempo(t) {
            this.tempo = t;
            if (this.el)
                this.el.playbackRate = t;
            if (this.state === 'playing') {
                this.basePos = this.mediaPos();
                this.basePerf = performance.now();
            }
        }

        get isPlaying() {
            return this.state === 'playing';
        }

        mediaPos() {
            if (this.state !== 'playing' || !this.el)
                return this.pos;
            if (!this.started)
                return this.basePos;

            let p = this.basePos + (performance.now() - this.basePerf) / 1000 * this.tempo;
            const real = this.el.currentTime;
            if (!this.el.seeking && Math.abs(real - p) > 0.075) {
                this.basePos = real;
                this.basePerf = performance.now();
                p = real;
            }
            return Math.min(p, this.duration);
        }

        // MusicPlayer.CurrentTime getter (ms)
        currentTimeMs() {
            return this.mediaPos() * 1000 + this.musicOffset;
        }

        // MusicPlayer.CurrentTime setter (ms)
        seek(ms) {
            const p = Math.min(Math.max((ms - this.musicOffset) / 1000, 0), this.duration);
            this.pos = p;
            this.basePos = p;
            this.basePerf = performance.now();
            if (this.el)
                this.el.currentTime = p;
        }

        play(fromMs) {
            if (!this.el)
                return;
            audioContext();
            this.ended = false;
            this.state = 'playing';
            this.seek(fromMs);
            this.started = false;
            this.el.playbackRate = this.tempo;
            const p = this.el.play();
            if (p)
                p.catch(() => { });
        }

        // returns the time playback stopped at
        pause() {
            const t = this.currentTimeMs();
            this.pos = this.mediaPos();
            this.state = 'paused';
            if (this.el)
                this.el.pause();
            return t;
        }

        stop() {
            if (this.el)
                this.el.pause();
            this.state = 'stopped';
            this.seek(0);
        }
    }

    // ---------------------------------------------------------------- waveform

    // Waveform.Load: one left/right sample pair every 2ms (Settings.waveformDetail = 5), normalised to the peak
    class Waveform {
        constructor(audio) {
            this.resolution = 0.002;
            const per = audio.sampleRate * this.resolution;
            const length = audio.length;
            const count = Math.floor(length / per);
            const l = audio.getChannelData(0);
            const r = audio.numberOfChannels > 1 ? audio.getChannelData(1) : l;
            const left = new Float32Array(count);
            const right = new Float32Array(count);

            let peak = 0;
            for (let i = 0; i < count; i++) {
                const index = Math.min(length - 1, Math.round((i + 1) * per));
                left[i] = l[index];
                right[i] = r[index];
                peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
            }

            if (peak > 0)
                for (let i = 0; i < count; i++) {
                    left[i] /= peak;
                    right[i] /= peak;
                }

            this.left = left;
            this.right = right;
            this.count = count;
        }
    }

    SSQE.Audio = { audioContext, loadSounds, SoundPlayer, MusicPlayer, Waveform, VOLUME_MULT };
})();
