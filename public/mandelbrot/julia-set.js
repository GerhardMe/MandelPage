"use strict";

// ------------------ Julia cursor state (world-anchored) ------------------

let juliaCursorWorldX = null;
let juliaCursorWorldY = null;
let juliaCursorDragging = false;

const JULIA_CURSOR_START_RE = -0.5125324324513248126471961823490;
const JULIA_CURSOR_START_IM = -0.5213923730185231986589371987689;
const HAS_JULIA_START =
    Number.isFinite(JULIA_CURSOR_START_RE) &&
    Number.isFinite(JULIA_CURSOR_START_IM);

// ------------------ Julia view: world-rect for zoom/pan ------------------

// World rectangle currently shown in the Julia canvas
let juliaWorldXMin = -1.2;
let juliaWorldXMax = 1.2;
let juliaWorldYMin = -1.2;
let juliaWorldYMax = 1.2;

// Screen-space transform used only for responsive pan/zoom of last image.
// This does NOT change the world rect until we "commit" after interaction.
let juliaScreenScale = 1;
let juliaScreenOffsetX = 0;
let juliaScreenOffsetY = 0;

let juliaPanning = false;
let juliaPanLastX = 0;
let juliaPanLastY = 0;
let juliaPanZoomInitialized = false;

// Interaction state: keep UI responsive while dragging/zooming
let juliaInteractionActive = false;
let juliaInteractionTimeout = null;
const JULIA_INTERACTION_SETTLE_MS = 70; // after last input, commit + rerender

// Offscreen buffer for Julia image
let lastJuliaOffscreen = null;

// ------------------ Julia canvas size / aspect tracking ------------------

let lastJuliaCanvasW = 0;
let lastJuliaCanvasH = 0;

// ------------------ worker state: Julia GPU ------------------

let juliaWorker = null;
let juliaWorkerReady = false;
let juliaNextJobId = 1;
let juliaCurrentJobId = null;

// multi-stage preview (low-res first, then full-res, then supersample)
const JULIA_STAGES = [2, 1, 0.25];
// stage index is ALWAYS in [0 .. JULIA_STAGES.length - 1] when a job is active
let juliaStageIndex = 0;

// single in-flight job + at most one pending job
let juliaJobInFlight = false;
let juliaPendingRequest = null;   // latest requested params while a job is running
let juliaActiveParams = null;     // params for the currently running job

// Render scheduling throttle: avoid starting a job on every tiny move
let juliaRenderScheduled = false;

// ------------------ status UI state ------------------

const juliaStatusEl = document.getElementById("juliaStatus");
let juliaLastBackend = null;      // "gpu" | "cpu" | null
let juliaLastGrayscale = null;    // "absolute" | "relative" | null

function updateJuliaStatus() {
    if (!juliaStatusEl) return;

    const parts = [];

    const state = juliaJobInFlight ? "working" : "idle";
    parts.push(`Julia: ${state}`);

    const backend = juliaLastBackend || "unknown";
    parts.push(`backend: ${backend}`);

    if (juliaJobInFlight && juliaCurrentJobId !== null) {
        const idx = Math.max(
            0,
            Math.min(juliaStageIndex, JULIA_STAGES.length - 1),
        );
        parts.push(`stage ${idx + 1}/${JULIA_STAGES.length}`);
    } else {
        parts.push("stage -/-");
    }

    juliaStatusEl.textContent = parts.join(" | ");
}


// Cancel current Julia job locally (worker keeps running, but results are ignored)
function cancelJuliaJob() {
    juliaJobInFlight = false;
    juliaActiveParams = null;
    juliaCurrentJobId = null;
    juliaStageIndex = 0; // keep a valid index, never -1
    updateJuliaStatus();
}

// ------------------ Julia world-rect helpers ------------------

// Assumes these globals exist somewhere in your full file:
//   const juliaCanvas = document.getElementById("juliaCanvas");
//   const canvas, fc, bw, fillInside, juliaCursorEl, juliaBox
//   worldToScreen, screenToWorld, hexToRgb, colorizeGray,
//   getJuliaGlowValue,
//   setJuliaCursorStatus, updateJuliaFromCursor, setErrorStatus, etc.

