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
let hasPanned = false; // tracks if actual movement occurred during pan
const activePointers = new Map();
let panStartX = 0;
let panStartY = 0;
let panStartOffsetX = 0;
let panStartOffsetY = 0;
// pinch-zoom
let isPinching = false;
let hasPinched = false; // tracks if actual pinch movement occurred
let pinchStartDist = 0;
let pinchStartScale = 1;
let pinchAnchorScreenX = 0;
let pinchAnchorScreenY = 0;
let pinchAnchorWorldX = 0;
let pinchAnchorWorldY = 0;
// cursor (for status bar)
let cursorScreenX = null;
let cursorScreenY = null;

const DRAG_THRESHOLD = 3; // pixels of movement before counting as a drag

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
function getMandelMaxIter() {
    const v = mandelIterations ? Number(mandelIterations.value) : 200;
    const it = Number.isFinite(v) ? (v | 0) : 200;
    return it > 0 ? it : 200;
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
        hasPinched = false; // reset pinch tracking
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
        // Don't call markInteraction here - wait until actual pinch movement
        return;
    }
    if (!isPinching && activePointers.size === 1) {
        isPanning = true;
        hasPanned = false; // reset pan tracking
        canvas.setPointerCapture(e.pointerId);
        panStartX = e.clientX;
        panStartY = e.clientY;
        panStartOffsetX = viewOffsetX;
        panStartOffsetY = viewOffsetY;
        // Don't call markInteraction here - wait until actual pan movement
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

        // Check if pinch distance changed enough to count as actual pinching
        if (!hasPinched && Math.abs(dist - pinchStartDist) > DRAG_THRESHOLD) {
            hasPinched = true;
            markInteraction(); // only mark interaction on first actual pinch movement
        }

        viewScale = pinchStartScale * zoomFactor;
        lockWorldPointToScreen(
            pinchAnchorWorldX,
            pinchAnchorWorldY,
            pinchAnchorScreenX,
            pinchAnchorScreenY,
        );
        setZoomStatus();
        redrawFromBase();
        if (hasPinched) {
            touchInteraction();
        }
        return;
    }
    if (!isPanning || isPinching) return;
    const dx = e.clientX - panStartX;
    const dy = e.clientY - panStartY;

    // Check if we've moved enough to count as actual panning
    if (!hasPanned && (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD)) {
        hasPanned = true;
        markInteraction(); // only mark interaction on first actual pan movement
    }

    viewOffsetX = panStartOffsetX + dx;
    viewOffsetY = panStartOffsetY + dy;
    redrawFromBase();
    if (hasPanned) {
        touchInteraction();
    }
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
        // Only trigger interaction if actual pinching occurred
        if (hasPinched) {
            touchInteraction();
        }
        hasPinched = false;
    }
    if (!isPanning) {
        return;
    }
    isPanning = false;
    try {
        canvas.releasePointerCapture(e.pointerId);
    } catch (_) { }
    // Only trigger interaction if actual panning occurred
    if (hasPanned) {
        touchInteraction();
    }
    hasPanned = false;
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
    const maxIter = getMandelMaxIter();
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
        maxIter,
    });
    setRenderStatus(
        `render: stage ${stageIndex + 1}/${STAGES.length} scale=${scale} iter=${maxIter}`,
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
    const bandGray = gray instanceof Uint8Array ? gray : new Uint8Array(gray);
    if (!lastGray || lastFbW !== fbW || lastFbH !== fbH) {
        lastGray = new Uint8Array(fbW * fbH);
        lastFbW = fbW;
        lastFbH = fbH;
    }
    for (let row = 0; row < numRows; row++) {
        const srcBase = row * fbW;
        const dstRow = yStart + row;
        const dstBase = dstRow * fbW;
        lastGray.set(bandGray.subarray(srcBase, srcBase + fbW), dstBase);
    }
    const coloredBand = colorizeGray(bandGray, {
        colorHex: (typeof fc !== "undefined" && fc) ? fc.value : "#ffffff",
        glow: getMandelGlowValue(),
        fillInterior,
    });
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
    lastGray = gray instanceof Uint8Array ? new Uint8Array(gray) : new Uint8Array(gray);
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