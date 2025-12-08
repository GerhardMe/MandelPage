"use strict";

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
