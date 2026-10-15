'use strict';

// Web only: 3D backgrounds behind the gameplay, rebuilt from Rhythia's world scenes
// (grid, vaporwave, neon_tunnel, space_tunnel, deep_space, cubic). The scenes are laid out in Godot's
// coordinates (camera at +Z looking down -Z) and flipped into the player's world when drawn.
window.SSQEWorlds = (function () {
    const NAMES = ['None', 'Grid', 'Vaporwave', 'Neon Tunnel', 'Space Tunnel', 'Deep Space', 'Cubic', 'Custom Image'];

    // ---------------------------------------------------------------- math (column-major)

    const M = {
        identity() {
            const m = new Float32Array(16);
            m[0] = m[5] = m[10] = m[15] = 1;
            return m;
        },
        mul(a, b) {
            const o = new Float32Array(16);
            for (let c = 0; c < 4; c++)
                for (let r = 0; r < 4; r++)
                    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
            return o;
        },
        translate(x, y, z) {
            const m = M.identity();
            m[12] = x; m[13] = y; m[14] = z;
            return m;
        },
        scale(x, y = x, z = x) {
            const m = M.identity();
            m[0] = x; m[5] = y; m[10] = z;
            return m;
        },
        // rotation of angle a around the unit axis [x, y, z]
        rotate([x, y, z], a) {
            const c = Math.cos(a), s = Math.sin(a), t = 1 - c;
            const m = M.identity();
            m[0] = t * x * x + c; m[1] = t * x * y + s * z; m[2] = t * x * z - s * y;
            m[4] = t * x * y - s * z; m[5] = t * y * y + c; m[6] = t * y * z + s * x;
            m[8] = t * x * z + s * y; m[9] = t * y * z - s * x; m[10] = t * z * z + c;
            return m;
        },
        chain(...ms) {
            return ms.reduce((a, b) => M.mul(a, b));
        },
    };

    // Godot scene -> player world (a half turn around Y; the camera ends up at the scene's origin + 3.5 Z)
    const FLIP = M.scale(-1, 1, -1);

    function rng(seed) {
        return () => {
            seed = (seed * 16807) % 2147483647;
            return (seed - 1) / 2147483646;
        };
    }

    // ---------------------------------------------------------------- shaders

    const BASIC_VS = `#version 300 es
layout (location = 0) in vec3 position;
layout (location = 1) in vec2 uv;
uniform mat4 uProj;
uniform mat4 uMV;
out vec2 vUv;
out vec3 vView;
void main() {
    vec4 p = uMV * vec4(position, 1.0);
    vView = p.xyz;
    vUv = uv;
    gl_Position = uProj * p;
}`;

    const BASIC_FS = `#version 300 es
precision mediump float;
in vec2 vUv;
in vec3 vView;
uniform vec4 uColor;
uniform sampler2D uTex;
uniform float uUseTex;
uniform float uFade;      // distance fade (alpha reaches 0 at this distance), 0 = off
uniform float uPulse;     // cubic's shimmer, 0 = off
uniform vec4 uFog;        // rgb + amount
uniform vec3 uFogRange;   // begin, end, curve
out vec4 outColor;
void main() {
    vec4 c = uColor;
    if (uUseTex > 0.5)
        c *= texture(uTex, vUv);
    float d = length(vView);
    if (uFade > 0.0)
        c.a *= 1.0 - smoothstep(0.0, uFade, d);
    if (uPulse > 0.0)
        c.a *= (sin(vView.z * 1.6 + uPulse) + 1.0) * 0.3 + 0.7;
    if (uFog.a > 0.0) {
        float f = pow(smoothstep(uFogRange.x, uFogRange.y, d), uFogRange.z);
        c.rgb = mix(c.rgb, uFog.rgb, f * uFog.a);
    }
    outColor = c;
}`;

    // vaporwave terrain: rolling noise hills either side of a flat valley, drawn as a glowing wire grid
    const TERRAIN_VS = `#version 300 es
layout (location = 0) in vec3 position;
uniform mat4 uProj;
uniform mat4 uMV;
uniform float uBase;   // whole cells scrolled so far (local units)
uniform float uFrac;   // the part of a cell scrolled since
out vec3 vView;
out vec2 vGrid;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++) {
        v += a * noise(p);
        p = p * 1.9 + 7.0;
        a *= 0.45;
    }
    return v;
}
void main() {
    vec2 g = vec2(position.x, position.z - uBase);
    float h = fbm(g * 3.0);
    float side = smoothstep(0.06, 0.5, abs(position.x));
    float y = h * h * side * 2.6 + (h - 0.5) * 0.12;
    vec4 p = uMV * vec4(position.x, y, position.z + uFrac, 1.0);
    vView = p.xyz;
    vGrid = g * 25.0;
    gl_Position = uProj * p;
}`;

    const TERRAIN_FS = `#version 300 es
precision mediump float;
in vec3 vView;
in vec2 vGrid;
uniform vec3 uFront;
uniform vec3 uBack;
uniform float uFlash;
out vec4 outColor;
void main() {
    vec2 w = fwidth(vGrid) * 1.4;
    vec2 g = abs(fract(vGrid - 0.5) - 0.5) / max(w, vec2(1e-4));
    float line = 1.0 - min(min(g.x, g.y), 1.0);
    float t = clamp((-vView.z - 8.0) / 170.0, 0.0, 1.0);
    vec3 col = mix(uFront, uBack, smoothstep(0.0, 0.55, t));
    float fade = 1.0 - smoothstep(0.55, 1.0, t);
    vec3 c = col * (line * (1.15 + uFlash) + 0.05) * fade;
    outColor = vec4(c, 1.0);
}`;

    const SUN_FS = `#version 300 es
precision mediump float;
in vec2 vUv;
uniform float uTime;
out vec4 outColor;
void main() {
    vec2 p = vec2(vUv.x * 2.0 - 1.0, 1.0 - vUv.y * 2.0);
    float r = length(p) / 0.62;
    vec3 top = vec3(1.0, 0.95, 0.65), mid = vec3(1.0, 0.55, 0.25), bot = vec3(1.0, 0.05, 0.55);
    float y = p.y / 0.62;
    vec3 col = y > 0.0 ? mix(mid, top, y) : mix(mid, bot, -y);
    float disk = 1.0 - smoothstep(0.985, 1.0, r);
    // the slits in the lower half, wider towards the bottom
    if (y < 0.15) {
        float k = fract(y * 7.0 + uTime * 0.25);
        float gap = mix(0.05, 0.6, clamp((0.15 - y) / 1.15, 0.0, 1.0));
        disk *= smoothstep(gap - 0.04, gap + 0.04, k);
    }
    float glow = exp(-max(r - 1.0, 0.0) * 4.0) * 0.35 * (1.0 - disk);
    vec3 c = col * disk + mix(mid, bot, 0.5) * glow;
    outColor = vec4(c, 1.0);
}`;

    const IMAGE_VS = `#version 300 es
layout (location = 0) in vec3 position;
layout (location = 1) in vec2 uv;
uniform vec2 uScale;
out vec2 vUv;
void main() {
    vUv = (uv - 0.5) * uScale + 0.5;
    gl_Position = vec4(position.xy, 0.999, 1.0);
}`;

    const IMAGE_FS = `#version 300 es
precision mediump float;
in vec2 vUv;
uniform sampler2D uTex;
uniform float uDim;
out vec4 outColor;
void main() {
    outColor = vec4(texture(uTex, vUv).rgb * uDim, 1.0);
}`;

    function compile(gl, vs, fs) {
        const make = (type, src) => {
            const s = gl.createShader(type);
            gl.shaderSource(s, src);
            gl.compileShader(s);
            if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
                throw new Error(gl.getShaderInfoLog(s));
            return s;
        };
        const p = gl.createProgram();
        gl.attachShader(p, make(gl.VERTEX_SHADER, vs));
        gl.attachShader(p, make(gl.FRAGMENT_SHADER, fs));
        gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS))
            throw new Error(gl.getProgramInfoLog(p));
        const u = {};
        const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
        for (let i = 0; i < n; i++) {
            const name = gl.getActiveUniform(p, i).name;
            u[name] = gl.getUniformLocation(p, name);
        }
        return { program: p, u };
    }

    // interleaved [x, y, z, u, v]
    function mesh(gl, data) {
        const vao = gl.createVertexArray();
        gl.bindVertexArray(vao);
        const vbo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 20, 12);
        gl.enableVertexAttribArray(1);
        gl.bindVertexArray(null);
        return { vao, vbo, count: data.length / 5 };
    }

    // quad in the XY plane, w x h, uv repeated `tile` times
    function quad(w, h, tile = 1) {
        const x = w / 2, y = h / 2, t = tile;
        return [-x, -y, 0, 0, t, x, -y, 0, t, t, x, y, 0, t, 0, -x, -y, 0, 0, t, x, y, 0, t, 0, -x, y, 0, 0, 0];
    }

    // horizontal quad in the XZ plane
    function flatQuad(x1, z1, x2, z2) {
        return [x1, 0, z1, 0, 0, x2, 0, z1, 1, 0, x2, 0, z2, 1, 1, x1, 0, z1, 0, 0, x2, 0, z2, 1, 1, x1, 0, z2, 0, 1];
    }

    // box faces, inward or outward (culling is off), uv repeated `tile` times per face
    function box(sx, sy, sz, tile = 1) {
        const out = [];
        const x = sx / 2, y = sy / 2, z = sz / 2, t = tile;
        const faces = [
            [[-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z]],
            [[x, -y, -z], [-x, -y, -z], [-x, y, -z], [x, y, -z]],
            [[x, -y, z], [x, -y, -z], [x, y, -z], [x, y, z]],
            [[-x, -y, -z], [-x, -y, z], [-x, y, z], [-x, y, -z]],
            [[-x, y, z], [x, y, z], [x, y, -z], [-x, y, -z]],
            [[-x, -y, -z], [x, -y, -z], [x, -y, z], [-x, -y, z]],
        ];
        const uv = [[0, t], [t, t], [t, 0], [0, 0]];
        for (const f of faces)
            for (const i of [0, 1, 2, 0, 2, 3])
                out.push(...f[i], ...uv[i]);
        return out;
    }

    function loadTexture(gl, url, repeat) {
        const tex = gl.createTexture();
        const t = { tex, ready: false };
        if (!url)
            return t;
        const img = new Image();
        img.onload = () => {
            if (t.disposed)
                return;
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
            const pot = (img.width & (img.width - 1)) === 0 && (img.height & (img.height - 1)) === 0;
            const wrap = repeat && pot ? gl.REPEAT : gl.CLAMP_TO_EDGE;
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            if (pot) {
                gl.generateMipmap(gl.TEXTURE_2D);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
            } else
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            t.width = img.width;
            t.height = img.height;
            t.ready = true;
        };
        img.src = url;
        return t;
    }

    function assetUrl(name) {
        const base = (window.SSQE && SSQE.GUI && SSQE.GUI.ASSETS) || new URL('assets/', location.href).href;
        return `${base}worlds/${name}`;
    }

    // ---------------------------------------------------------------- world

    class World {
        // opts: { name, color: initial colour [r, g, b] 0-1, speed: () => units per second for scrolling scenery }
        constructor(gl, opts) {
            this.gl = gl;
            this.name = opts.name;
            this.speed = opts.speed || (() => 5);
            // Rhythia's "disable background effects": nothing reacts to hits
            this.effects = opts.effects !== false;
            this.color = (opts.color || [1, 1, 1]).slice(0, 3);
            this.time = 0;
            this.flash = 0;
            this.meshes = [];
            this.textures = [];
            this.programs = [];
            this.clearColor = [0, 0, 0];

            this.basic = this.program(BASIC_VS, BASIC_FS);
            const setup = {
                'Grid': this.initGrid,
                'Vaporwave': this.initVaporwave,
                'Neon Tunnel': () => this.initTunnel(['ring.png']),
                'Space Tunnel': () => this.initTunnel(['space_ring_b.png', 'space_ring.png']),
                'Deep Space': this.initSpace,
                'Cubic': this.initCubic,
                'Custom Image': this.initImage,
            }[this.name];
            if (setup)
                setup.call(this);
        }

        program(vs, fs) {
            const p = compile(this.gl, vs, fs);
            this.programs.push(p.program);
            return p;
        }

        mesh(data) {
            const m = mesh(this.gl, data);
            this.meshes.push(m);
            return m;
        }

        texture(url, repeat) {
            const t = loadTexture(this.gl, url, repeat);
            this.textures.push(t);
            return t;
        }

        dispose() {
            const gl = this.gl;
            for (const m of this.meshes) {
                gl.deleteVertexArray(m.vao);
                gl.deleteBuffer(m.vbo);
            }
            for (const t of this.textures) {
                t.disposed = true;
                gl.deleteTexture(t.tex);
            }
            for (const p of this.programs)
                gl.deleteProgram(p);
            this.meshes = this.textures = this.programs = [];
        }

        hit(color) {
            if (!this.effects)
                return;
            if (color)
                this.color = color.slice(0, 3);
            this.flash = 1;
            this.onHit && this.onHit();
        }

        // ------------------------------------------------ drawing helpers

        begin(proj, sceneView) {
            const gl = this.gl;
            this.proj = proj;
            this.sceneView = sceneView;
            gl.useProgram(this.basic.program);
            gl.uniformMatrix4fv(this.basic.u.uProj, false, proj);
            gl.uniform4f(this.basic.u.uFog, 0, 0, 0, 0);
            gl.uniform1f(this.basic.u.uFade, 0);
            gl.uniform1f(this.basic.u.uPulse, 0);
            gl.uniform1f(this.basic.u.uUseTex, 0);
            gl.uniform1i(this.basic.u.uTex, 0);
        }

        fog(rgb, begin, end, curve = 1) {
            const gl = this.gl;
            gl.uniform4f(this.basic.u.uFog, rgb[0], rgb[1], rgb[2], 1);
            gl.uniform3f(this.basic.u.uFogRange, begin, end, curve);
        }

        draw(m, model, color, tex) {
            const gl = this.gl, u = this.basic.u;
            gl.uniformMatrix4fv(u.uMV, false, M.mul(this.sceneView, model));
            gl.uniform4f(u.uColor, color[0], color[1], color[2], color[3] ?? 1);
            if (tex) {
                if (!tex.ready)
                    return;
                gl.activeTexture(gl.TEXTURE0);
                gl.bindTexture(gl.TEXTURE_2D, tex.tex);
                gl.uniform1f(u.uUseTex, 1);
            } else
                gl.uniform1f(u.uUseTex, 0);
            gl.bindVertexArray(m.vao);
            gl.drawArrays(gl.TRIANGLES, 0, m.count);
        }

        // Draws the world. proj/view are the player camera's matrices; the depth buffer is cleared afterwards so
        // the gameplay always ends up in front.
        render(proj, view, dt) {
            if (!this.renderScene)
                return;
            const gl = this.gl;
            this.time += dt;
            this.flash = Math.max(0, this.flash - dt * 3);

            gl.disable(gl.CULL_FACE);
            gl.disable(gl.DEPTH_TEST);
            gl.depthMask(false);
            this.begin(proj, M.mul(view, FLIP));
            this.renderScene(dt);
            gl.bindVertexArray(null);
            gl.depthMask(true);
            gl.enable(gl.DEPTH_TEST);
            gl.enable(gl.CULL_FACE);
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
            gl.clear(gl.DEPTH_BUFFER_BIT);
        }

        // ------------------------------------------------ grid (grid.tscn + grid.gd)

        initGrid() {
            this.clearColor = [0.0235, 0.0118, 0.129];
            // grid.obj: a lattice of 0.155 wide bars every 2.975 units, 136.8 units across
            const lines = [];
            const step = 24.789 * 0.12, half = 570.157 * 0.12, w = 1.2955 * 0.12 / 2;
            for (let i = -23; i <= 23; i++) {
                const c = i * step;
                lines.push(...flatQuad(c - w, -half, c + w, half));
                lines.push(...flatQuad(-half, c - w, half, c + w));
            }
            this.gridMesh = this.mesh(lines);
            this.planeMesh = this.mesh(flatQuad(-105, -112, 105, 112));
            this.cubeMesh = this.mesh(box(1.088, 0.692, 1.489));
            this.gridColor = [1, 1, 1];
            this.gridZ = -26;
            this.particles = [];
            this.random = rng(9);

            this.onHit = () => {
                // cube.tscn: a cube appears somewhere in the emission area, away from the middle, and fades out
                const r = this.random;
                const x = (r() * 2 - 1) * 42.26;
                if (x >= -5 && x <= 5)
                    return;
                this.particles.push({
                    x, y: -5, z: -47.61 + (r() * 2 - 1) * 17.77,
                    angle: r() * Math.PI * 2, spin: 1.5 * (0.25 + r() * 1.5) * (r() < 0.5 ? -1 : 1),
                    scale: 2 * (0.5 + r() * 0.5), speed: 1 + r(), age: 0, color: this.color.slice(),
                });
            };

            this.renderScene = dt => {
                const gl = this.gl;
                this.gridZ += 6 * dt;
                while (this.gridZ > -14.1)
                    this.gridZ -= 11.9;
                // the colour drifts towards the last hit note's colour
                const k = 1 - Math.pow(0.995, dt * 60);
                this.gridColor = this.gridColor.map((c, i) => c + (this.color[i] - c) * k);

                gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
                this.fog([0, 0.121569, 0.917647], 10, 100);
                gl.uniform1f(this.basic.u.uFade, 50);
                const a = 0.4 + this.flash * 0.25;
                this.draw(this.gridMesh, M.translate(0.119, -12, this.gridZ), [...this.gridColor, a]);
                this.draw(this.gridMesh, M.translate(0.119, 13, this.gridZ), [...this.gridColor, a]);
                this.draw(this.planeMesh, M.translate(1.3, -12, -25.4), [...this.gridColor, 0.03]);
                this.draw(this.planeMesh, M.translate(1.3, 12.9, -25.4), [...this.gridColor, 0.03]);
                gl.uniform1f(this.basic.u.uFade, 0);
                gl.uniform4f(this.basic.u.uFog, 0, 0, 0, 0);

                // ParticlesMaterial: gravity 0.4 up, ~86 deg/s spin, fade in and out over a 2 second life
                this.particles = this.particles.filter(p => p.age < 2);
                for (const p of this.particles) {
                    p.age += dt;
                    const t = Math.min(1, p.age * p.speed / 2);
                    const life = p.age * p.speed;
                    p.angle += p.spin * dt * p.speed;
                    const alpha = t < 0.229 ? t / 0.229 : t < 0.446 ? 1 : 1 - (t - 0.446) / 0.554;
                    const model = M.chain(M.translate(p.x, p.y + 0.2 * life * life + life * 0.6, p.z), M.rotate([0, 0, 1], p.angle), M.scale(p.scale));
                    this.draw(this.cubeMesh, model, [...p.color, alpha * 0.8]);
                }
            };
        }

        // ------------------------------------------------ vaporwave (vaporwave.tscn)

        initVaporwave() {
            this.clearColor = [0, 0, 0];
            this.terrain = this.program(TERRAIN_VS, TERRAIN_FS);
            this.sun = this.program(BASIC_VS, SUN_FS);

            // PlaneMesh subdivided 49 x 49 (50 cells a side), positions only
            const n = 50, data = [];
            const v = (i, j) => [i / n * 2 - 1, 0, j / n * 2 - 1, 0, 0];
            for (let j = 0; j < n; j++)
                for (let i = 0; i < n; i++)
                    data.push(...v(i, j), ...v(i + 1, j), ...v(i + 1, j + 1), ...v(i, j), ...v(i + 1, j + 1), ...v(i, j + 1));
            this.terrainMesh = this.mesh(data);
            this.sunMesh = this.mesh(quad(2, 2));
            this.scroll = 0;

            this.renderScene = dt => {
                const gl = this.gl;
                // sun: a plane 160 units across, 100 up and 200 away
                gl.useProgram(this.sun.program);
                gl.uniformMatrix4fv(this.sun.u.uProj, false, this.proj);
                gl.uniformMatrix4fv(this.sun.u.uMV, false, M.mul(this.sceneView, M.chain(M.translate(0, 100, -200), M.scale(80))));
                gl.uniform1f(this.sun.u.uTime, this.time);
                gl.bindVertexArray(this.sunMesh.vao);
                gl.drawArrays(gl.TRIANGLES, 0, this.sunMesh.count);

                // terrain: 200 x 200 units, 10.8 below the grid, scrolling towards the camera
                this.scroll += dt * Math.min(Math.max(this.speed(), 2), 12) * 0.006;
                const cell = 2 / n;
                const frac = this.scroll % cell;
                gl.enable(gl.DEPTH_TEST);
                gl.depthMask(true);
                gl.useProgram(this.terrain.program);
                const u = this.terrain.u;
                gl.uniformMatrix4fv(u.uProj, false, this.proj);
                gl.uniformMatrix4fv(u.uMV, false, M.mul(this.sceneView, M.chain(M.translate(0.001, -10.8, -110), M.scale(100, 20, 100))));
                gl.uniform1f(u.uBase, this.scroll - frac);
                gl.uniform1f(u.uFrac, frac);
                gl.uniform3f(u.uFront, 1, 0, 0.2);
                gl.uniform3f(u.uBack, 0, 0, 1);
                gl.uniform1f(u.uFlash, this.flash * 0.35);
                gl.bindVertexArray(this.terrainMesh.vao);
                gl.drawArrays(gl.TRIANGLES, 0, this.terrainMesh.count);
            };
        }

        // ------------------------------------------------ neon / space tunnel (ring.gd)

        initTunnel(textures) {
            this.clearColor = [0.0392, 0.0392, 0.0392];
            this.ringMesh = this.mesh(quad(8, 8));
            const tex = textures.map(t => this.texture(assetUrl(t)));
            const zs = textures.length > 1
                ? [0, -7.5, -15, -22.5, -30, -37.5, -52.5, -45, 7.5, 15, 22.5, 30, 37.5, 45]
                : [0, -7.5, -15, -22.5, -30, -37.5, -45, 7.5, 15, 22.5, 30, 37.5, 45];
            // in space_tunnel.tscn the rings alternate between the two textures
            this.rings = zs.map(z => ({ z, tex: tex[textures.length > 1 ? Math.round(Math.abs(z) / 7.5) % 2 : 0] }));

            this.renderScene = dt => {
                const gl = this.gl;
                const speed = Math.min(Math.max(this.speed(), 2), 12);
                for (const r of this.rings) {
                    r.z += dt * speed;
                    if (r.z >= 45)
                        r.z -= 105;
                }
                gl.uniform1f(this.basic.u.uFade, 35);
                const color = [...this.color.map(c => Math.min(1, c * (1 + this.flash * 0.4))), 1];
                for (const r of [...this.rings].sort((a, b) => a.z - b.z))
                    this.draw(this.ringMesh, M.translate(0, 0, r.z), color, r.tex);
            };
        }

        // ------------------------------------------------ deep space (deep_space.tscn)

        initSpace() {
            this.clearColor = [0.0392, 0.0392, 0.0392];
            // the panorama itself isn't in the files, so the preview's starfield is tiled over a sky box
            this.skyMesh = this.mesh(box(600, 600, 600, 3));
            this.skyTex = this.texture(assetUrl('deep_space.png'), true);
            this.renderScene = () => {
                const rot = M.rotate([0, 1, 0], this.time * 0.004);
                this.draw(this.skyMesh, M.chain(M.translate(0, 0, 3.5), rot), [1, 1, 1, 1], this.skyTex);
            };
        }

        // ------------------------------------------------ cubic (cubic.tscn + cubic_cube.gd)

        initCubic() {
            this.clearColor = [0.04, 0, 0];
            this.cubeMesh = this.mesh(box(1, 1, 1));
            const r = rng(5);
            // the Cubes node: scaled by 2.8, tilted a little, offset
            const parent = M.chain(M.translate(0.711472, 0.517543, 0.539162), M.rotate([0, 0, 1], -0.02808), M.scale(2.8));
            this.cubes = CUBIC_POSITIONS.map(p => {
                const gz = 0.539162 + p[2] * 2.8;
                const shade = Math.min(1, Math.max(0.35, (76 + gz) / 75));
                const axis = [r(), r(), r()];
                const len = Math.hypot(...axis) || 1;
                return {
                    pos: p, axis: axis.map(a => a / len), angle: r(), boost: 0,
                    color: [0.698 * shade, 0.133 * shade, 0.133 * shade, 0.12],
                };
            });
            this.onHit = () => {
                this.cubes[Math.floor(Math.random() * this.cubes.length)].boost = 1;
            };
            this.renderScene = dt => {
                this.fog([0.054902, 0, 0], 20.7, 58.3, 0.353553);
                this.gl.uniform1f(this.basic.u.uPulse, this.time * 0.1 + 0.0001);
                for (const c of this.cubes) {
                    c.angle += dt * (0.035 + c.boost);
                    if (c.boost) {
                        const l = c.boost + (0 - c.boost) * Math.min(1, dt * 3.7);
                        c.boost = Math.max(l - dt, 0);
                    }
                    const s = 1 + c.boost * 0.3;
                    const model = M.chain(parent, M.translate(...c.pos), M.rotate(c.axis, c.angle), M.scale(s));
                    this.draw(this.cubeMesh, model, c.color);
                }
            };
        }

        // ------------------------------------------------ custom image (web only)

        initImage() {
            this.image = this.program(IMAGE_VS, IMAGE_FS);
            this.screenMesh = this.mesh(quad(2, 2));
            const url = window.SSQECustom && SSQECustom.state.imageUrl;
            this.imageTex = this.texture(url, false);
            this.renderScene = () => {
                const gl = this.gl;
                if (!this.imageTex.ready)
                    return;
                // cover the screen without stretching
                const sw = gl.drawingBufferWidth / gl.drawingBufferHeight, iw = this.imageTex.width / this.imageTex.height;
                const scale = sw > iw ? [1, iw / sw] : [sw / iw, 1];
                gl.useProgram(this.image.program);
                gl.uniform2f(this.image.u.uScale, scale[0], scale[1]);
                gl.uniform1f(this.image.u.uDim, 0.55);
                gl.uniform1i(this.image.u.uTex, 0);
                gl.activeTexture(gl.TEXTURE0);
                gl.bindTexture(gl.TEXTURE_2D, this.imageTex.tex);
                gl.bindVertexArray(this.screenMesh.vao);
                gl.drawArrays(gl.TRIANGLES, 0, this.screenMesh.count);
            };
        }
    }

    // cubic.tscn: the cubes' positions inside the Cubes node
    const CUBIC_POSITIONS = [[5.75838, 1.47278, -14.885], [6.39393, -0.85609, -18.5634], [6.03843, -3.70824, -18.5731], [5.04264, 2.99744, -10.6817], [4.79772, -7.04946, -7.35316], [0.434529, -4.38758, -29.9632], [3.70448, -10.5938, -0.869996], [-5.24, 3.90377, -7.03183], [2.69125, -4.04184, -6.3499], [-1.06582, -3.37736, -7.26013], [7.71778, -5.55803, -5.39718], [9.74027, 1.91304, -14.738], [4.94895, -15.5245, -2.97956], [5.30233, -11.7396, -19.2165], [5.75212, -5.00733, -14.5217], [2.79817, -11.4987, -10.0333], [2.99787, -7.83951, -14.638], [4.04665, -4.46511, -17.3888], [-1.34626, -3.77675, -18.0229], [-3.69093, -1.85755, -21.7391], [7.04405, -2.73022, -9.09694], [7.94308, -6.7634, -10.0333], [5.24837, -1.14796, -10.4639], [7.03574, 8.10504, -10.429], [10.5591, 8.53593, -9.47362], [10.4242, 1.11671, -10.0333], [8.53013, -4.51022, -15.5423], [7.97727, -10.3672, -10.6935], [5.44574, -14.1384, -12.4732], [0.416746, -9.28148, -16.9918], [1.38656, -3.0494, -12.6243], [6.37142, 5.75084, -13.1766], [4.15812, 4.78707, -16.855], [1.2845, 4.72883, -16.8647], [-2.20039, 5.47628, -5.64479], [-0.77148, 5.24549, -23.3962], [-8.6825, 8.66763, -3.46645], [-3.07502, 0.152397, -7.46911], [9.459, -1.47663, -8.39214], [11.9508, -5.21796, -12.1742], [-6.76924, 4.30263, -17.5081], [-1.48004, 4.26506, -12.8796], [-6.89084, 6.81541, -8.32493], [-3.241, 7.14386, -12.9296], [3.01786, 8.41984, -13.5407], [2.39693, 3.87427, -7.38857], [3.80461, 8.89816, -6.89178], [-0.257898, 7.4815, -10.0173], [3.03432, 7.85459, -17.6288], [-9.18701, 4.93119, -8.32493], [3.70458, 5.87877, -8.75554], [2.62347, 8.21023, -8.97925], [7.78656, 4.30713, -9.57823], [14.0514, 2.01544, -7.76525], [6.68985, 1.08228, -8.32493], [11.8627, -3.58823, -8.09003], [12.6154, -0.00572792, -9.74387], [12.8654, -6.50572, -7.74387], [10.9559, 4.62406, -8.02354], [-11.7524, -5.46873, -7.59086], [0.849071, 2.14772, -13.8339], [-3.74804, 3.86494, -9.02723], [-10.2522, -0.922707, -8.29098], [-9.12253, 3.81583, -10.7648], [-10.0174, 7.76104, -8.32493], [-5.03907, 9.49085, -15.2834], [-7.36767, 11.9468, -8.03105], [-1.93019, -8.52734, -12.5854], [-4.14955, -7.57761, -16.2638], [-6.16279, -5.52627, -16.2735], [-8.00893, -2.47751, -5.05362], [-3.21165, -0.714205, -27.6636], [-4.34356, -2.69691, -4.05036], [-8.65568, -5.69198, -3.09764], [-4.0604, -11.9202, -12.4384], [-11.9966, 0.0425168, -16.9169], [-8.39634, -3.83246, -12.2884], [-10.2513, 1.85438, -7.73376], [-7.50905, -0.576516, -12.3384], [-5.51762, -3.49556, -15.0892], [-6.02174, -6.92194, -6.7974], [-9.73995, -5.11922, -7.73376], [-3.66612, -6.49881, -8.16437], [-8.33983, -6.97963, -13.2427], [-12.5843, -2.90591, -8.39395], [-13.9648, 1.42125, -10.1736], [-11.7074, 4.77829, -7.73376], [-7.03421, 2.3417, -14.6922], [-6.84394, 5.72075, -7.43988]];

    function create(gl, opts) {
        if (!opts.name || opts.name === 'None' || !NAMES.includes(opts.name))
            return null;
        return new World(gl, opts);
    }

    return { NAMES, create };
})();
