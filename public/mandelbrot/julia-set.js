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

// ------------------ Julia view pan/zoom state ------------------

let juliaViewZoom = 1;          // 1 = fit canvas
let juliaViewOffsetX = 0;       // pan offset in canvas pixels
let juliaViewOffsetY = 0;
let juliaPanning = false;
let juliaPanLastX = 0;
let juliaPanLastY = 0;
let juliaPanZoomInitialized = false;

// offscreen buffer for Julia image (so we can pan/zoom without re-rendering)
let lastJuliaOffscreen = null;

// ------------------ worker state: Julia GPU ------------------

let juliaWorker = null;
let juliaWorkerReady = false;
let juliaNextJobId = 1;
let juliaCurrentJobId = null;

// multi-stage preview (low-res first, then full-res)
const JULIA_STAGES = [4, 1, 0.25]; // scale factors: 4x coarse, then full-res
let juliaStageIndex = -1;

// single in-flight job + at most one pending job
let juliaJobInFlight = false;
let juliaPendingRequest = null;   // latest requested params while a job is running
let juliaActiveParams = null;     // params for the currently running job

// ------------------ helpers for Julia ------------------

function buildJuliaParams() {
    if (!juliaCanvas) return null;
    if (juliaCursorWorldX == null || juliaCursorWorldY == null) return null;

    const outW = juliaCanvas.width | 0;
    const outH = juliaCanvas.height | 0;
    if (!outW || !outH) return null;

    const raw = bw ? (parseInt(bw.value, 10) || 0) : 0;
    const fillSnap = fillInside && fillInside.checked ? 1 : 0;
    const colorHex = fc && fc.value ? fc.value : "#00ffff";
    const color = hexToRgb(colorHex);

    return {
        outW,
        outH,
        cRe: juliaCursorWorldX,
        cIm: juliaCursorWorldY,
        color,          // now ignored by worker, but kept for compatibility
        raw,            // now ignored by worker
        fillInterior: fillSnap, // now ignored by worker
    };
}

// ------------------ Julia cursor helpers ------------------

function updateJuliaCursorScreenPosition() {
    if (
        !juliaCursorEl ||
        juliaCursorWorldX == null ||
        juliaCursorWorldY == null
    )
        return;

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
        } catch (_) { }
    }

    window.addEventListener("pointermove", (e) => {
        if (!juliaCursorDragging) return;
        setJuliaCursorFromClient(e.clientX, e.clientY);
    });

    juliaCursorEl.addEventListener("pointerup", endDrag);
    juliaCursorEl.addEventListener("pointercancel", endDrag);
}

// ------------------ Julia pan/zoom helpers ------------------

function drawJuliaView() {
    if (!juliaCanvas) return;
    const jctx = juliaCanvas.getContext("2d");
    if (!jctx) return;
    if (!lastJuliaOffscreen) return;

    const outW = juliaCanvas.width;
    const outH = juliaCanvas.height;

    jctx.save();
    jctx.setTransform(1, 0, 0, 1, 0, 0);
    jctx.clearRect(0, 0, outW, outH);

    const z = juliaViewZoom;
    const destW = outW * z;
    const destH = outH * z;
    const destX = (outW - destW) / 2 + juliaViewOffsetX;
    const destY = (outH - destH) / 2 + juliaViewOffsetY;

    jctx.drawImage(
        lastJuliaOffscreen,
        0,
        0,
        lastJuliaFbW,
        lastJuliaFbH,
        destX,
        destY,
        destW,
        destH,
    );

    jctx.restore();
}

function zoomJuliaAt(canvasX, canvasY, zoomFactor) {
    if (!juliaCanvas) return;
    if (!lastJuliaOffscreen) return;

    const outW = juliaCanvas.width;
    const outH = juliaCanvas.height;

    const z = juliaViewZoom;

    // clamp zoom range
    let newZ = z * zoomFactor;
    newZ = Math.max(0.25, Math.min(20, newZ));

    const destW = outW * z;
    const destH = outH * z;
    const destX = (outW - destW) / 2 + juliaViewOffsetX;
    const destY = (outH - destH) / 2 + juliaViewOffsetY;

    // image-space coordinates under cursor before zoom
    const uX = (canvasX - destX) / z;
    const uY = (canvasY - destY) / z;

    const newDestW = outW * newZ;
    const newDestH = outH * newZ;
    const newDestX = canvasX - uX * newZ;
    const newDestY = canvasY - uY * newZ;

    juliaViewZoom = newZ;
    juliaViewOffsetX = newDestX - (outW - newDestW) / 2;
    juliaViewOffsetY = newDestY - (outH - newDestH) / 2;

    drawJuliaView();
}