function syncJuliaCanvasSizeAndWorld() {
    if (!juliaCanvas) return;

    const rect = juliaCanvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    const dpr = window.devicePixelRatio || 1;
    const newW = Math.max(1, Math.round(rect.width * dpr));
    const newH = Math.max(1, Math.round(rect.height * dpr));

    // No change -> nothing to do
    if (newW === lastJuliaCanvasW && newH === lastJuliaCanvasH) {
        return;
    }

    lastJuliaCanvasW = newW;
    lastJuliaCanvasH = newH;

    // Set the real backing resolution so 1 Julia pixel == 1 canvas pixel
    juliaCanvas.width = newW;
    juliaCanvas.height = newH;

    // --- keep vertical span, adjust horizontal span to match new aspect ---

    const newAspect = newW / newH;

    const currentSpanY = (juliaWorldYMax - juliaWorldYMin) || 3.0;
    const centerX = 0.5 * (juliaWorldXMin + juliaWorldXMax) || 0;
    const centerY = 0.5 * (juliaWorldYMin + juliaWorldYMax) || 0;

    const newSpanX = currentSpanY * newAspect;

    juliaWorldXMin = centerX - newSpanX / 2;
    juliaWorldXMax = centerX + newSpanX / 2;
    juliaWorldYMin = centerY - currentSpanY / 2;
    juliaWorldYMax = centerY + currentSpanY / 2;

    // Reset screen-space pan/zoom; world-rect now encodes the view
    juliaScreenScale = 1;
    juliaScreenOffsetX = 0;
    juliaScreenOffsetY = 0;

    // Drop any old offscreen buffer that had the wrong aspect/size
    lastJuliaOffscreen = null;
    lastJuliaFbW = 0;
    lastJuliaFbH = 0;

    // Force a fresh multi-stage render at the new resolution / aspect
    requestJuliaRender();
}

function initJuliaViewRect() {
    // Initial world rect is already set to a 3.0 vertical span.
    // This call snaps the horizontal span to the canvas aspect,
    // sets DPR-aware width/height, and triggers an initial render.
    syncJuliaCanvasSizeAndWorld();
}

// map canvas pixel -> Julia-world using current world rect (no screen transform)
function canvasToJuliaWorld(cx, cy) {
    if (!juliaCanvas) {
        return { x: 0, y: 0 };
    }
    const w = juliaCanvas.width || 1;
    const h = juliaCanvas.height || 1;

    const tx = cx / w; // 0..1
    const ty = cy / h; // 0..1

    const spanX = juliaWorldXMax - juliaWorldXMin;
    const spanY = juliaWorldYMax - juliaWorldYMin;

    const x = juliaWorldXMin + tx * spanX;
    const y = juliaWorldYMin + ty * spanY;

    return { x, y };
}

// expose current view rect for worker params
function getJuliaViewRect() {
    return {
        xMin: juliaWorldXMin,
        xMax: juliaWorldXMax,
        yMin: juliaWorldYMin,
        yMax: juliaWorldYMax,
    };
}

// ------------------ helpers for Julia worker params ------------------

function buildJuliaParams() {
    if (!juliaCanvas) return null;
    if (juliaCursorWorldX == null || juliaCursorWorldY == null) return null;

    const outW = juliaCanvas.width | 0;
    const outH = juliaCanvas.height | 0;
    if (!outW || !outH) return null;

    const raw = juliaGlow ? (parseInt(juliaGlow.value, 10) || 0) : 0;
    const fillSnap = fillInside && fillInside.checked ? 1 : 0;
    const colorHex = fc && fc.value ? fc.value : "#00ffff";
    const color = hexToRgb(colorHex);

    const vr = getJuliaViewRect();

    const relativeGray = !!(relativeJulia && relativeJulia.checked);

    // iterations
    let maxIter = 500;
    if (juliaIterations) {
        const n = parseInt(juliaIterations.value, 10);
        if (Number.isFinite(n)) maxIter = n;
    }
    maxIter = Math.max(1, Math.min(1000000, maxIter));

    return {
        outW,
        outH,
        cRe: juliaCursorWorldX,
        cIm: juliaCursorWorldY,
        color,
        raw,
        fillInterior: fillSnap,

        viewXMin: vr.xMin,
        viewXMax: vr.xMax,
        viewYMin: vr.yMin,
        viewYMax: vr.yMax,

        relativeGray,
        maxIter,
    };
}

