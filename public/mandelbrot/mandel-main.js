(function () {
    "use strict";

    // ------------------ DOM refs ------------------

    const canvas = document.getElementById("view");
    const ctx = canvas.getContext("2d");

    // Palette / controls
    const controls = document.getElementById("controls");
    const controlsHeader = document.getElementById("controlsHeader");
    const fc = document.getElementById("fc");
    const bw = document.getElementById("bw");
    const fillInside = document.getElementById("fillInside");
    const statusEl = document.getElementById("status");

    // Julia panel
    const juliaBox = document.getElementById("juliaBox");
    const juliaHeader = document.getElementById("juliaHeader");
    const juliaContent = document.getElementById("juliaContent");
    const juliaCanvas = document.getElementById("juliaCanvas");
    const juliaResizeHandle = document.getElementById("juliaResizeHandle");

    // Julia cursor (world-anchored, draggable)
    const juliaCursorEl = document.getElementById("juliaCursor");

    // External coordinates display
    const juliaCoordinatesEl = document.getElementById("juliaCoordinates");

    // Status-bar app links
    const statusPaletteBtn = document.getElementById("statusPalette");
    const statusJuliaBtn = document.getElementById("statusJulia");

    // Minimize buttons ("─" in headers)
    const paletteMinBtn = controlsHeader
        ? controlsHeader.querySelector(".appMinimize")
        : null;
    const juliaMinBtn = juliaHeader
        ? juliaHeader.querySelector(".appMinimize")
        : null;

    if (fc) fc.value = "#00ffff";

    const decimal = 24;

    // ------------------ status ------------------

    const status = {
        render: "WASM worker loading…",
        cursor: "",
        zoom: "",
        error: "",
        juliaCursor: "",
    };

    function updateStatus() {
        const parts = [];
        if (status.render) parts.push(status.render);
        if (status.zoom) parts.push(status.zoom);
        if (status.error) parts.push(status.error);
        if (status.cursor) parts.push(status.cursor);
        if (status.juliaCursor) parts.push(status.juliaCursor);
        statusEl.textContent = parts.join(" | ");
    }

    function setRenderStatus(msg) {
        status.render = msg;
        updateStatus();
    }

    function setZoomStatus() {
        const effectiveZoom = zoom * (viewScale || 1);
        status.zoom = `zoom: ${effectiveZoom.toFixed(3)}x`;
        updateStatus();
    }

    function setCursorStatus(cx, cy) {
        if (cx == null || cy == null) return;
        const re = cx.toFixed(decimal);
        const imAbs = Math.abs(cy).toFixed(decimal);
        const sign = cy >= 0 ? "-" : "+";
        status.cursor = `cursor: ${re} ${sign} ${imAbs}i`;
        updateStatus();
    }

    function setJuliaCursorStatus(cx, cy) {
        if (cx == null || cy == null) return;
        const re = cx.toFixed(decimal);
        const imAbs = Math.abs(cy).toFixed(decimal);
        const sign = cy >= 0 ? "-" : "+";
        const text = `${re} ${sign} ${imAbs}i`;

        status.juliaCursor = `Julia-set: ${text}`;
        updateStatus();

        if (juliaCoordinatesEl) {
            juliaCoordinatesEl.textContent = "Julia-set: " + text;
        }
    }

    function setErrorStatus(msg) {
        status.error = msg ? `error: ${msg}` : "";
        updateStatus();
    }

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

    // screen transform (pan/zoom of base image)
    let viewScale = 1;
    let viewOffsetX = 0;
    let viewOffsetY = 0;

    // ------------------ worker state: Mandelbrot ------------------

    let worker = null;
    let workerReady = false;
    let nextJobId = 1;
    let currentJobId = null;
    let jobInFlight = false;

    const STAGES = [{ scale: 4 }, { scale: 1 }, { scale: 0.25 }];
    let currentStage = -1;
    let stagePending = false;

    // ------------------ worker state: Julia GPU ------------------

    let juliaWorker = null;
    let juliaWorkerReady = false;
    let juliaNextJobId = 1;
    let juliaCurrentJobId = null;

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

    // ------------------ Julia cursor state (world-anchored) ------------------

    let juliaCursorWorldX = null;
    let juliaCursorWorldY = null;
    let juliaCursorDragging = false;

    const JULIA_CURSOR_START_RE = -0.5125;
    const JULIA_CURSOR_START_IM = -0.5213;
    const HAS_JULIA_START =
        Number.isFinite(JULIA_CURSOR_START_RE) &&
        Number.isFinite(JULIA_CURSOR_START_IM);

    // ------------------ helpers ------------------

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

    function getBandWidth() {
        const raw = parseInt(bw.value, 10) || 0;
        const sNorm = Math.min(1, Math.max(0, raw / 100));
        const sInv = 1 - sNorm;
        const minW = 0.2;
        const maxW = 5;
        return minW + sInv * (maxW - minW);
    }

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

    // ---------- generic color changer for UI elements ----------

    function updateColorChangers() {
        if (!fc) return;
        const color = fc.value;
        const nodes = document.querySelectorAll(".colorChanger");

        nodes.forEach((el) => {
            el.style.borderColor = color;
            el.style.color = color;
        });
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

    // ---- Julia GPU worker integration ----

    function requestJuliaRender() {
        if (!juliaWorkerReady) return;
        if (!juliaCanvas) return;
        if (juliaCursorWorldX == null || juliaCursorWorldY == null) return;

        const fbW = juliaCanvas.width | 0;
        const fbH = juliaCanvas.height | 0;
        if (!fbW || !fbH) return;

        const jobId = juliaNextJobId++;
        juliaCurrentJobId = jobId;

        juliaWorker.postMessage({
            type: "render",
            jobId,
            fbW,
            fbH,
            cRe: juliaCursorWorldX,
            cIm: juliaCursorWorldY,
        });
    }

    function handleJuliaFrame(msg) {
        const { jobId, fbW, fbH, pixels } = msg;
        if (juliaCurrentJobId === null || jobId !== juliaCurrentJobId) return;
        if (!juliaCanvas) return;

        const jctx = juliaCanvas.getContext("2d");
        if (!jctx) return;

        const data = new Uint8ClampedArray(pixels);
        const img = new ImageData(data, fbW, fbH);
        jctx.putImageData(img, 0, 0);
    }

    function initJuliaWorker() {
        if (!juliaCanvas) return;

        juliaWorker = new Worker("/mandelbrot/julia-worker.js");
        juliaWorker.onmessage = (e) => {
            const msg = e.data;
            switch (msg.type) {
                case "ready":
                    juliaWorkerReady = true;
                    // optional: trigger first render once cursor is set
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

    // ------------------ palette controls ------------------

    if (fc) {
        fc.addEventListener("input", () => {
            // If you have a specific palette-border updater, call it here.
            // Keep generic color update:
            updateColorChangers();
            recolorFromLastGray();
            // You might also want Julia worker to respond to palette changes
            requestJuliaRender();
        });
    }

    if (bw) {
        bw.addEventListener("input", () => {
            recolorFromLastGray();
            // optional: Julia worker could depend on band width too
            requestJuliaRender();
        });
    }

    if (fillInside) {
        fillInside.addEventListener("change", () => {
            fillInterior = fillInside.checked ? 1 : 0;

            if (workerReady && currentJobId != null) {
                worker.postMessage({ type: "cancel", jobId: currentJobId });
            }
            currentJobId = null;
            jobInFlight = false;
            currentStage = -1;
            stagePending = false;

            requestFullRender();
            requestJuliaRender();
        });
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

    // ------------------ generic draggable / resizable panels ------------------

    function setupDraggablePanel(panelEl, headerEl) {
        if (!panelEl || !headerEl) return;

        let dragging = false;
        let offsetX = 0;
        let offsetY = 0;

        headerEl.addEventListener("pointerdown", (e) => {
            if (e.button !== 0) return;

            // Don't start a drag if the pointer is on a minimize button
            if (e.target.closest(".appMinimize")) {
                return;
            }

            dragging = true;
            headerEl.setPointerCapture(e.pointerId);
            const rect = panelEl.getBoundingClientRect();
            offsetX = e.clientX - rect.left;
            offsetY = e.clientY - rect.top;
        });

        function endDrag(e) {
            if (!dragging) return;
            dragging = false;
            try {
                headerEl.releasePointerCapture(e.pointerId);
            } catch (_) { }
        }

        window.addEventListener("pointermove", (e) => {
            if (!dragging) return;
            const x = e.clientX - offsetX;
            const y = e.clientY - offsetY;
            panelEl.style.left = x + "px";
            panelEl.style.top = y + "px";
            panelEl.style.right = "auto";
            panelEl.style.bottom = "auto";
        });

        headerEl.addEventListener("pointerup", endDrag);
        headerEl.addEventListener("pointercancel", endDrag);
    }

    function setupResizablePanel(boxEl, handleEl, minWidth, minHeight, onResize) {
        if (!boxEl || !handleEl) return;

        let resizing = false;
        let startX = 0;
        let startY = 0;
        let startWidth = 0;
        let startHeight = 0;

        handleEl.addEventListener("pointerdown", (e) => {
            if (e.button !== 0) return;
            resizing = true;
            handleEl.setPointerCapture(e.pointerId);
            const rect = boxEl.getBoundingClientRect();
            startWidth = rect.width;
            startHeight = rect.height;
            startX = e.clientX;
            startY = e.clientY;
        });

        function endResize(e) {
            if (!resizing) return;
            resizing = false;
            try {
                handleEl.releasePointerCapture(e.pointerId);
            } catch (_) { }
        }

        window.addEventListener("pointermove", (e) => {
            if (!resizing) return;

            const dx = e.clientX - startX;
            const dy = e.clientY - startY;

            const newWidth = Math.max(minWidth, startWidth + dx);
            const newHeight = Math.max(minHeight, startHeight + dy);

            boxEl.style.width = newWidth + "px";
            boxEl.style.height = newHeight + "px";

            if (typeof onResize === "function") {
                onResize();
            }
        });

        handleEl.addEventListener("pointerup", endResize);
        handleEl.addEventListener("pointercancel", endResize);
    }

    // ------------------ minimize helpers ------------------

    function setPaletteMinimized(minimized) {
        if (!controls) return;

        controls.classList.toggle("minimized", minimized);
        controls.style.display = minimized ? "none" : "";

        if (statusPaletteBtn) {
            statusPaletteBtn.classList.toggle("colorChanger", minimized);
            statusPaletteBtn.style.color = minimized
                ? fc.value
                : statusEl.style.color;
        }
    }

    function setJuliaMinimized(minimized) {
        if (!juliaBox) return;

        juliaBox.classList.toggle("minimized", minimized);
        juliaBox.style.display = minimized ? "none" : "";

        if (statusJuliaBtn) {
            statusJuliaBtn.classList.toggle("colorChanger", minimized);
            statusJuliaBtn.style.color = minimized
                ? fc.value
                : statusEl.style.color;
        }

        if (juliaCursorEl) {
            juliaCursorEl.style.display = minimized ? "none" : "";
        }

        if (!minimized) {
            requestAnimationFrame(() => {
                syncJuliaCanvasSize();
                requestJuliaRender();
            });
        }
    }

    function setupMinimizeBehavior() {
        function isPaletteMinimized() {
            if (!controls) return true;
            return (
                controls.classList.contains("minimized") ||
                controls.style.display === "none"
            );
        }

        function isJuliaMinimized() {
            if (!juliaBox) return true;
            return (
                juliaBox.classList.contains("minimized") ||
                juliaBox.style.display === "none"
            );
        }

        function togglePalette() {
            if (!controls) return;
            const next = !isPaletteMinimized();
            setPaletteMinimized(next);
        }

        function toggleJulia() {
            if (!juliaBox) return;
            const next = !isJuliaMinimized();
            setJuliaMinimized(next);
        }

        // Header buttons
        if (paletteMinBtn) {
            paletteMinBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                togglePalette();
            });
        }

        if (juliaMinBtn) {
            juliaMinBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                toggleJulia();
            });
        }

        // Status-bar buttons – same toggle behavior
        if (statusPaletteBtn) {
            statusPaletteBtn.addEventListener("click", () => {
                togglePalette();
            });
        }

        if (statusJuliaBtn) {
            statusJuliaBtn.addEventListener("click", () => {
                toggleJulia();
            });
        }

        // Initial state
        setPaletteMinimized(false);
        setJuliaMinimized(false);
    }

    // ------------------ Julia panel ------------------

    function syncJuliaCanvasSize() {
        if (!juliaCanvas || !juliaContent || !juliaBox || !juliaHeader) return;

        const boxRect = juliaBox.getBoundingClientRect();

        const width = Math.max(1, Math.floor(boxRect.width) - 24);
        const height = Math.max(1, Math.floor(boxRect.height - 80));

        juliaContent.style.width = width + "px";
        juliaContent.style.height = height + "px";

        juliaCanvas.style.width = width + "px";
        juliaCanvas.style.height = height + "px";

        juliaCanvas.width = width;
        juliaCanvas.height = height;
    }

    function setupJuliaPanel() {
        if (!juliaBox || !juliaHeader || !juliaCanvas || !juliaContent) return;

        setupResizablePanel(
            juliaBox,
            juliaResizeHandle,
            180,
            120,
            () => {
                syncJuliaCanvasSize();
                requestJuliaRender();
            },
        );

        requestAnimationFrame(() => {
            if (juliaBox.classList.contains("minimized")) return;
            const jctx = juliaCanvas.getContext("2d");
            if (jctx) {
                jctx.fillStyle = "black";
                jctx.fillRect(0, 0, juliaCanvas.width, juliaCanvas.height);
            }
        });
    }

    // ------------------ main loop ------------------

    function loop() {
        const now = performance.now();

        if (
            interactionActive &&
            !isPanning &&
            !isPinching &&
            now - lastInteractionTime > INTERACTION_SETTLE_MS &&
            currentStage === -1 &&
            workerReady
        ) {
            interactionActive = false;
            commitVisualAndReset();
            requestFullRender();
        }

        if (stagePending && !jobInFlight) {
            startWorkerJob(currentStage);
        }

        if (cursorScreenX != null && cursorScreenY != null) {
            const world = screenToWorld(cursorScreenX, cursorScreenY);
            setCursorStatus(world.cx, world.cy);
        }

        updateJuliaCursorScreenPosition();

        requestAnimationFrame(loop);
    }

    // ------------------ init ------------------

    function init() {
        resize();
        setZoomStatus();
        updateStatus();
        initWorker();
        initJuliaWorker();

        setupDraggablePanel(controls, controlsHeader);
        setupDraggablePanel(juliaBox, juliaHeader);
        setupMinimizeBehavior();
        setupJuliaPanel();
        setupJuliaCursorDrag();

        const view = getCurrentView();
        if (HAS_JULIA_START) {
            juliaCursorWorldX = JULIA_CURSOR_START_RE;
            juliaCursorWorldY = JULIA_CURSOR_START_IM;
        } else {
            juliaCursorWorldX = view.cx;
            juliaCursorWorldY = view.cy;
        }
        updateJuliaCursorScreenPosition();
        updateJuliaFromCursor();
        updateColorChangers();

        loop();
    }

    init();
})();