function setupJuliaPanZoom() {
    if (!juliaCanvas || juliaPanZoomInitialized) return;
    juliaPanZoomInitialized = true;

    juliaCanvas.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        juliaPanning = true;
        juliaPanLastX = e.clientX;
        juliaPanLastY = e.clientY;
        juliaCanvas.setPointerCapture(e.pointerId);
    });

    function endPan(e) {
        if (!juliaPanning) return;
        juliaPanning = false;
        try {
            juliaCanvas.releasePointerCapture(e.pointerId);
        } catch (_) { }
    }

    juliaCanvas.addEventListener("pointermove", (e) => {
        if (!juliaPanning) return;
        const dx = e.clientX - juliaPanLastX;
        const dy = e.clientY - juliaPanLastY;
        juliaPanLastX = e.clientX;
        juliaPanLastY = e.clientY;

        juliaViewOffsetX += dx;
        juliaViewOffsetY += dy;

        drawJuliaView();
    });

    juliaCanvas.addEventListener("pointerup", endPan);
    juliaCanvas.addEventListener("pointercancel", endPan);

    juliaCanvas.addEventListener(
        "wheel",
        (e) => {
            e.preventDefault();
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

    // Overwrite any previous pending request
    juliaPendingRequest = params;

    // If nothing is in flight, start immediately
    if (!juliaJobInFlight) {
        startJuliaJobFromPending();
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
    juliaStageIndex = 0;
    juliaJobInFlight = true;
    juliaActiveParams = params;

    sendJuliaStage(jobId, params);
}

function sendJuliaStage(jobId, params) {
    if (!juliaWorkerReady) return;
    if (!juliaCanvas) return;
    if (!params) return;
    if (juliaStageIndex < 0 || juliaStageIndex >= JULIA_STAGES.length) return;

    const scale = JULIA_STAGES[juliaStageIndex];

    const fbW = Math.max(1, Math.floor(params.outW / scale));
    const fbH = Math.max(1, Math.floor(params.outH / scale));

    juliaWorker.postMessage({
        type: "render",
        jobId,
        fbW,
        fbH,
        cRe: params.cRe,
        cIm: params.cIm,
        color: params.color,              // ignored by worker now
        raw: params.raw,                  // ignored
        fillInterior: params.fillInterior,// ignored
        scale,
    });
}

function handleJuliaFrame(msg) {
    const { jobId, fbW, fbH, gray, scale } = msg;
    if (juliaCurrentJobId === null || jobId !== juliaCurrentJobId) return;
    if (!juliaCanvas) return;

    const jctx = juliaCanvas.getContext("2d");
    if (!jctx) return;

    const stageW = fbW | 0;
    const stageH = fbH | 0;
    if (!stageW || !stageH) return;

    // incoming is grayscale; colorize with same function as Mandelbrot
    const grayArr = new Uint8Array(gray);
    const colored = colorizeGray(grayArr);
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

    // remember last Julia gray for recolor
    lastJuliaGray = grayArr;
    lastJuliaFbW = stageW;
    lastJuliaFbH = stageH;

    // draw with current pan/zoom
    drawJuliaView();

    const havePending = !!juliaPendingRequest;
    const lastStageIndex = JULIA_STAGES.length - 1;

    // If there is a newer request waiting, do NOT render finer stages for this job.
    if (havePending) {
        juliaJobInFlight = false;
        juliaStageIndex = -1;
        startJuliaJobFromPending();
        return;
    }

    // No pending request -> continue with stages or finish
    if (juliaStageIndex >= 0 && juliaStageIndex < lastStageIndex) {
        juliaStageIndex++;
        sendJuliaStage(jobId, juliaActiveParams);
    } else {
        juliaJobInFlight = false;
        juliaStageIndex = -1;
        juliaActiveParams = null;

        if (juliaPendingRequest) {
            startJuliaJobFromPending();
        }
    }
}

function initJuliaWorker() {
    if (!juliaCanvas) return;

    // set up pan/zoom once
    setupJuliaPanZoom();

    juliaWorker = new Worker("/mandelbrot/julia-worker.js");
    juliaWorkerReady = false;
    juliaJobInFlight = false;
    juliaPendingRequest = null;
    juliaActiveParams = null;
    juliaStageIndex = -1;
    juliaCurrentJobId = null;

    juliaWorker.onmessage = (e) => {
        const msg = e.data;
        switch (msg.type) {
            case "ready":
                juliaWorkerReady = true;
                // Kick off an initial render once ready
                requestJuliaRender();
                break;
            case "frame":
                handleJuliaFrame(msg);
                break;
            case "error":
                setErrorStatus(msg.message || "julia worker error");
                break;
        }
    };
    juliaWorker.onerror = (err) => {
        setErrorStatus(err.message || "julia worker error");
    };
    juliaWorker.onmessageerror = () => {
        setErrorStatus("julia worker message error");
    };
}

function updateJuliaFromCursor() {
    if (juliaCursorWorldX == null || juliaCursorWorldY == null) return;
    if (!juliaCanvas) return;

    setJuliaCursorStatus(juliaCursorWorldX, juliaCursorWorldY);

    // trigger Julia GPU worker render
    requestJuliaRender();
}
