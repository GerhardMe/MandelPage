// /mandelbrot/julia-worker.js
//
// Protocol:
//   main -> worker:
//     {
//       type: "render",
//       jobId,
//       fbW, fbH,        // *stage* resolution
//       cRe, cIm,        // Julia parameter
//       color: { r, g, b }, // IGNORED (kept for compatibility)
//       raw,             // IGNORED (0..100, bandwidth slider)
//       fillInterior,    // IGNORED (0/1)
//       scale            // stage scale factor (4, 1, ...), just echoed back
//     }
//
//   worker -> main (GRAYSCALE ONLY):
//     { type: "frame", jobId, fbW, fbH, scale, gray: ArrayBuffer }
//
// Semantics:
//   gray[i] in [0..255]
//   - 0   = fast escape
//   - 255 = interior (did not escape in MAX_ITER)
//   - intermediate = linear in escape iteration

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

// Vertex shader: fullscreen quad
const VS_SOURCE = `#version 300 es
in vec2 a_position;
out vec2 v_uv;
void main() {
    v_uv = a_position * 0.5 + 0.5;
    gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

// Fragment shader: Julia set, outputs *linear grayscale* in 0..1
const FS_SOURCE = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 outColor;

uniform vec2 u_resolution;
uniform vec2 u_c;           // (cRe, cIm)

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

    // Interior = did not escape in maxIter
    bool isInterior = !escaped;

    // Normalized escape value: 1.0 for interior, [0,1) otherwise
    float gNorm = isInterior ? 1.0 : (escapeIter / float(maxIter));

    float g = clamp(gNorm, 0.0, 1.0);
    outColor = vec4(g, g, g, 1.0);
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
        return false;
    }
}

// WebGL path: returns Uint8Array(gray) length = fbW*fbH
function renderJuliaWebGL(fbW, fbH, cRe, cIm) {
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

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    const rgba = new Uint8Array(fbW * fbH * 4);
    gl.readPixels(0, 0, fbW, fbH, gl.RGBA, gl.UNSIGNED_BYTE, rgba);

    const gray = new Uint8Array(fbW * fbH);
    let gi = 0;
    for (let i = 0; i < rgba.length; i += 4) {
        gray[gi++] = rgba[i]; // R channel; all channels are equal
    }

    return gray;
}

// ------------- CPU fallback: pure grayscale -------------

function renderJuliaCPU(fbW, fbH, cRe, cIm) {
    const gray = new Uint8Array(fbW * fbH);

    const aspect = fbW / fbH;
    const scale = 1.5;
    const maxIter = MAX_ITER;

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
            const gClamped = gNorm <= 0 ? 0 : gNorm >= 1 ? 1 : gNorm;
            gray[idx++] = Math.round(gClamped * 255);
        }
    }

    return gray;
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
        // color, raw, fillInterior, // now ignored, but accepted
        scale,
    } = msg;

    let gray = null;
    try {
        gray = renderJuliaWebGL(
            fbW | 0,
            fbH | 0,
            +cRe,
            +cIm,
        );
    } catch (_) {
        gray = null;
    }

    if (!gray) {
        try {
            gray = renderJuliaCPU(
                fbW | 0,
                fbH | 0,
                +cRe,
                +cIm,
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
            gray: gray.buffer,
        },
        [gray.buffer],
    );
};
