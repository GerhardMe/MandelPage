// /mandelbrot/julia-worker.js

// Julia GPU worker (with CPU fallback).
// Protocol:
//  - on load: posts { type: "ready" }
//  - on message { type: "render", jobId, fbW, fbH, cRe, cIm }:
//      renders Julia set and posts
//      { type: "frame", jobId, fbW, fbH, pixels: ArrayBuffer }

"use strict";

const MAX_ITER = 300;
const BAILOUT_RADIUS = 4.0;

// ------------- WebGL2 state -------------

let glCanvas = null;
let gl = null;
let program = null;
let posBuffer = null;
let aPositionLoc = -1;
let uResolutionLoc = null;
let uCParamLoc = null;

// Simple full-screen quad vertex shader
const VS_SOURCE = `#version 300 es
in vec2 a_position;
out vec2 v_uv;
void main() {
    v_uv = a_position * 0.5 + 0.5;
    gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

// Fragment shader: Julia set, RGBA out
// Maps viewport to a symmetric region, keeps aspect ratio.
const FS_SOURCE = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 outColor;

uniform vec2 u_resolution;
uniform vec2 u_c; // c = (cRe, cIm)

// Simple color map based on iteration count
vec3 palette(float t) {
    // t in [0,1]
    // Cheap smooth palette
    float r = 0.5 + 0.5 * cos(6.2831 * (t + 0.0));
    float g = 0.5 + 0.5 * cos(6.2831 * (t + 0.33));
    float b = 0.5 + 0.5 * cos(6.2831 * (t + 0.67));
    return vec3(r, g, b);
}

void main() {
    // Maintain aspect ratio, map to a centered region
    float aspect = u_resolution.x / u_resolution.y;
    float scale = 1.5; // zoom of Julia viewport

    // v_uv in [0,1]
    float x = (v_uv.x - 0.5) * 2.0 * scale * aspect;
    float y = (v_uv.y - 0.5) * 2.0 * scale;

    vec2 z = vec2(x, y);
    vec2 c = u_c;

    const int maxIter = ${MAX_ITER};
    float iter = 0.0;
    float escapeIter = 0.0;
    bool escaped = false;

    for (int i = 0; i < maxIter; i++) {
        float x2 = z.x * z.x - z.y * z.y + c.x;
        float y2 = 2.0 * z.x * z.y + c.y;
        z = vec2(x2, y2);

        if (!escaped && dot(z, z) > ${BAILOUT_RADIUS}.0) {
            escaped = true;
            escapeIter = float(i);
            break;
        }
        iter = float(i);
    }

    if (!escaped) {
        // Inside: dark / filled
        outColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
    }

    float t = escapeIter / float(maxIter);
    vec3 col = palette(t);
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

function linkProgram(vs, fs) {
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
        program = linkProgram(vs, fs);

        gl.deleteShader(vs);
        gl.deleteShader(fs);

        aPositionLoc = gl.getAttribLocation(program, "a_position");
        uResolutionLoc = gl.getUniformLocation(program, "u_resolution");
        uCParamLoc = gl.getUniformLocation(program, "u_c");

        posBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
        // Full-screen quad (two triangles) in clip space
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
    } catch (err) {
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

    const pixels = new Uint8Array(fbW * fbH * 4);
    gl.readPixels(0, 0, fbW, fbH, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

    return pixels;
}

// ------------- CPU fallback -------------

function renderJuliaCPU(fbW, fbH, cRe, cIm) {
    const pixels = new Uint8Array(fbW * fbH * 4);

    const aspect = fbW / fbH;
    const scale = 1.5;

    const maxIter = MAX_ITER;
    const bailoutSq = BAILOUT_RADIUS * BAILOUT_RADIUS;

    let idx = 0;
    for (let j = 0; j < fbH; j++) {
        const v = j / (fbH - 1 || 1);
        const y0 = (v - 0.5) * 2 * scale;

        for (let i = 0; i < fbW; i++) {
            const u = i / (fbW - 1 || 1);
            const x0 = (u - 0.5) * 2 * scale * aspect;

            let zr = x0;
            let zi = y0;
            let escapeIter = maxIter;
            for (let it = 0; it < maxIter; it++) {
                const zr2 = zr * zr - zi * zi + cRe;
                const zi2 = 2 * zr * zi + cIm;
                zr = zr2;
                zi = zi2;

                if (zr * zr + zi * zi > bailoutSq) {
                    escapeIter = it;
                    break;
                }
            }

            let r, g, b;
            if (escapeIter === maxIter) {
                r = g = b = 0;
            } else {
                const t = escapeIter / maxIter;
                // Same palette idea as shader:
                const twoPi = 6.283185307179586;
                const tr = 0.5 + 0.5 * Math.cos(twoPi * (t + 0.0));
                const tg = 0.5 + 0.5 * Math.cos(twoPi * (t + 0.33));
                const tb = 0.5 + 0.5 * Math.cos(twoPi * (t + 0.67));
                r = Math.round(tr * 255);
                g = Math.round(tg * 255);
                b = Math.round(tb * 255);
            }

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

    const { jobId, fbW, fbH, cRe, cIm } = msg;

    let pixels = null;
    try {
        // Try GPU first
        pixels = renderJuliaWebGL(fbW | 0, fbH | 0, +cRe, +cIm);
    } catch (_) {
        pixels = null;
    }

    // Fallback to CPU if GPU not available
    if (!pixels) {
        try {
            pixels = renderJuliaCPU(fbW | 0, fbH | 0, +cRe, +cIm);
        } catch (err) {
            self.postMessage({
                type: "error",
                message: err && err.message ? err.message : "Julia CPU render error",
            });
            return;
        }
    }

    // Transfer the underlying buffer back to main thread
    self.postMessage(
        {
            type: "frame",
            jobId,
            fbW,
            fbH,
            pixels: pixels.buffer,
        },
        [pixels.buffer],
    );
};
