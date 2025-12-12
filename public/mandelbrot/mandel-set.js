"use strict";

// ------------------ worker state: Mandelbrot ------------------

let worker = null;
let workerReady = false;
let nextJobId = 1;
let currentJobId = null;
let jobInFlight = false;

const STAGES = [{ scale: 4 }, { scale: 1 }, { scale: 0.25 }];
let currentStage = -1;
let stagePending = false;

// ------------------ interaction state ------------------

let interactionActive = false;
let lastInteractionTime = 0;
const INTERACTION_SETTLE_MS = 50;

function touchInteraction() {
    interactionActive = true;
    lastInteractionTime = performance.now();
}

// pan
let isPanning = false;
const activePointers = new Map();
let panStartX = 0;
let panStartY = 0;
let panStartOffsetX = 0;
let panStartOffsetY = 0;

// pinch-zoom
let isPinching = false;
let pinchStartDist = 0;
let pinchStartScale = 1;
let pinchAnchorScreenX = 0;
let pinchAnchorScreenY = 0;
let pinchAnchorWorldX = 0;
let pinchAnchorWorldY = 0;

// cursor (for status bar)
let cursorScreenX = null;
let cursorScreenY = null;

function markInteraction() {
    interactionActive = true;
    lastInteractionTime = performance.now();

    stagePending = false;
    currentStage = -1;

    if (workerReady && currentJobId != null) {
        worker.postMessage({ type: "cancel", jobId: currentJobId });
    }
    currentJobId = null;
    jobInFlight = false;
}

function requestFullRender() {
    if (!workerReady) return;
    currentStage = 0;
    stagePending = true;
    setErrorStatus("");
}

// ------------------ canvas pointer / touch ------------------

canvas.addEventListener("pointerdown", (e) => {
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    cursorScreenX = sx;
    cursorScreenY = sy;

    if (activePointers.size === 2) {
        isPinching = true;
        isPanning = false;

        const pts = Array.from(activePointers.values());
        const dx = pts[0].x - pts[1].x;
        const dy = pts[0].y - pts[1].y;
        pinchStartDist = Math.hypot(dx, dy) || 1;
        pinchStartScale = viewScale;

        const sxMid = (pts[0].x + pts[1].x) / 2 - rect.left;
        const syMid = (pts[0].y + pts[1].y) / 2 - rect.top;
        pinchAnchorScreenX = sxMid;
        pinchAnchorScreenY = syMid;

        const world = screenToWorld(sxMid, syMid);
        pinchAnchorWorldX = world.cx;
        pinchAnchorWorldY = world.cy;

        markInteraction();
        return;
    }

    if (!isPinching && activePointers.size === 1) {
        isPanning = true;
        canvas.setPointerCapture(e.pointerId);
        panStartX = e.clientX;
        panStartY = e.clientY;
        panStartOffsetX = viewOffsetX;
        panStartOffsetY = viewOffsetY;
        markInteraction();
    }
});

canvas.addEventListener("pointermove", (e) => {
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    cursorScreenX = sx;
    cursorScreenY = sy;

    if (!activePointers.has(e.pointerId)) return;
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (isPinching && activePointers.size === 2) {
        const pts = Array.from(activePointers.values());
        const dx = pts[0].x - pts[1].x;
        const dy = pts[0].y - pts[1].y;
        const dist = Math.hypot(dx, dy) || 1;
        const zoomFactor = dist / pinchStartDist;

        viewScale = pinchStartScale * zoomFactor;

        lockWorldPointToScreen(
            pinchAnchorWorldX,
            pinchAnchorWorldY,
            pinchAnchorScreenX,
            pinchAnchorScreenY,
        );

        setZoomStatus();
        redrawFromBase();
        touchInteraction();
        return;
    }

    if (!isPanning || isPinching) return;

    const dx = e.clientX - panStartX;
    const dy = e.clientY - panStartY;

    viewOffsetX = panStartOffsetX + dx;
    viewOffsetY = panStartOffsetY + dy;

    redrawFromBase();
    touchInteraction();
});

canvas.addEventListener("pointerleave", () => {
    cursorScreenX = null;
    cursorScreenY = null;
});

function endPan(e) {
    if (activePointers.has(e.pointerId)) {
        activePointers.delete(e.pointerId);
    }

    if (isPinching && activePointers.size < 2) {
        isPinching = false;
    }

    if (!isPanning) {
        touchInteraction();
        return;
    }

    isPanning = false;
    try {
        canvas.releasePointerCapture(e.pointerId);
    } catch (_) { }
    touchInteraction();
}

canvas.addEventListener("pointerup", endPan);
canvas.addEventListener("pointercancel", endPan);

function handleWheel(e) {
    e.preventDefault();

    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    cursorScreenX = sx;
    cursorScreenY = sy;

    const worldBefore = screenToWorld(sx, sy);

    const zoomFactor = Math.exp(-e.deltaY * 0.001);
    viewScale = (viewScale || 1) * zoomFactor;

    lockWorldPointToScreen(worldBefore.cx, worldBefore.cy, sx, sy);

    setZoomStatus();
    redrawFromBase();
    markInteraction();
}

