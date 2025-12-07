// /mandelbrot/julia-worker.js
//
// Protocol:
//   main -> worker:
//     {
//       type: "render",
//       jobId,
//       fbW, fbH,        // *stage* resolution
//       cRe, cIm,        // Julia parameter
//       color: { r, g, b }, // base color, 0..255
//       raw,             // 0..100 (bandwidth slider)
//       fillInterior,    // 0/1
//       scale            // stage scale factor (4, 1, ...), just echoed back
//     }
//
//   worker -> main:
//     { type: "frame", jobId, fbW, fbH, scale, pixels: ArrayBuffer }
//
// Color/glow is matched to the main app (same curve as colorizeGray).

"use strict";

const MAX_ITER = 300;
const BAILOUT_RADIUS = 4.0;
const BAILOUT_SQ = BAILOUT_RADIUS * BAILOUT_RADIUS;

// ------------- WebGL2 state -------------

let glCanvas = null;
let gl = null;
let program = null;
let posBuffer = null;

let aPositionLoc = -1;
let uResolutionLoc = null;
let uCParamLoc = null;
let uColorLoc = null;
let uRawLoc = null;
let uFillInteriorLoc = null;

// Vertex shader: fullscreen quad
const VS_SOURCE = `#version 300 es
in vec2 a_position;
out vec2 v_uv;
void main() {
    v_uv = a_position * 0.5 + 0.5;
    gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

// Fragment shader: Julia set with same glow curve as main colorizeGray
const FS_SOURCE = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 outColor;

uniform vec2 u_resolution;
uniform vec2 u_c;           // (cRe, cIm)
uniform vec3 u_color;       // base color 0..1
uniform float u_raw;        // 0..100
uniform float u_fillInterior; // 0 or 1

const int maxIter = ${MAX_ITER};
const float bailoutSq = ${BAILOUT_RADIUS} * ${BAILOUT_RADIUS};

void main() {
    float aspect = u_resolution.x / u_resolution.y;
    float scale = 1.5;

    float x = (v_uv.x - 0.5) * 2.0 * scale * aspect;
    float y = (v_uv.y - 0.5) * 2.0 * scale;

    vec2 z = vec2(x, y);
    vec2 c = u_c;

    float escapeIter = float(maxIter);
    bool escaped = false;

    for (int i = 0; i < maxIter; i++) {
        float x2 = z.x * z.x - z.y * z.y + c.x;
        float y2 = 2.0 * z.x * z.y + c.y;
        z = vec2(x2, y2);

        if (!escaped && dot(z, z) > bailoutSq) {
            escaped = true;
            escapeIter = float(i);
            break;
        }
    }

    bool isInterior = !escaped;

    float gNorm = isInterior ? 1.0 : (escapeIter / float(maxIter));
    if (gNorm <= 0.0) {
        outColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
    }

    float raw = clamp(u_raw, 0.0, 100.0);
    bool isLowBlur = raw <= 50.0;
    bool isHighBlur = raw > 50.0;

    float wVal;

    if (isInterior && u_fillInterior > 0.5) {
        wVal = 1.0;
    } else if (isLowBlur) {
        float clamped = raw;
        float tOrig = clamped / 100.0;
        float minExp = 0.25;
        float maxExp = 3.0;
        float lowExp = minExp + (1.0 - tOrig) * (maxExp - minExp);
        float lowToLinear = clamped / 50.0;

        float base = pow(gNorm, lowExp);
        base = clamp(base, 0.0, 1.0);
        wVal = base * (1.0 - lowToLinear) + gNorm * lowToLinear;
    } else { // high blur
        float u = (raw - 50.0) / 50.0;
        float bandWidth = 1.0 - 0.8 * u;
        float highToLinear = (100.0 - raw) / 50.0;

        float burn = gNorm >= bandWidth ? 1.0 : gNorm / bandWidth;
        wVal = burn * (1.0 - highToLinear) + gNorm * highToLinear;
    }

    vec3 col = u_color * wVal;
    outColor = vec4(col, 1.0);
}
`;

// ------------- WebGL helpers -------------