// ------------------ Julia cursor helpers ------------------

function updateJuliaCursorScreenPosition() {
    if (
        !juliaCursorEl ||
        juliaCursorWorldX == null ||
        juliaCursorWorldY == null
    ) {
        return;
    }

    // if Julia box is minimized/hidden, don't bother
    if (juliaBox && juliaBox.classList.contains("minimized")) return;
    if (juliaBox && juliaBox.style.display === "none") return;

    const { sx, sy } = worldToScreen(juliaCursorWorldX, juliaCursorWorldY);
    juliaCursorEl.style.display = "block";
    juliaCursorEl.style.transform =
        `translate(${sx}px, ${sy}px) translate(-50%, -50%)`;
}

function setJuliaCursorFromClient(clientX, clientY) {
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    let sx = clientX - rect.left;
    let sy = clientY - rect.top;

    if (juliaCursorEl) {
        const w = juliaCursorEl.offsetWidth || 0;
        const h = juliaCursorEl.offsetHeight || 0;
        const dx = (0.7 - 0.5) * w;
        const dy = (0.7 - 0.5) * h;
        sx -= dx;
        sy -= dy;
    }

    const world = screenToWorld(sx, sy);
    juliaCursorWorldX = world.cx;
    juliaCursorWorldY = world.cy;
    updateJuliaCursorScreenPosition();
    updateJuliaFromCursor();
}

function setupJuliaCursorDrag() {
    if (!juliaCursorEl) return;

    juliaCursorEl.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        juliaCursorDragging = true;
        juliaCursorEl.setPointerCapture(e.pointerId);
        setJuliaCursorFromClient(e.clientX, e.clientY);
    });

    function endDrag(e) {
        if (!juliaCursorDragging) return;
        juliaCursorDragging = false;
        try {
            juliaCursorEl.releasePointerCapture(e.pointerId);
        } catch (_) { /* ignore */ }
    }

    window.addEventListener("pointermove", (e) => {
        if (!juliaCursorDragging) return;
        setJuliaCursorFromClient(e.clientX, e.clientY);
    });

    juliaCursorEl.addEventListener("pointerup", endDrag);
    juliaCursorEl.addEventListener("pointercancel", endDrag);
}

// ------------------ interaction timing ------------------

function touchJuliaInteraction() {
    juliaInteractionActive = true;
    if (juliaInteractionTimeout !== null) {
        clearTimeout(juliaInteractionTimeout);
    }
    juliaInteractionTimeout = setTimeout(() => {
        juliaInteractionActive = false;
        juliaInteractionTimeout = null;

        // Kill any old job for the previous view
        cancelJuliaJob();

        // Pan/zoom during interaction only manipulates screen transform.
        // When interaction settles, bake transform into world rect,
        // reset screen transform, and trigger a staged re-render.
        commitJuliaScreenTransformToWorld();
        requestJuliaRender();
    }, JULIA_INTERACTION_SETTLE_MS);
}

