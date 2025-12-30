"use strict";

// ------------------ DOM refs ------------------

const canvas = document.getElementById("view");
const ctx = canvas.getContext("2d");

// Info screen
const info = document.getElementById("info");

// Palette / controls
const controls = document.getElementById("controls");
const controlsHeader = document.getElementById("controlsHeader");
const fc = document.getElementById("fc");
const mandelGlow = document.getElementById("mandelGlow");
const juliaGlow = document.getElementById("juliaGlow");
const relativeJulia = document.getElementById("relativeJulia");
const juliaIterations = document.getElementById("juliaIterations");
const mandelIterations = document.getElementById("mandelIterations");
const getCursor = document.getElementById("get");
const juliaNorm = document.getElementById("normalize-julia");
const mandelNorm = document.getElementById("normalize-mandel");


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
const optionsBtn = document.getElementById("OptionsBtn");
const juliaBtn = document.getElementById("JuliaBtn");
const infoBtn = document.getElementById("infoBtn");
const infoBtnExit = document.getElementById("infoBtnExit");


// Minimize buttons ("─" in headers)
const optionsMinBtn = controlsHeader
    ? controlsHeader.querySelector(".appMinimize")
    : null;
const juliaMinBtn = juliaHeader
    ? juliaHeader.querySelector(".appMinimize")
    : null;

if (fc) fc.value = "#00ffff";

const decimal = 20;

// ------------------ status ------------------

const status = {
    render: "WASM worker loading…",
    cursor: "",
    zoom: "",
    error: ""
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

    updateStatus();

    if (juliaCoordinatesEl) {
        juliaCoordinatesEl.textContent = "Julia-set: " + text;
    }
}