function createGLContext(width, height) {
    if (typeof OffscreenCanvas === "undefined") {
        return null;
    }
    try {
        glCanvas = new OffscreenCanvas(width, height);
        gl = glCanvas.getContext("webgl2", {
            premultipliedAlpha: false,
            preserveDrawingBuffer: false,
        });
        if (!gl) {
            glCanvas = null;
            return null;
        }
        return gl;
    } catch (_) {
        glCanvas = null;
        gl = null;
        return null;
    }
}

function compileShader(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    const ok = gl.getShaderParameter(shader, gl.COMPILE_STATUS);
    if (!ok) {
        const info = gl.getShaderInfoLog(shader) || "shader compile error";
        gl.deleteShader(shader);
        throw new Error(info);
    }
    return shader;
}

function safeLinkProgram(vs, fs) {
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    const ok = gl.getProgramParameter(prog, gl.LINK_STATUS);
    if (!ok) {
        const info = gl.getProgramInfoLog(prog) || "program link error";
        gl.deleteProgram(prog);
        throw new Error(info);
    }
    return prog;
}

function initGL(width, height) {
    if (gl && glCanvas) {
        glCanvas.width = width;
        glCanvas.height = height;
        gl.viewport(0, 0, width, height);
        return true;
    }

    if (!createGLContext(width, height)) return false;

    try {
        const vs = compileShader(gl.VERTEX_SHADER, VS_SOURCE);
        const fs = compileShader(gl.FRAGMENT_SHADER, FS_SOURCE);
        program = safeLinkProgram(vs, fs);

        gl.deleteShader(vs);
        gl.deleteShader(fs);

        aPositionLoc = gl.getAttribLocation(program, "a_position");
        uResolutionLoc = gl.getUniformLocation(program, "u_resolution");
        uCParamLoc = gl.getUniformLocation(program, "u_c");
        uColorLoc = gl.getUniformLocation(program, "u_color");
        uRawLoc = gl.getUniformLocation(program, "u_raw");
        uFillInteriorLoc = gl.getUniformLocation(program, "u_fillInterior");

        posBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
        const verts = new Float32Array([
            -1, -1,
            1, -1,
            -1, 1,
            1, 1,
        ]);
        gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);

        gl.viewport(0, 0, width, height);
        gl.disable(gl.DEPTH_TEST);

        return true;
    } catch (_) {
        glCanvas = null;
        gl = null;
        program = null;
        posBuffer = null;
        aPositionLoc = -1;
        uResolutionLoc = null;
        uCParamLoc = null;
        uColorLoc = null;
        uRawLoc = null;
        uFillInteriorLoc = null;
        return false;
    }
}