// Commit current screen transform (scale+offset) into the world-rect.
// Simplified and independent of framebuffer resolution, so it cooperates
// with both coarse and supersampled stages.
function commitJuliaScreenTransformToWorld() {
    if (!juliaCanvas) return;

    const canvasW = juliaCanvas.width || 1;
    const canvasH = juliaCanvas.height || 1;

    const spanX = juliaWorldXMax - juliaWorldXMin;
    const spanY = juliaWorldYMax - juliaWorldYMin;

    const s = juliaScreenScale || 1;

    // Screen (0,0) -> world
    const x0 = juliaWorldXMin +
        ((0 - juliaScreenOffsetX) / (s * canvasW)) * spanX;
    const y0 = juliaWorldYMin +
        ((0 - juliaScreenOffsetY) / (s * canvasH)) * spanY;

    // Screen (canvasW, canvasH) -> world
    const x1 = juliaWorldXMin +
        ((canvasW - juliaScreenOffsetX) / (s * canvasW)) * spanX;
    const y1 = juliaWorldYMin +
        ((canvasH - juliaScreenOffsetY) / (s * canvasH)) * spanY;

    juliaWorldXMin = x0;
    juliaWorldXMax = x1;
    juliaWorldYMin = y0;
    juliaWorldYMax = y1;

    // Reset screen transform; new render will be 1:1 for the new world rect
    juliaScreenScale = 1;
    juliaScreenOffsetX = 0;
    juliaScreenOffsetY = 0;
}

// ------------------ Julia pan/zoom: screen-transform only ------------------

function drawJuliaView() {
    if (!juliaCanvas) return;
    const jctx = juliaCanvas.getContext("2d");
    if (!jctx) return;
    if (!lastJuliaOffscreen) return;

    const outW = juliaCanvas.width;
    const outH = juliaCanvas.height;

    const baseW = lastJuliaFbW || lastJuliaOffscreen.width || 1;
    const baseH = lastJuliaFbH || lastJuliaOffscreen.height || 1;

    jctx.save();
    jctx.setTransform(1, 0, 0, 1, 0, 0);
    jctx.clearRect(0, 0, outW, outH);

    // Coarse stages should look blocky, not blurred.
    jctx.imageSmoothingEnabled = false;

    // Scale the offscreen buffer so it always covers the full canvas.
    const scaleToCanvasX = outW / baseW;
    const scaleToCanvasY = outH / baseH;

    jctx.setTransform(
        juliaScreenScale * scaleToCanvasX,
        0,
        0,
        juliaScreenScale * scaleToCanvasY,
        juliaScreenOffsetX,
        juliaScreenOffsetY
    );

    // Draw the whole offscreen buffer at its native coordinate space (0..baseW, 0..baseH)
    jctx.drawImage(
        lastJuliaOffscreen,
        0,
        0,
        baseW,
        baseH
    );

    jctx.restore();
}

// Only modify screen transform; do NOT touch world rect here.
function zoomJuliaAt(canvasX, canvasY, zoomFactor) {
    if (!juliaCanvas) return;
    if (!lastJuliaOffscreen) return;

    const prevScale = juliaScreenScale;
    let newScale = prevScale * zoomFactor;

    // Wide bounds to avoid NaNs but allow effectively arbitrary deep zoom.
    const MIN_SCALE = 1e-6;
    const MAX_SCALE = 1e6;
    newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, newScale));

    // Keep the zoom anchor under the cursor.
    juliaScreenOffsetX =
        canvasX - (canvasX - juliaScreenOffsetX) * (newScale / prevScale);
    juliaScreenOffsetY =
        canvasY - (canvasY - juliaScreenOffsetY) * (newScale / prevScale);

    juliaScreenScale = newScale;

    touchJuliaInteraction();
    drawJuliaView();
}

// Only modify screen transform; do NOT touch world rect here.
function panJuliaByPixels(dx, dy) {
    if (!lastJuliaOffscreen) return;

    juliaScreenOffsetX += dx;
    juliaScreenOffsetY += dy;

    touchJuliaInteraction();
    drawJuliaView();
}

