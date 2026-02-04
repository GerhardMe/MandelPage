"use strict";
// ------------------ world / framebuffer ------------------
let centerX = -0.75;
let centerY = 0.0;
let zoom = 1.0;
let fillInterior = fillInside && fillInside.checked ? 1 : 0;
let relativeContrast = true; // toggle for contrast normalization
let fullW = 0;
let fullH = 0;
const baseCanvas = document.createElement("canvas");
const baseCtx = baseCanvas.getContext("2d");
let baseValid = false;
const bufCanvas = document.createElement("canvas");
const bufCtx = bufCanvas.getContext("2d");
let lastGray = null;
let lastFbW = 0;
let lastFbH = 0;
// Julia grayscale memory (for recolor)
let lastJuliaGray = null;
let lastJuliaFbW = 0;
let lastJuliaFbH = 0;
// screen transform (pan/zoom of base image)
let viewScale = 1;
let viewOffsetX = 0;
let viewOffsetY = 0;
// device pixel ratio for crisp rendering on high-DPI screens (capped at 2 for perf)
let canvasDpr = 1;
// ------------------ helpers ------------------
function worldParamsFor(cX, cY, z) {
    if (!fullW || !fullH) {
        return {
            worldWidth: 0,
            worldHeight: 0,
            worldX0: cX,
            worldY0: cY,
        };
    }
    const zSafe = z > 0 ? z : 1;
    const minDim = Math.min(fullW, fullH);
    const basePixelSize = 4.0 / minDim;
    const pixelSize = basePixelSize / zSafe;
    const worldWidth = pixelSize * fullW;
    const worldHeight = pixelSize * fullH;
    const worldX0 = cX - worldWidth / 2;
    const worldY0 = cY - worldHeight / 2;
    return { worldWidth, worldHeight, worldX0, worldY0 };
}
function screenToWorld(sx, sy) {
    const { worldWidth, worldHeight, worldX0, worldY0 } = worldParamsFor(
        centerX,
        centerY,
        zoom,
    );
    if (!fullW || !fullH || !worldWidth || !worldHeight) {
        return { cx: centerX, cy: centerY };
    }
    const s = viewScale || 1;
    const baseX = (sx - viewOffsetX) / s;
    const baseY = (sy - viewOffsetY) / s;
    const u = baseX / fullW;
    const v = baseY / fullH;
    const cx = worldX0 + u * worldWidth;
    const cy = worldY0 + v * worldHeight;
    return { cx, cy };
}
function worldToScreen(cx, cy) {
    const { worldWidth, worldHeight, worldX0, worldY0 } = worldParamsFor(
        centerX,
        centerY,
        zoom,
    );
    if (!fullW || !fullH || !worldWidth || !worldHeight) {
        return { sx: fullW / 2, sy: fullH / 2 };
    }
    const s = viewScale || 1;
    const u = (cx - worldX0) / worldWidth;
    const v = (cy - worldY0) / worldHeight;
    const baseX = u * fullW;
    const baseY = v * fullH;
    const sx = baseX * s + viewOffsetX;
    const sy = baseY * s + viewOffsetY;
    return { sx, sy };
}
function getCurrentView() {
    const effectiveZoom = zoom * (viewScale || 1);
    const baseParams = worldParamsFor(centerX, centerY, zoom);
    const { worldWidth, worldHeight, worldX0, worldY0 } = baseParams;
    if (!fullW || !fullH || !worldWidth || !worldHeight) {
        return { cx: centerX, cy: centerY, zoom: effectiveZoom };
    }
    const s = viewScale || 1;
    const baseXCenter = (fullW / 2 - viewOffsetX) / s;
    const baseYCenter = (fullH / 2 - viewOffsetY) / s;
    const u = baseXCenter / fullW;
    const v = baseYCenter / fullH;
    const cx = worldX0 + u * worldWidth;
    const cy = worldY0 + v * worldHeight;
    return { cx, cy, zoom: effectiveZoom };
}
function lockWorldPointToScreen(worldX, worldY, sx, sy) {
    const base = worldParamsFor(centerX, centerY, zoom);
    const s = viewScale || 1;
    const uNorm = (worldX - base.worldX0) / (base.worldWidth || 1e-9);
    const vNorm = (worldY - base.worldY0) / (base.worldHeight || 1e-9);
    const baseX = uNorm * fullW;
    const baseY = vNorm * fullH;
    viewOffsetX = sx - s * baseX;
    viewOffsetY = sy - s * baseY;
}
function resize() {
    const rect = canvas.getBoundingClientRect();
    canvasDpr = Math.min(window.devicePixelRatio || 1, 2);
    const newW = Math.max(1, Math.floor(rect.width));
    const newH = Math.max(1, Math.floor(rect.height));
    fullW = newW;
    fullH = newH;
    canvas.width = fullW * canvasDpr;
    canvas.height = fullH * canvasDpr;
    baseCanvas.width = fullW * canvasDpr;
    baseCanvas.height = fullH * canvasDpr;
    baseValid = false;
    lastGray = null;
    if (workerReady) {
        requestFullRender();
    }
}
window.addEventListener("resize", () => {
    resize();
    touchInteraction();
    syncJuliaCanvasSize();
    // After resize, re-render Julia at new size.
    requestJuliaRender();
});
// ------------------ glow helpers (Mandel vs Julia) ------------------
function getMandelGlowValue() {
    // Prefer a dedicated Mandel control if present
    if (typeof mandelGlow !== "undefined" && mandelGlow && mandelGlow.value != null) {
        return mandelGlow.value;
    }
    // Fallback to a generic glow slider if that's what exists
    if (typeof glow !== "undefined" && glow && glow.value != null) {
        return glow.value;
    }
    // Hard fallback: mid value
    return 50;
}
function getJuliaGlowValue() {
    if (typeof juliaGlow !== "undefined" && juliaGlow && juliaGlow.value != null) {
        return juliaGlow.value;
    }
    // If no dedicated Julia control, mirror Mandel
    return getMandelGlowValue();
}
// ------------------ contrast normalization ------------------
function normalizeContrast(gray) {
    // Remap grayscale values so min -> 0 and max -> 255
    // Skip 255 values (interior) when finding range

    const N = gray.length;
    if (N === 0) return gray;

    let minVal = 255;
    let maxVal = 0;

    for (let i = 0; i < N; i++) {
        const v = gray[i];
        if (v === 255) continue; // skip interior
        if (v < minVal) minVal = v;
        if (v > maxVal) maxVal = v;
    }

    // If only interior pixels exist, return as-is
    // If all non-interior values are the same, return as-is

    if (minVal >= maxVal) return gray;

    const out = new Uint8Array(N);
    const range = maxVal - minVal;
    const scale = 255 / range;

    for (let i = 0; i < N; i++) {
        const v = gray[i];
        if (v === 255) {
            out[i] = 255; // preserve interior
        } else {
            out[i] = Math.round((v - minVal) * scale);
        }
    }

    return out;
}
// ------------------ drawing helpers ------------------
function clamp01(x) {
    if (!Number.isFinite(x)) return 0;
    if (x < 0) return 0;
    if (x > 1) return 1;
    return x;
}
function clampInt(x, lo, hi) {
    const n = Number(x);
    if (!Number.isFinite(n)) return lo;
    const v = Math.trunc(n);
    return Math.max(lo, Math.min(hi, v));
}
function getSharedColorHex() {
    if (typeof fc !== "undefined" && fc && typeof fc.value === "string") {
        return fc.value;
    }
    return "#ffffff";
}
function colorizeGray(gray, opts = {}) {

    const N = gray.length | 0;
    const out = new Uint8ClampedArray(N * 4);
    const colorHex = typeof opts.colorHex === "string" ? opts.colorHex : getSharedColorHex();
    const color = hexToRgb(colorHex);
    const glow = clampInt(opts.glow, 0, 100);
    const fill = !!opts.fillInterior;
    // Keep the old feel, but make it explicit and numerically stable.
    // 0..50: power curve (more contrast control)
    // 50..100: band/burn (more "glow"/edge emphasis)
    const lowMode = glow <= 50;
    let lowExp = 1;
    let lowToLinear = 0;
    if (lowMode) {
        const t = glow / 50; // 0..1
        // At 0 -> exp ~3 (darker), at 50 -> exp ~0.25 (brighter)
        lowExp = 3.0 + (0.25 - 3.0) * t;
        lowToLinear = t;
    }
    let bandWidth = 1;
    let highToLinear = 0;
    if (!lowMode) {
        const u = (glow - 50) / 50; // 0..1
        bandWidth = 1 - 0.8 * u; // 1..0.2
        highToLinear = 1 - u; // 1..0
    }
    let o = 0;
    for (let i = 0; i < N; i++) {
        const v = gray[i] | 0;
        const gNorm = v / 255;
        let w;
        if (gNorm <= 0) {
            w = 0;
        } else if (fill && v === 255) {
            w = 1;
        } else if (lowMode) {
            // Smooth contrast curve blended toward linear.
            const curved = clamp01(Math.pow(gNorm, lowExp));
            w = curved * (1 - lowToLinear) + gNorm * lowToLinear;
        } else {
            // Burn into a band near the top.
            const burn = gNorm >= bandWidth ? 1 : gNorm / (bandWidth || 1e-9);
            w = burn * (1 - highToLinear) + gNorm * highToLinear;
        }
        const r = color.r * w;
        const g = color.g * w;
        const b = color.b * w;
        out[o++] = r;
        out[o++] = g;
        out[o++] = b;
        out[o++] = 255;
    }
    return out;
}
function redrawFromBase() {
    if (!baseValid) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(viewScale, 0, 0, viewScale, viewOffsetX * canvasDpr, viewOffsetY * canvasDpr);
    ctx.drawImage(baseCanvas, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
}
function redrawFullColored(gray, fbW, fbH) {
    // Mandelbrot uses its own glow control
    const colored = colorizeGray(gray, {
        colorHex: getSharedColorHex(),
        glow: getMandelGlowValue(),
        fillInterior,
        relativeContrast,
    });
    bufCanvas.width = fbW;
    bufCanvas.height = fbH;
    const img = new ImageData(colored, fbW, fbH);
    bufCtx.putImageData(img, 0, 0);
    baseCtx.setTransform(1, 0, 0, 1, 0, 0);
    baseCtx.clearRect(0, 0, baseCanvas.width, baseCanvas.height);
    baseCtx.drawImage(bufCanvas, 0, 0, fbW, fbH, 0, 0, baseCanvas.width, baseCanvas.height);
    baseValid = true;
}
function recolorFromLastGray() {
    if (!lastGray || lastFbW <= 0 || lastFbH <= 0) return;
    redrawFullColored(lastGray, lastFbW, lastFbH);
    redrawFromBase();
}
// Julia recolor using same colorizeGray but its own glow factor
function recolorJuliaFromLastGray() {
    if (
        !juliaCanvas ||
        !lastJuliaGray ||
        lastJuliaFbW <= 0 ||
        lastJuliaFbH <= 0
    ) {
        return;
    }
    const jctx = juliaCanvas.getContext("2d");
    if (!jctx) return;
    const colored = colorizeGray(lastJuliaGray, {
        colorHex: getSharedColorHex(),
        glow: getJuliaGlowValue(),
        fillInterior,
        relativeContrast,
    });
    const img = new ImageData(colored, lastJuliaFbW, lastJuliaFbH);
    // Reuse a single temp canvas (avoid per-input allocations).
    if (!recolorJuliaFromLastGray._tmp) {
        recolorJuliaFromLastGray._tmp = document.createElement("canvas");
    }
    const tmp = recolorJuliaFromLastGray._tmp;
    tmp.width = lastJuliaFbW;
    tmp.height = lastJuliaFbH;
    const tctx = tmp.getContext("2d");
    tctx.putImageData(img, 0, 0);
    const outW = juliaCanvas.width;
    const outH = juliaCanvas.height;
    jctx.clearRect(0, 0, outW, outH);
    jctx.drawImage(tmp, 0, 0, lastJuliaFbW, lastJuliaFbH, 0, 0, outW, outH);
}
// ------------------ bake zoom/pan into base + reset view ------------------
function bakeTransformIntoBase() {
    if (!baseValid) return;
    if (viewScale === 1 && viewOffsetX === 0 && viewOffsetY === 0) return;
    const tmp = document.createElement("canvas");
    tmp.width = baseCanvas.width;
    tmp.height = baseCanvas.height;
    const tctx = tmp.getContext("2d");
    tctx.setTransform(viewScale, 0, 0, viewScale, viewOffsetX * canvasDpr, viewOffsetY * canvasDpr);
    tctx.drawImage(baseCanvas, 0, 0);
    baseCtx.setTransform(1, 0, 0, 1, 0, 0);
    baseCtx.clearRect(0, 0, baseCanvas.width, baseCanvas.height);
    baseCtx.drawImage(tmp, 0, 0);
    baseValid = true;
}
function commitVisualAndReset() {
    const view = getCurrentView();
    bakeTransformIntoBase();
    centerX = view.cx;
    centerY = view.cy;
    zoom = view.zoom;
    viewScale = 1;
    viewOffsetX = 0;
    viewOffsetY = 0;
    setZoomStatus();
    redrawFromBase();
}
// shared helper from original file
function hexToRgb(hex) {
    let h = hex.replace("#", "");
    if (h.length === 3) {
        h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    }
    const num = parseInt(h, 16);
    return {
        r: (num >> 16) & 255,
        g: (num >> 8) & 255,
        b: num & 255,
    };
}