// /mandelbrot/julia-worker.js
//
// Protocol:
//   main -> worker:
//     {
//       type: "render",
//       jobId,
//       fbW, fbH,        // framebuffer resolution
//       cRe, cIm,        // Julia parameter
//       color, raw,      // IGNORED (kept for compatibility)
//       fillInterior,    // IGNORED
//       scale,           // stage scale factor (4, 1, ...), just echoed back
//
//       // Optional world rect for subrenders / zoom:
//       // If provided, worker maps pixel -> complex via this rect.
//       // If omitted, worker uses the old symmetric view around 0.
//       viewXMin, viewXMax,
//       viewYMin, viewYMax,
//
//       // Optional grayscale mode:
//       //   false / omitted -> absolute grayscale (default behavior)
//       //   true           -> relative grayscale (max contrast)
//       relativeGray,
//     }
//
//   worker -> main (GRAYSCALE ONLY):
//     { type: "frame", jobId, fbW, fbH, scale, gray: ArrayBuffer }
//
//   worker -> main (STATUS):
//     { type: "status", jobId, backend, grayscale }
//
// Semantics (absolute mode):
//   gray[i] in [0..255]
//   - 0   = fast escape
//   - 255 = interior (did not escape in MAX_ITER)
//   - intermediate = linear in escape iteration
//
// Semantics (relative mode):
//   - Start from the absolute gray buffer.
//   - Let interior pixels be those with gray == 255 from the iteration logic.
//   - Among non-interior pixels, find minGray and maxGray.
//   - If minGray < maxGray:
//       remap each non-interior pixel linearly so minGray -> 0, maxGray -> 255.
//     Interior pixels remain 255.
//   - If there are no non-interior pixels or range is degenerate, fall back
//     to the absolute buffer (no change).

"use strict";

const MAX_ITER = 300;
const BAILOUT_RADIUS = 4.0;
const BAILOUT_SQ = BAILOUT_RADIUS * BAILOUT_RADIUS;

// ------------- WebGL state -------------

let glCanvas = null;
let gl = null;
let program = null;
let posBuffer = null;
let isWebGL2 = false;

let aPositionLoc = -1;
let uResolutionLoc = null;
let uCParamLoc = null;
let uViewRectLoc = null; // xMin, xMax, yMin, yMax

// Vertex shader: fullscreen quad (WebGL2)
const VS_SOURCE_WEBGL2 = `#version 300 es
in vec2 a_position;
out vec2 v_uv;
void main() {
    v_uv = a_position * 0.5 + 0.5;
    gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

// Fragment shader: Julia set, outputs *linear grayscale* in 0..1 (WebGL2)
const FS_SOURCE_WEBGL2 = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 outColor;

uniform vec2 u_resolution;
uniform vec2 u_c;           // (cRe, cIm)
uniform vec4 u_viewRect;    // (xMin, xMax, yMin, yMax)

const int maxIter = ${MAX_ITER};
const float bailoutSq = ${BAILOUT_RADIUS} * ${BAILOUT_RADIUS};

void main() {
    vec2 z;

    bool hasView =
        (u_viewRect.x < u_viewRect.y) &&
        (u_viewRect.z < u_viewRect.w);

    if (hasView) {
        float x = mix(u_viewRect.x, u_viewRect.y, v_uv.x);
        float y = mix(u_viewRect.z, u_viewRect.w, v_uv.y);
        z = vec2(x, y);
    } else {
        float aspect = u_resolution.x / u_resolution.y;
        float scale = 1.5;
        float x = (v_uv.x - 0.5) * 2.0 * scale * aspect;
        float y = (v_uv.y - 0.5) * 2.0 * scale;
        z = vec2(x, y);
    }

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
    float g = clamp(gNorm, 0.0, 1.0);
    outColor = vec4(g, g, g, 1.0);
}
`;

// Vertex shader: fullscreen quad (WebGL1)
const VS_SOURCE_WEBGL1 = `
attribute vec2 a_position;
varying vec2 v_uv;
void main() {
    v_uv = a_position * 0.5 + 0.5;
    gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

// Fragment shader: Julia set, outputs *linear grayscale* in 0..1 (WebGL1)
// All int->float conversions are explicit to satisfy GLSL ES 1.00.
const FS_SOURCE_WEBGL1 = `
precision highp float;

varying vec2 v_uv;

uniform vec2 u_resolution;
uniform vec2 u_c;           // (cRe, cIm)
uniform vec4 u_viewRect;    // (xMin, xMax, yMin, yMax)