function setupJuliaPanZoom() {
    if (!juliaCanvas || juliaPanZoomInitialized) return;
    juliaPanZoomInitialized = true;

    // Sync to current panel size before adding input handlers
    syncJuliaCanvasSizeAndWorld();

    juliaCanvas.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        juliaPanning = true;
        juliaPanLastX = e.clientX;
        juliaPanLastY = e.clientY;
        juliaCanvas.setPointerCapture(e.pointerId);
        touchJuliaInteraction();
    });

    function endPan(e) {
        if (!juliaPanning) return;
        juliaPanning = false;
        try {
            juliaCanvas.releasePointerCapture(e.pointerId);
        } catch (_) { /* ignore */ }
        touchJuliaInteraction(); // settle timer handles commit+rerender
    }

    juliaCanvas.addEventListener("pointermove", (e) => {
        if (!juliaPanning) return;
        const dx = e.clientX - juliaPanLastX;
        const dy = e.clientY - juliaPanLastY;
        juliaPanLastX = e.clientX;
        juliaPanLastY = e.clientY;

        panJuliaByPixels(dx, dy);
    });

    juliaCanvas.addEventListener("pointerup", endPan);
    juliaCanvas.addEventListener("pointercancel", endPan);

    juliaCanvas.addEventListener(
        "wheel",
        (e) => {
            e.preventDefault();
            if (!lastJuliaOffscreen) return;

            const rect = juliaCanvas.getBoundingClientRect();
            const cx = e.clientX - rect.left;
            const cy = e.clientY - rect.top;

            const delta = -e.deltaY;
            const zoomFactor = Math.exp(delta * 0.001);

            zoomJuliaAt(cx, cy, zoomFactor);
        },
        { passive: false },
    );
}

// ---- Julia GPU worker integration ----

function requestJuliaRender() {
    if (!juliaWorkerReady) return;

    const params = buildJuliaParams();
    if (!params) return;

    // Overwrite any previous pending request with the latest view
    juliaPendingRequest = params;

    // Throttle job start to next animation frame
    if (!juliaRenderScheduled) {
        juliaRenderScheduled = true;
        requestAnimationFrame(() => {
            juliaRenderScheduled = false;
            if (!juliaJobInFlight) {
                startJuliaJobFromPending();
            }
        });
    }
}

function startJuliaJobFromPending() {
    if (!juliaWorkerReady) return;
    if (!juliaPendingRequest) return;
    if (!juliaCanvas) return;

    const params = juliaPendingRequest;
    juliaPendingRequest = null;

    const jobId = juliaNextJobId++;
    juliaCurrentJobId = jobId;
    juliaStageIndex = 0;        // always start at stage 0
    juliaJobInFlight = true;
    juliaActiveParams = params;

    updateJuliaStatus();
    sendJuliaStage(jobId, params);
}

function sendJuliaStage(jobId, params) {
    if (!juliaWorkerReady) return;
    if (!juliaCanvas) return;
    if (!params) return;

    const stageIdx = juliaStageIndex;
    if (stageIdx < 0 || stageIdx >= JULIA_STAGES.length) return;

    const scale = JULIA_STAGES[stageIdx];

    const effectiveScale = Math.max(1, scale);
    const fbW = Math.max(1, Math.floor(params.outW / effectiveScale));
    const fbH = Math.max(1, Math.floor(params.outH / effectiveScale));

    juliaWorker.postMessage({
        type: "render",
        jobId,
        fbW,
        fbH,
        cRe: params.cRe,
        cIm: params.cIm,
        color: params.color,
        raw: params.raw,
        fillInterior: params.fillInterior,
        scale,
        viewXMin: params.viewXMin,
        viewXMax: params.viewXMax,
        viewYMin: params.viewYMin,
        viewYMax: params.viewYMax,

        relativeGray: !!params.relativeGray,
        maxIter: params.maxIter | 0,
    });
}