canvas.addEventListener("wheel", handleWheel, { passive: false });
if (juliaCursorEl) {
    juliaCursorEl.addEventListener("wheel", handleWheel, { passive: false });
}

// ------------------ worker: Mandelbrot ------------------

function startWorkerJob(stageIndex) {
    if (!workerReady) return;
    const stage = STAGES[stageIndex];
    const scale = stage.scale;

    const fbW = fullW;
    const fbH = fullH;
    if (!fbW || !fbH) return;

    const jobId = nextJobId++;
    currentJobId = jobId;
    jobInFlight = true;

    const view = getCurrentView();
    const fillSnap = fillInterior | 0;

    worker.postMessage({
        type: "render",
        jobId,
        fbW,
        fbH,
        cx: view.cx,
        cy: view.cy,
        zoom: view.zoom,
        scale,
        fillInterior: fillSnap,
    });

    setRenderStatus(
        `render: stage ${stageIndex + 1}/${STAGES.length} scale=${scale}`,
    );
}

function handleWorkerScan(msg) {
    const { jobId, fbW, fbH, yStart, yEnd } = msg;
    if (currentJobId === null || jobId !== currentJobId) return;

    if (currentStage !== STAGES.length - 1) return;

    const numRows = yEnd - yStart;
    if (numRows <= 0) return;

    const destY = (yStart / fbH) * fullH;
    const destH = (numRows / fbH) * fullH;

    baseCtx.setTransform(1, 0, 0, 1, 0, 0);
    baseCtx.fillStyle = fc.value;
    baseCtx.fillRect(0, destY, fullW, destH);
    baseValid = true;

    redrawFromBase();
}

function handleWorkerPartial(msg) {
    const { jobId, fbW, fbH, gray, yStart, yEnd } = msg;
    if (currentJobId === null || jobId !== currentJobId) return;

    const numRows = yEnd - yStart;
    if (numRows <= 0) return;

    if (!lastGray || lastFbW !== fbW || lastFbH !== fbH) {
        lastGray = new Uint8Array(fbW * fbH);
        lastFbW = fbW;
        lastFbH = fbH;
    }

    for (let row = 0; row < numRows; row++) {
        const srcBase = row * fbW;
        const dstRow = yStart + row;
        const dstBase = dstRow * fbW;
        lastGray.set(gray.subarray(srcBase, srcBase + fbW), dstBase);
    }

    const coloredBand = colorizeGray(gray);

    bufCanvas.width = fbW;
    bufCanvas.height = numRows;
    const img = new ImageData(coloredBand, fbW, numRows);
    bufCtx.putImageData(img, 0, 0);

    const destY = (yStart / fbH) * fullH;
    const destH = (numRows / fbH) * fullH;

    baseCtx.setTransform(1, 0, 0, 1, 0, 0);
    baseCtx.drawImage(
        bufCanvas,
        0,
        0,
        fbW,
        numRows,
        0,
        destY,
        fullW,
        destH,
    );
    baseValid = true;

    redrawFromBase();
}

function handleWorkerFrame(msg) {
    const { jobId, fbW, fbH, gray } = msg;
    if (currentJobId === null || jobId !== currentJobId) {
        jobInFlight = false;
        return;
    }

    jobInFlight = false;

    const view = getCurrentView();

    lastGray = new Uint8Array(gray);
    lastFbW = fbW;
    lastFbH = fbH;

    redrawFullColored(lastGray, fbW, fbH);

    centerX = view.cx;
    centerY = view.cy;
    zoom = view.zoom;
    viewScale = 1;
    viewOffsetX = 0;
    viewOffsetY = 0;
    setZoomStatus();

    redrawFromBase();

    currentStage++;
    stagePending = currentStage < STAGES.length;
    if (!stagePending) {
        currentStage = -1;
        setRenderStatus("idle");
    } else {
        const nextScale = STAGES[currentStage].scale;
        setRenderStatus(
            `render: stage ${currentStage + 1}/${STAGES.length} scale=${nextScale}`,
        );
    }
}

function initWorker() {
    worker = new Worker("/mandelbrot/mandel-worker.js");
    worker.onmessage = (e) => {
        const msg = e.data;
        switch (msg.type) {
            case "ready":
                workerReady = true;
                setRenderStatus("worker ready");
                setErrorStatus("");
                requestFullRender();
                break;
            case "scan":
                handleWorkerScan(msg);
                break;
            case "partial":
                handleWorkerPartial(msg);
                break;
            case "frame":
                handleWorkerFrame(msg);
                break;
            case "error":
                setErrorStatus(msg.message || "worker error");
                break;
        }
    };
    worker.onerror = (err) => {
        setErrorStatus(err.message || "worker error");
    };
    worker.onmessageerror = () => {
        setErrorStatus("worker message error");
    };
}
