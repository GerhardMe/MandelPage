"use strict";
// Defaults (used if main thread doesn't send maxIter)
const DEFAULT_MAX_ITER = 300;
const BAILOUT_RADIUS = 4.0;
const BAILOUT_SQ = BAILOUT_RADIUS * BAILOUT_RADIUS;
// Supersample limits (scale < 1 path)
const MAX_SUPERSAMPLE_FACTOR = 6;       // cap 1/scale -> factor
const MAX_UPSAMPLE_PIXELS = 10_000_000; // cap internal render size
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
let compiledMaxIter = null; // track shader iteration count used by current program
// -------- Shader source builders (maxIter baked in) --------
function vsSourceWebGL2() {
    return `#version 300 es
in vec2 a_position;
out vec2 v_uv;
void main() {
    v_uv = a_position * 0.5 + 0.5;
    gl_Position = vec4(a_position, 0.0, 1.0);
}
`;
}
function fsSourceWebGL2(maxIter) {
    const mi = Math.max(1, (maxIter | 0));
    return `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform vec2 u_resolution;
uniform vec2 u_c;           // (cRe, cIm)
uniform vec4 u_viewRect;    // (xMin, xMax, yMin, yMax)
const int maxIter = ${mi};
const float bailoutSq = ${BAILOUT_SQ.toFixed(1)};
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
    float gNorm = (!escaped) ? 1.0 : (escapeIter / float(maxIter));
    float g = clamp(gNorm, 0.0, 1.0);
    outColor = vec4(g, g, g, 1.0);
}
`;
}
function vsSourceWebGL1() {
    return `
attribute vec2 a_position;
varying vec2 v_uv;
void main() {
    v_uv = a_position * 0.5 + 0.5;
    gl_Position = vec4(a_position, 0.0, 1.0);
}
`;
}
function fsSourceWebGL1(maxIter) {
    const mi = Math.max(1, (maxIter | 0));
    return `
precision highp float;
varying vec2 v_uv;
uniform vec2 u_resolution;
uniform vec2 u_c;           // (cRe, cIm)
uniform vec4 u_viewRect;    // (xMin, xMax, yMin, yMax)
const int maxIter = ${mi};
const float bailoutSq = ${BAILOUT_SQ.toFixed(1)};
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
    float gNorm = (!escaped) ? 1.0 : (escapeIter / float(maxIter));
    float g = clamp(gNorm, 0.0, 1.0);
    gl_FragColor = vec4(g, g, g, 1.0);
}
`;
}
// ------------- WebGL helpers -------------
function createGLContext(width, height) {
    if (typeof OffscreenCanvas === "undefined") return null;
    try {
        glCanvas = new OffscreenCanvas(width, height);
        let ctx = glCanvas.getContext("webgl2", {
            premultipliedAlpha: false,
            preserveDrawingBuffer: false,
        });
        if (ctx) {
            gl = ctx;
            isWebGL2 = true;
            return gl;
        }
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
    } catch {
        glCanvas = null;
        gl = null;
        return null;
    }
}
function compileShader(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
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
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        const info = gl.getProgramInfoLog(prog) || "program link error";
        gl.deleteProgram(prog);
        throw new Error(info);
    }
    return prog;
}
function teardownGL() {
    try {
        if (gl && program) gl.deleteProgram(program);
    } catch (_) { /* ignore */ }
    try {
        if (gl && posBuffer) gl.deleteBuffer(posBuffer);
    } catch (_) { /* ignore */ }
    program = null;
    posBuffer = null;
    aPositionLoc = -1;
    uResolutionLoc = null;
    uCParamLoc = null;
    uViewRectLoc = null;
    compiledMaxIter = null;
}
function initGL(width, height, maxIter) {
    // If we already have GL but shader maxIter changed, rebuild program.
    if (gl && glCanvas) {
        glCanvas.width = width;
        glCanvas.height = height;
        gl.viewport(0, 0, width, height);
        if ((maxIter | 0) === (compiledMaxIter | 0) && program) {
            return true;
        }
        teardownGL();
    }
    if (!gl) {
        if (!createGLContext(width, height)) return false;
    }
    try {
        const vsSource = isWebGL2 ? vsSourceWebGL2() : vsSourceWebGL1();
        const fsSource = isWebGL2 ? fsSourceWebGL2(maxIter) : fsSourceWebGL1(maxIter);
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
        gl.bufferData(
            gl.ARRAY_BUFFER,
            new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
            gl.STATIC_DRAW
        );
        gl.viewport(0, 0, width, height);
        gl.disable(gl.DEPTH_TEST);
        compiledMaxIter = maxIter | 0;
        return true;
    } catch (err) {
        self.postMessage({
            type: "error",
            message:
                "Julia WebGL init failed: " +
                (err && err.message ? err.message : String(err)),
        });
        glCanvas = null;
        gl = null;
        teardownGL();
        return false;
    }
}
// WebGL render: returns Uint8Array length = w*h (grayscale 0..255)
function renderJuliaWebGL(w, h, cRe, cIm, viewRect, maxIter) {
    if (!initGL(w, h, maxIter)) return null;
    glCanvas.width = w;
    glCanvas.height = h;
    gl.viewport(0, 0, w, h);
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
    gl.enableVertexAttribArray(aPositionLoc);
    gl.vertexAttribPointer(aPositionLoc, 2, gl.FLOAT, false, 0, 0);
    gl.uniform2f(uResolutionLoc, w, h);
    gl.uniform2f(uCParamLoc, cRe, cIm);
    if (
        viewRect &&
        Number.isFinite(viewRect.xMin) &&
        Number.isFinite(viewRect.xMax) &&
        Number.isFinite(viewRect.yMin) &&
        Number.isFinite(viewRect.yMax)
    ) {
        gl.uniform4f(
            uViewRectLoc,
            viewRect.xMin,
            viewRect.xMax,
            viewRect.yMin,
            viewRect.yMax
        );
    } else {
        gl.uniform4f(uViewRectLoc, 0.0, 0.0, 0.0, 0.0);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    const rgba = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    const gray = new Uint8Array(w * h);
    for (let i = 0, gi = 0; i < rgba.length; i += 4) {
        gray[gi++] = rgba[i];
    }
    return gray;
}
// ------------- CPU fallback -------------
function renderJuliaCPU(w, h, cRe, cIm, viewRect, maxIter) {
    const mi = Math.max(1, (maxIter | 0));
    const gray = new Uint8Array(w * h);
    const hasView =
        viewRect &&
        Number.isFinite(viewRect.xMin) &&
        Number.isFinite(viewRect.xMax) &&
        Number.isFinite(viewRect.yMin) &&
        Number.isFinite(viewRect.yMax) &&
        viewRect.xMin < viewRect.xMax &&
        viewRect.yMin < viewRect.yMax;
    const aspect = w / h;
    const baseScale = 1.5;
    const spanX = hasView ? viewRect.xMax - viewRect.xMin : 2 * baseScale * aspect;
    const spanY = hasView ? viewRect.yMax - viewRect.yMin : 2 * baseScale;
    const xMin = hasView ? viewRect.xMin : -spanX / 2;
    const yMin = hasView ? viewRect.yMin : -spanY / 2;
    let idx = 0;
    for (let j = 0; j < h; j++) {
        const v = h > 1 ? (j + 0.5) / h : 0.5;
        const y0 = yMin + v * spanY;
        for (let i = 0; i < w; i++) {
            const u = w > 1 ? (i + 0.5) / w : 0.5;
            const x0 = xMin + u * spanX;
            let zr = x0;
            let zi = y0;
            let escapeIter = mi;
            let escaped = false;
            for (let it = 0; it < mi; it++) {
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
            const gNorm = escaped ? (escapeIter / mi) : 1;
            const g = gNorm <= 0 ? 0 : gNorm >= 1 ? 1 : gNorm;
            gray[idx++] = (g * 255 + 0.5) | 0;
        }
    }
    return gray;
}
// ------------- Downsample (box filter) -------------
function downsampleBox(grayUp, upW, upH, outW, outH, factor) {
    const out = new Uint8Array(outW * outH);
    const area = factor * factor;
    let oi = 0;
    for (let y = 0; y < outH; y++) {
        const y0 = y * factor;
        for (let x = 0; x < outW; x++) {
            const x0 = x * factor;
            let sum = 0;
            for (let dy = 0; dy < factor; dy++) {
                let row = (y0 + dy) * upW + x0;
                for (let dx = 0; dx < factor; dx++) {
                    sum += grayUp[row + dx];
                }
            }
            out[oi++] = (sum / area + 0.5) | 0;
        }
    }
    return out;
}
// ------------- Scale semantics -------------
function computeSupersampleFactor(scale, outW, outH) {
    if (!(scale > 0) || scale >= 1) return 1;
    let f = Math.round(1 / scale);
    if (f < 1) f = 1;
    if (f > MAX_SUPERSAMPLE_FACTOR) f = MAX_SUPERSAMPLE_FACTOR;
    while (f > 1 && (outW * f) * (outH * f) > MAX_UPSAMPLE_PIXELS) {
        f--;
    }
    return f < 1 ? 1 : f;
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
        scale,
        viewXMin,
        viewXMax,
        viewYMin,
        viewYMax,
        maxIter,
    } = msg;
    const outW = fbW | 0;
    const outH = fbH | 0;
    if (!outW || !outH) return;
    // clamp iterations (keeps shader compile sane)
    let mi = parseInt(maxIter, 10);
    if (!Number.isFinite(mi)) mi = DEFAULT_MAX_ITER;
    mi = Math.max(1, Math.min(50000, mi)); // adjust upper bound if you want
    const viewRect =
        viewXMin == null || viewXMax == null || viewYMin == null || viewYMax == null
            ? null
            : { xMin: +viewXMin, xMax: +viewXMax, yMin: +viewYMin, yMax: +viewYMax };
    const ssFactor = computeSupersampleFactor(+scale, outW, outH);
    const upW = outW * ssFactor;
    const upH = outH * ssFactor;
    let grayUp = null;
    let backend = "gpu";
    try {
        grayUp = renderJuliaWebGL(upW, upH, +cRe, +cIm, viewRect, mi);
    } catch (err) {
        self.postMessage({
            type: "error",
            message:
                "Julia WebGL render error: " +
                (err && err.message ? err.message : String(err)),
        });
        grayUp = null;
    }
    if (!grayUp) {
        backend = "cpu";
        try {
            grayUp = renderJuliaCPU(upW, upH, +cRe, +cIm, viewRect, mi);
        } catch (err) {
            self.postMessage({
                type: "error",
                message: (err && err.message) || "Julia CPU render error",
            });
            return;
        }
    }
    let gray = grayUp;
    if (ssFactor > 1) {
        gray = downsampleBox(grayUp, upW, upH, outW, outH, ssFactor);
    }
    self.postMessage({
        type: "status",
        jobId,
        backend,
    });
    self.postMessage(
        {
            type: "frame",
            jobId,
            fbW: outW,
            fbH: outH,
            scale,
            gray: gray.buffer,
        },
        [gray.buffer]
    );
};