const int maxIter = ${MAX_ITER};
const float bailoutSq = ${BAILOUT_RADIUS} * ${BAILOUT_RADIUS};

void main() {
    vec2 z;

    bool hasView =
        (u_viewRect.x < u_viewRect.y) &&
        (u_viewRect.z < u_viewRect.w);

    if (hasView) {
        float x = mix(u_viewRect.x, u_viewRect.y, v_uv.x);
        float y = mix(u_viewRect.z, u_viewRect.w, v_uv.y);
        z = vec2(x, y);
    } else {
        float aspect = u_resolution.x / u_resolution.y;
        float scale = 1.5;
        float x = (v_uv.x - 0.5) * 2.0 * scale * aspect;
        float y = (v_uv.y - 0.5) * 2.0 * scale;
        z = vec2(x, y);
    }

    vec2 c = u_c;

    float escapeIter = float(maxIter);
    bool escaped = false;

    for (int i = 0; i < maxIter; i++) {
        float x2 = z.x * z.x - z.y * z.y + c.x;
        float y2 = 2.0 * z.x * z.y + c.y;
        z = vec2(x2, y2);

        if (!escaped && dot(z, z) > bailoutSq) {
            escaped = true;
            escapeIter = float(i);  // explicit cast
            break;
        }
    }

    bool isInterior = !escaped;
    float gNorm = isInterior ? 1.0 : (escapeIter / float(maxIter));
    float g = clamp(gNorm, 0.0, 1.0);

    gl_FragColor = vec4(g, g, g, 1.0);
}
`;

// ------------- WebGL helpers -------------

function createGLContext(width, height) {
    if (typeof OffscreenCanvas === "undefined") {
        return null;
    }

    try {
        glCanvas = new OffscreenCanvas(width, height);

        // Try WebGL2 first.
        let ctx = glCanvas.getContext("webgl2", {
            premultipliedAlpha: false,
            preserveDrawingBuffer: false,
        });

        if (ctx) {
            gl = ctx;
            isWebGL2 = true;
            return gl;
        }

        // Fallback to WebGL1.
        ctx = glCanvas.getContext("webgl", {
            premultipliedAlpha: false,
            preserveDrawingBuffer: false,
        });

        if (!ctx) {
            glCanvas = null;
            gl = null;
            return null;
        }

        gl = ctx;
        isWebGL2 = false;
        return gl;
    } catch (err) {
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
        const vsSource = isWebGL2 ? VS_SOURCE_WEBGL2 : VS_SOURCE_WEBGL1;
        const fsSource = isWebGL2 ? FS_SOURCE_WEBGL2 : FS_SOURCE_WEBGL1;

        const vs = compileShader(gl.VERTEX_SHADER, vsSource);
        const fs = compileShader(gl.FRAGMENT_SHADER, fsSource);
        program = safeLinkProgram(vs, fs);

        gl.deleteShader(vs);
        gl.deleteShader(fs);

        aPositionLoc = gl.getAttribLocation(program, "a_position");
        uResolutionLoc = gl.getUniformLocation(program, "u_resolution");
        uCParamLoc = gl.getUniformLocation(program, "u_c");
        uViewRectLoc = gl.getUniformLocation(program, "u_viewRect");

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
    } catch (err) {
        self.postMessage({
            type: "error",
            message: "Julia WebGL init failed: " +
                (err && err.message ? err.message : String(err)),
        });

        glCanvas = null;
        gl = null;
        program = null;
        posBuffer = null;
        aPositionLoc = -1;
        uResolutionLoc = null;
        uCParamLoc = null;
        uViewRectLoc = null;
        return false;
    }
}

// WebGL path: returns Uint8Array(gray) length = fbW*fbH.
// viewRect may be null OR { xMin, xMax, yMin, yMax }.
function renderJuliaWebGL(fbW, fbH, cRe, cIm, viewRect) {
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

    if (viewRect &&
        Number.isFinite(viewRect.xMin) &&
        Number.isFinite(viewRect.xMax) &&
        Number.isFinite(viewRect.yMin) &&
        Number.isFinite(viewRect.yMax)) {
        gl.uniform4f(
            uViewRectLoc,
            viewRect.xMin,
            viewRect.xMax,
            viewRect.yMin,
            viewRect.yMax,
        );
    } else {
        // Invalid/missing rect: signal "no view" to shader.
        gl.uniform4f(uViewRectLoc, 0.0, 0.0, 0.0, 0.0);
    }

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    const rgba = new Uint8Array(fbW * fbH * 4);
    gl.readPixels(0, 0, fbW, fbH, gl.RGBA, gl.UNSIGNED_BYTE, rgba);

    const gray = new Uint8Array(fbW * fbH);
    let gi = 0;
    for (let i = 0; i < rgba.length; i += 4) {
        gray[gi++] = rgba[i]; // R channel; all channels are equal.
    }

    return gray;
}

// ------------- CPU fallback: pure grayscale with optional view rect -------------

// viewRect may be null OR { xMin, xMax, yMin, yMax }
function renderJuliaCPU(fbW, fbH, cRe, cIm, viewRect) {
    const gray = new Uint8Array(fbW * fbH);

    const hasView =
        viewRect &&
        Number.isFinite(viewRect.xMin) &&
        Number.isFinite(viewRect.xMax) &&
        Number.isFinite(viewRect.yMin) &&
        Number.isFinite(viewRect.yMax) &&
        viewRect.xMin < viewRect.xMax &&
        viewRect.yMin < viewRect.yMax;

    const aspect = fbW / fbH;
    const baseScale = 1.5;
    const maxIter = MAX_ITER;

    const spanX = hasView ? (viewRect.xMax - viewRect.xMin) : 2 * baseScale * aspect;
    const spanY = hasView ? (viewRect.yMax - viewRect.yMin) : 2 * baseScale;
    const xMin = hasView ? viewRect.xMin : -spanX / 2;
    const yMin = hasView ? viewRect.yMin : -spanY / 2;

    let idx = 0;
    for (let j = 0; j < fbH; j++) {
        const v = fbH > 1 ? (j + 0.5) / fbH : 0.5;
        const y0 = yMin + v * spanY;

        for (let i = 0; i < fbW; i++) {
            const u = fbW > 1 ? (i + 0.5) / fbW : 0.5;
            const x0 = xMin + u * spanX;

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

// ------------- Relative grayscale post-processing -------------

// Modifies gray in-place.
// Returns true if remapping was applied, false if skipped (e.g. degenerate range).
function applyRelativeGrayscale(gray) {
    const len = gray.length;

    let minVal = 255;
    let maxVal = 0;

    for (let i = 0; i < len; i++) {
        const v = gray[i];
        if (v === 255) continue; // interior
        if (v < minVal) minVal = v;
        if (v > maxVal) maxVal = v;
    }

    if (minVal > maxVal || minVal === 255) return false;
    const range = maxVal - minVal;
    if (range <= 0) return false;

    for (let i = 0; i < len; i++) {
        const v = gray[i];
        if (v === 255) continue; // preserve interior
        const t = (v - minVal) / range;
        let g = Math.round(t * 255);
        if (g < 0) g = 0;
        else if (g > 255) g = 255;
        gray[i] = g;
    }

    return true;
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
        scale, // just echoed back

        // optional subrender rect:
        viewXMin,
        viewXMax,
        viewYMin,
        viewYMax,

        // optional grayscale mode:
        relativeGray,
    } = msg;

    const w = fbW | 0;
    const h = fbH | 0;
    if (!w || !h) return;

    const viewRect =
        viewXMin == null || viewXMax == null || viewYMin == null || viewYMax == null
            ? null
            : {
                xMin: +viewXMin,
                xMax: +viewXMax,
                yMin: +viewYMin,
                yMax: +viewYMax,
            };

    let gray = null;
    let backend = "gpu";

    try {
        gray = renderJuliaWebGL(
            w,
            h,
            +cRe,
            +cIm,
            viewRect,
        );
    } catch (err) {
        self.postMessage({
            type: "error",
            message: "Julia WebGL render error: " +
                (err && err.message ? err.message : String(err)),
        });
        gray = null;
    }

    if (!gray) {
        backend = "cpu";
        try {
            gray = renderJuliaCPU(
                w,
                h,
                +cRe,
                +cIm,
                viewRect,
            );
        } catch (err) {
            self.postMessage({
                type: "error",
                message: (err && err.message) || "Julia CPU render error",
            });
            return;
        }
    }

    const useRelative = !!relativeGray;
    let grayscaleMode = "absolute";

    if (useRelative) {
        const applied = applyRelativeGrayscale(gray);
        if (applied) {
            grayscaleMode = "relative";
        }
    }

    self.postMessage({
        type: "status",
        jobId,
        backend,               // "gpu" or "cpu"
        grayscale: grayscaleMode,
    });

    self.postMessage(
        {
            type: "frame",
            jobId,
            fbW: w,
            fbH: h,
            scale,
            gray: gray.buffer,
        },
        [gray.buffer],
    );
};