function renderJuliaWebGL(fbW, fbH, cRe, cIm, color, raw, fillInterior) {
    if (!initGL(fbW, fbH)) {
        return null;
    }

    glCanvas.width = fbW;
    glCanvas.height = fbH;
    gl.viewport(0, 0, fbW, fbH);

    gl.useProgram(program);

    gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
    gl.enableVertexAttribArray(aPositionLoc);
    gl.vertexAttribPointer(aPositionLoc, 2, gl.FLOAT, false, 0, 0);

    gl.uniform2f(uResolutionLoc, fbW, fbH);
    gl.uniform2f(uCParamLoc, cRe, cIm);

    const r = (color && Number.isFinite(color.r)) ? color.r / 255 : 0;
    const g = (color && Number.isFinite(color.g)) ? color.g / 255 : 1;
    const b = (color && Number.isFinite(color.b)) ? color.b / 255 : 1;
    gl.uniform3f(uColorLoc, r, g, b);

    gl.uniform1f(uRawLoc, raw);
    gl.uniform1f(uFillInteriorLoc, fillInterior ? 1.0 : 0.0);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    const pixels = new Uint8Array(fbW * fbH * 4);
    gl.readPixels(0, 0, fbW, fbH, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

    return pixels;
}

// ------------- CPU fallback with same glow curve -------------

function applyGlow(gNorm, raw, fillInterior, isInterior) {
    if (gNorm <= 0) return 0;

    raw = Math.max(0, Math.min(100, raw));
    const isLowBlur = raw <= 50;
    const isHighBlur = raw > 50;

    if (isInterior && fillInterior) return 1;

    let wVal;
    if (isLowBlur) {
        const clamped = raw;
        const tOrig = clamped / 100;
        const minExp = 0.25;
        const maxExp = 3.0;
        const lowExp = minExp + (1 - tOrig) * (maxExp - minExp);
        const lowToLinear = clamped / 50;

        let base = Math.pow(gNorm, lowExp);
        if (base < 0) base = 0;
        if (base > 1) base = 1;
        wVal = base * (1 - lowToLinear) + gNorm * lowToLinear;
    } else if (isHighBlur) {
        const u = (raw - 50) / 50;
        const bandWidth = 1 - 0.8 * u;
        const highToLinear = (100 - raw) / 50;

        const burn = gNorm >= bandWidth ? 1 : gNorm / bandWidth;
        wVal = burn * (1 - highToLinear) + gNorm * highToLinear;
    } else {
        wVal = gNorm;
    }

    return wVal;
}

function renderJuliaCPU(fbW, fbH, cRe, cIm, color, raw, fillInterior) {
    const pixels = new Uint8Array(fbW * fbH * 4);

    const aspect = fbW / fbH;
    const scale = 1.5;
    const maxIter = MAX_ITER;

    const rC = (color && Number.isFinite(color.r)) ? color.r : 0;
    const gC = (color && Number.isFinite(color.g)) ? color.g : 255;
    const bC = (color && Number.isFinite(color.b)) ? color.b : 255;

    let idx = 0;
    for (let j = 0; j < fbH; j++) {
        const v = fbH > 1 ? j / (fbH - 1) : 0.5;
        const y0 = (v - 0.5) * 2 * scale;

        for (let i = 0; i < fbW; i++) {
            const u = fbW > 1 ? i / (fbW - 1) : 0.5;
            const x0 = (u - 0.5) * 2 * scale * aspect;

            let zr = x0;
            let zi = y0;
            let escapeIter = maxIter;
            let escaped = false;

            for (let it = 0; it < maxIter; it++) {
                const zr2 = zr * zr - zi * zi + cRe;
                const zi2 = 2 * zr * zi + cIm;
                zr = zr2;
                zi = zi2;

                if (!escaped && (zr * zr + zi * zi) > BAILOUT_SQ) {
                    escaped = true;
                    escapeIter = it;
                    break;
                }
            }

            const isInterior = !escaped;
            const gNorm = isInterior ? 1 : escapeIter / maxIter;

            if (gNorm <= 0) {
                pixels[idx++] = 0;
                pixels[idx++] = 0;
                pixels[idx++] = 0;
                pixels[idx++] = 255;
                continue;
            }

            const wVal = applyGlow(gNorm, raw, !!fillInterior, isInterior);

            const r = Math.round(rC * wVal);
            const g = Math.round(gC * wVal);
            const b = Math.round(bC * wVal);

            pixels[idx++] = r;
            pixels[idx++] = g;
            pixels[idx++] = b;
            pixels[idx++] = 255;
        }
    }

    return pixels;
}

// ------------- Worker protocol -------------

self.postMessage({ type: "ready" });

self.onmessage = (e) => {
    const msg = e.data;
    if (!msg || msg.type !== "render") return;

    const {
        jobId,
        fbW,
        fbH,
        cRe,
        cIm,
        color,
        raw,
        fillInterior,
        scale,
    } = msg;

    let pixels = null;
    try {
        pixels = renderJuliaWebGL(
            fbW | 0,
            fbH | 0,
            +cRe,
            +cIm,
            color,
            +raw,
            fillInterior ? 1 : 0,
        );
    } catch (_) {
        pixels = null;
    }

    if (!pixels) {
        try {
            pixels = renderJuliaCPU(
                fbW | 0,
                fbH | 0,
                +cRe,
                +cIm,
                color,
                +raw,
                fillInterior ? 1 : 0,
            );
        } catch (err) {
            self.postMessage({
                type: "error",
                message: (err && err.message) || "Julia CPU render error",
            });
            return;
        }
    }

    self.postMessage(
        {
            type: "frame",
            jobId,
            fbW,
            fbH,
            scale,
            pixels: pixels.buffer,
        },
        [pixels.buffer],
    );
};