function handleJuliaFrame(msg) {
    const { jobId, fbW, fbH, gray } = msg;
    if (juliaCurrentJobId === null || jobId !== juliaCurrentJobId) return;
    if (!juliaCanvas) return;

    const jctx = juliaCanvas.getContext("2d");
    if (!jctx) return;

    const stageW = fbW | 0;
    const stageH = fbH | 0;
    if (!stageW || !stageH) return;

    const grayArr = new Uint8Array(gray);

    // Shared color, per-fractal glow.
    const colored = colorizeGray(grayArr, {
        colorHex: (typeof fc !== "undefined" && fc) ? fc.value : "#ffffff",
        glow: getJuliaGlowValue(),
        fillInterior,
    });
    const img = new ImageData(colored, stageW, stageH);

    if (
        !lastJuliaOffscreen ||
        lastJuliaOffscreen.width !== stageW ||
        lastJuliaOffscreen.height !== stageH
    ) {
        lastJuliaOffscreen = document.createElement("canvas");
        lastJuliaOffscreen.width = stageW;
        lastJuliaOffscreen.height = stageH;
    }

    const tctx = lastJuliaOffscreen.getContext("2d");
    tctx.putImageData(img, 0, 0);

    lastJuliaGray = grayArr;
    lastJuliaFbW = stageW;
    lastJuliaFbH = stageH;

    drawJuliaView();

    const havePending = !!juliaPendingRequest;

    // During interaction, just show the first coarse stage for responsiveness.
    // Otherwise, run through all stages up to the last one.
    const lastStageIndex = juliaInteractionActive
        ? 0
        : (JULIA_STAGES.length - 1);

    // If a newer request exists, abandon this job and start the latest one.
    if (havePending) {
        juliaJobInFlight = false;
        juliaActiveParams = null;
        updateJuliaStatus();
        // stageIndex will be reset to 0 when the new job starts
        startJuliaJobFromPending();
        return;
    }

    // No pending request -> either advance stage or finish job
    if (juliaStageIndex < lastStageIndex) {
        juliaStageIndex++;
        updateJuliaStatus();
        sendJuliaStage(jobId, juliaActiveParams);
    } else {
        // Finished final stage for this view
        juliaJobInFlight = false;
        juliaActiveParams = null;
        updateJuliaStatus();
        if (juliaPendingRequest) {
            startJuliaJobFromPending();
        }
    }
}

function initJuliaWorker() {
    if (!juliaCanvas) return;

    syncJuliaCanvasSizeAndWorld();

    if (window.ResizeObserver) {
        const ro = new ResizeObserver(() => {
            syncJuliaCanvasSizeAndWorld();
        });
        ro.observe(juliaCanvas);
    }

    setupJuliaPanZoom();

    const desiredUrl = "/mandelbrot/julia-worker.js";

    // (Re)create worker if needed
    if (juliaWorker) {
        // keep existing worker instance
    } else {
        juliaWorker = new Worker(desiredUrl);

        juliaWorkerReady = false;
        juliaJobInFlight = false;
        juliaPendingRequest = null;
        juliaActiveParams = null;
        juliaStageIndex = 0;
        juliaCurrentJobId = null;
        juliaLastBackend = null;
        juliaLastGrayscale = null;
        updateJuliaStatus();

        juliaWorker.onmessage = (e) => {
            const msg = e.data;
            switch (msg.type) {
                case "ready":
                    juliaWorkerReady = true;
                    updateJuliaStatus();
                    requestJuliaRender();
                    break;

                case "status":
                    if (typeof msg.backend === "string") juliaLastBackend = msg.backend;
                    if (typeof msg.grayscale === "string") juliaLastGrayscale = msg.grayscale;
                    updateJuliaStatus();
                    break;

                case "frame":
                    handleJuliaFrame(msg);
                    break;

                case "error":
                    console.error("Julia worker error:", msg.message || msg);
                    setErrorStatus && setErrorStatus("Julia worker error");
                    juliaWorkerReady = false;
                    juliaJobInFlight = false;
                    juliaPendingRequest = null;
                    juliaActiveParams = null;
                    juliaCurrentJobId = null;
                    updateJuliaStatus();
                    break;
            }
        };

        juliaWorker.onerror = (err) => {
            console.error("Julia worker onerror:", err);
            setErrorStatus && setErrorStatus("Julia worker error");
            juliaWorkerReady = false;
            juliaJobInFlight = false;
            juliaPendingRequest = null;
            juliaActiveParams = null;
            juliaCurrentJobId = null;
            updateJuliaStatus();
        };
    }
}

function updateJuliaFromCursor() {
    if (juliaCursorWorldX == null || juliaCursorWorldY == null) return;
    if (!juliaCanvas) return;

    setJuliaCursorStatus(juliaCursorWorldX, juliaCursorWorldY);

    // For cursor movement we still trigger a render;
    // pan/zoom responsiveness is handled purely in screen space now.
    requestJuliaRender();
}