function setErrorStatus(msg) {
    status.error = msg ? `error: ${msg}` : "";
    updateStatus();
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

// ------------------ live recolor controls ------------------

function syncFillInteriorFlagFromDom() {
    if (typeof fillInterior === "undefined") return;
    if (!fillInside) return;
    fillInterior = fillInside.checked ? 1 : 0;
}

function recolorMandelNow() {
    if (typeof recolorFromLastGray === "function") {
        recolorFromLastGray();
    }
}

function recolorJuliaNow() {
    if (typeof recolorJuliaFromLastGray === "function") {
        recolorJuliaFromLastGray();
    }
}

if (fc) {
    fc.addEventListener("input", () => {
        updateColorChangers();
        // Shared color affects both.
        recolorMandelNow();
        recolorJuliaNow();
    });
}

if (mandelGlow) {
    mandelGlow.addEventListener("input", () => {
        recolorMandelNow();
    });
}

if (juliaGlow) {
    juliaGlow.addEventListener("input", () => {
        recolorJuliaNow();
    });
}

if (fillInside) {
    fillInside.addEventListener("change", () => {
        syncFillInteriorFlagFromDom();
        recolorMandelNow();
        recolorJuliaNow();
    });
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

function setOptionsMinimized(minimized) {
    if (!controls) return;

    controls.classList.toggle("minimized", minimized);

    if (optionsBtn) {
        optionsBtn.style.color = minimized
            ? fc.value
            : statusEl.style.color;
    }
}

function setJuliaMinimized(minimized) {
    if (!juliaBox) return;

    juliaBox.classList.toggle("minimized", minimized);

    if (juliaBtn) {
        juliaBtn.classList.toggle("colorChanger", minimized);
        juliaBtn.style.color = minimized
            ? fc.value
            : statusEl.style.color;
    }

    if (juliaCursorEl) {
        juliaCursorEl.style.display = minimized ? "none" : "";
    }
}


function setInfoMinimized(minimized) {
    if (!info) return;

    info.classList.toggle("minimized", minimized);

    if (infoBtn) {
        infoBtn.style.color = minimized
            ? fc.value
            : statusEl.style.color;
    }
}

function isInfoMinimized() {
    return (
        info.classList.contains("minimized")
    );
}

function isOptionsMinimized() {
    return (
        controls.classList.contains("minimized")
    );
}

function isJuliaMinimized() {
    return (
        juliaBox.classList.contains("minimized")
    );
}

function setupMinimizeBehavior() {

    // Header buttons minimize
    if (optionsMinBtn) {
        optionsMinBtn.addEventListener("click", () => {
            setOptionsMinimized(true);
        });
    }

    if (juliaMinBtn) {
        juliaMinBtn.addEventListener("click", () => {
            setJuliaMinimized(true);
        });
    }

    // Status-bar buttons toggle behavior
    if (optionsBtn) {
        optionsBtn.addEventListener("click", () => {
            const next = !isOptionsMinimized();
            if (!isInfoMinimized()) {
                setInfoMinimized(true);
            }
            setOptionsMinimized(next);
        });
    }

    if (juliaBtn) {
        juliaBtn.addEventListener("click", () => {
            const next = !isJuliaMinimized();
            if (!isInfoMinimized()) {
                setInfoMinimized(true);
            }
            setJuliaMinimized(next);
        });
    }

    if (infoBtn) {
        infoBtn.addEventListener("click", () => {
            const next = !isInfoMinimized();
            setInfoMinimized(next);

            if (!next) {
                setOptionsMinimized(true);
                setJuliaMinimized(true);
            }
        });
    }

    if (infoBtnExit) {
        infoBtnExit.addEventListener("click", () => {
            setInfoMinimized(true);
        });
    }

}

// ------------------ palette controls ------------------

if (fc) {
    fc.addEventListener("input", () => {
        updateColorChangers();
        recolorFromLastGray();
        recolorJuliaFromLastGray();
    });
}

if (mandelGlow) {
    mandelGlow.addEventListener("input", () => {
        recolorFromLastGray();
    });
}

if (juliaGlow) {
    juliaGlow.addEventListener("input", () => {
        recolorJuliaFromLastGray();
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

        // Mandelbrot worker still uses fillInterior in the math
        requestFullRender();

        // For Julia, interior fill is handled in colorizeGray only
        recolorJuliaFromLastGray();
    });
}

if (relativeJulia) {
    relativeJulia.addEventListener("change", () => {
        cancelJuliaJob();
        requestJuliaRender();
    });
}

if (juliaIterations) {
    juliaIterations.addEventListener("input", () => {
        cancelJuliaJob();
        requestJuliaRender();
    });
    juliaIterations.addEventListener("change", () => {
        cancelJuliaJob();
        requestJuliaRender();
    });
}

if (getCursor) {
    getCursor.addEventListener("click", () => {
        const w = Math.round(canvas.getBoundingClientRect().width / 2);
        const h = Math.round(canvas.getBoundingClientRect().height / 2);

        setJuliaCursorFromClient(w, h)
    });
}

if (juliaNorm) {
    juliaNorm.addEventListener("click", () => {
        if (lastJuliaGray && lastJuliaGray.length > 0) {
            lastJuliaGray = normalizeContrast(lastJuliaGray);
            recolorJuliaNow();
        }
    });
}
if (mandelNorm) {
    mandelNorm.addEventListener("click", () => {
        if (lastGray && lastGray.length > 0) {
            lastGray = normalizeContrast(lastGray);
            recolorMandelNow();
        }
    });
}

if (mandelIterations) {
    mandelIterations.addEventListener("change", () => {
        markInteraction();     // cancels current job + resets stages
        requestFullRender();   // restarts pipeline
    });
}

// ------------------ Julia panel ------------------

function syncJuliaCanvasSize() {
    if (!juliaCanvas || !juliaContent || !juliaBox || !juliaHeader) return;

    const boxRect = juliaBox.getBoundingClientRect();

    const width = Math.max(1, Math.floor(boxRect.width) - 24);
    const height = Math.max(1, Math.floor(boxRect.height - 157));

    juliaContent.style.width = width + "px";
    juliaContent.style.height = height + "px";

    juliaCanvas.style.width = width + "px";
    juliaCanvas.style.height = height + "px";

    juliaCanvas.width = width;
    juliaCanvas.height = height;
}

function forceJuliaPanelLayoutCommit() {
    if (!juliaBox) return;

    // Commit current computed size to inline styles so our math uses stable numbers.
    const r = juliaBox.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
        juliaBox.style.width = Math.round(r.width) + "px";
        juliaBox.style.height = Math.round(r.height) + "px";
    }
}

function syncJuliaPanelNow() {
    if (!juliaBox || juliaBox.classList.contains("minimized")) return;
    syncJuliaCanvasSize();
    requestJuliaRender();
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
        }
    );

    // Fix wrong initial sizing: commit layout + sync after layout settles.
    requestAnimationFrame(() => {
        if (juliaBox.classList.contains("minimized")) return;

        forceJuliaPanelLayoutCommit();
        syncJuliaPanelNow();

        // Second frame catches late CSS/font/layout changes.
        requestAnimationFrame(() => {
            syncJuliaPanelNow();
        });
    });

    // Also handle late-load layout shifts (images/fonts/CSS).
    window.addEventListener(
        "load",
        () => {
            forceJuliaPanelLayoutCommit();
            syncJuliaPanelNow();
        },
        { once: true }
    );
}
