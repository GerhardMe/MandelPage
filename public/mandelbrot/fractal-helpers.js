"use strict";

// ------------------ world / framebuffer ------------------

let centerX = -0.75;
let centerY = 0.0;
let zoom = 1.0;

let fillInterior = fillInside && fillInside.checked ? 1 : 0;

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
    const newW = Math.max(1, Math.floor(rect.width));
    const newH = Math.max(1, Math.floor(rect.height));

    canvas.width = newW;
    canvas.height = newH;

    fullW = newW;
    fullH = newH;

    baseCanvas.width = fullW;
    baseCanvas.height = fullH;
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

// ------------------ drawing helpers ------------------

function colorizeGray(gray) {
    const N = gray.length;
    const out = new Uint8ClampedArray(N * 4);

    const color = hexToRgb(fc.value);
    const rawFull = parseInt(bw.value, 10) || 0;
    const raw = Math.max(0, Math.min(100, rawFull)); // 0..100

    const isLowBlur = raw <= 50;
    const isHighBlur = raw > 50;

    let lowExp = null;
    let lowToLinear = 0;
    if (isLowBlur) {
        const clamped = raw;
        const tOrig = clamped / 100;
        const minExp = 0.25;
        const maxExp = 3.0;
        lowExp = minExp + (1 - tOrig) * (maxExp - minExp);
        lowToLinear = clamped / 50;
    }

    let bandWidth = null;
    let highToLinear = 0;
    if (isHighBlur) {
        const u = (raw - 50) / 50;
        bandWidth = 1 - 0.8 * u;
        highToLinear = (100 - raw) / 50;
    }

    let o = 0;
    for (let i = 0; i < N; i++) {
        const v = gray[i] | 0;
        const gNorm = v / 255;
        let r, g, b;

        if (gNorm <= 0) {
            r = g = b = 0;
        } else {
            let wVal;
            const isFilledInterior = fillInterior && v === 255;

            if (isFilledInterior) {
                wVal = 1;
            } else if (isLowBlur) {
                let base = Math.pow(gNorm, lowExp);
                if (base < 0) base = 0;
                if (base > 1) base = 1;
                wVal = base * (1 - lowToLinear) + gNorm * lowToLinear;
            } else {
                let burn = gNorm >= bandWidth ? 1 : gNorm / bandWidth;
                wVal = burn * (1 - highToLinear) + gNorm * highToLinear;
            }

            r = color.r * wVal;
            g = color.g * wVal;
            b = color.b * wVal;
        }

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
    ctx.clearRect(0, 0, fullW, fullH);
    ctx.setTransform(viewScale, 0, 0, viewScale, viewOffsetX, viewOffsetY);
    ctx.drawImage(baseCanvas, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function redrawFullColored(gray, fbW, fbH) {
    const colored = colorizeGray(gray);

    bufCanvas.width = fbW;
    bufCanvas.height = fbH;
    const img = new ImageData(colored, fbW, fbH);
    bufCtx.putImageData(img, 0, 0);

    baseCtx.setTransform(1, 0, 0, 1, 0, 0);
    baseCtx.clearRect(0, 0, fullW, fullH);
    baseCtx.drawImage(bufCanvas, 0, 0, fbW, fbH, 0, 0, fullW, fullH);
    baseValid = true;
}

function recolorFromLastGray() {
    if (!lastGray || lastFbW <= 0 || lastFbH <= 0) return;
    redrawFullColored(lastGray, lastFbW, lastFbH);
    redrawFromBase();
}

// Julia recolor using same colorizeGray
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

    const colored = colorizeGray(lastJuliaGray);
    const img = new ImageData(colored, lastJuliaFbW, lastJuliaFbH);

    const tmp = document.createElement("canvas");
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
    tmp.width = fullW;
    tmp.height = fullH;
    const tctx = tmp.getContext("2d");

    tctx.setTransform(viewScale, 0, 0, viewScale, viewOffsetX, viewOffsetY);
    tctx.drawImage(baseCanvas, 0, 0);

    baseCtx.setTransform(1, 0, 0, 1, 0, 0);
    baseCtx.clearRect(0, 0, fullW, fullH);
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
