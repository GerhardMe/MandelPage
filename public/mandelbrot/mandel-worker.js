// public/mandel-worker.js

self.Module = self.Module || {};
Module = self.Module;

// mandel.js/wasm live in public/, same folder as this file
importScripts("mandel.js");

let initFB = null;
let getPtr = null;
let renderRows = null;
let wasmReady = false;

let fbW = 0;
let fbH = 0;
let fbView = null;

let currentJob = null;
let jobInProgress = false;
let cancelRequested = false;
let queuedJob = null;

const TARGET_CHUNK_MS = 40; // target for scan smoothness

Module.onRuntimeInitialized = function () {
    initFB = Module.cwrap("init_framebuffer", null, ["number", "number"]);
    getPtr = Module.cwrap("get_framebuffer_ptr", "number", []);
    renderRows = Module.cwrap("render_rows", null, [
        "number", // cx
        "number", // cy
        "number", // zoom
        "number", // scale
        "number", // yStart
        "number", // yEnd
        "number", // fillInterior
    ]);

    // Fallback: full frame
    if (typeof renderRows !== "function") {
        const renderFrame = Module.cwrap("render_frame", null, [
            "number",
            "number",
            "number",
            "number",
            "number",
        ]);
        renderRows = function (cx, cy, zoom, scale, yStart, yEnd, fillInterior) {
            // ignore yStart/yEnd, full frame render
            renderFrame(cx, cy, zoom, scale, fillInterior | 0);
        };
    }

    wasmReady = true;
    postMessage({ type: "ready" });
};

function startJob(job) {
    currentJob = job;
    cancelRequested = false;
    jobInProgress = true;

    fbW = job.fbW;
    fbH = job.fbH;

    initFB(fbW, fbH);

    const fbPtr = getPtr();
    if (!fbPtr) {
        // malloc failed or not initialized; send empty frame and bail
        const grayEmpty = new Uint8Array(fbW * fbH);
        postMessage(
            {
                type: "frame",
                jobId: job.jobId,
                fbW,
                fbH,
                gray: grayEmpty,
                cx: job.cx,
                cy: job.cy,
                zoom: job.zoom,
                scale: job.scale,
            },
            [grayEmpty.buffer],
        );
        jobInProgress = false;
        currentJob = null;
        return;
    }

    // use global HEAPU8, not Module.HEAPU8
    fbView = new Uint8ClampedArray(
        HEAPU8.buffer,
        fbPtr,
        fbW * fbH * 4,
    );

    job.rowsPerChunk = Math.max(4, Math.floor(fbH / 64));
    job._nextRow = 0;

    renderNextChunk();
}

function renderNextChunk() {
    if (!jobInProgress || !currentJob) return;
    if (!fbView) return;

    if (cancelRequested) {
        const cancelledId = currentJob.jobId;
        jobInProgress = false;
        currentJob = null;

        if (queuedJob) {
            const next = queuedJob;
            queuedJob = null;
            startJob(next);
        }

        postMessage({ type: "cancelled", jobId: cancelledId });
        return;
    }

    const job = currentJob;
    const startRow = job._nextRow;
    if (startRow >= fbH) {
        jobInProgress = false;
        currentJob = null;

        if (queuedJob) {
            const next = queuedJob;
            queuedJob = null;
            startJob(next);
        }
        return;
    }

    let rowsPerChunk = job.rowsPerChunk;
    if (rowsPerChunk < 1) rowsPerChunk = 1;
    if (rowsPerChunk > fbH - startRow) rowsPerChunk = fbH - startRow;

    const endRow = startRow + rowsPerChunk;

    // ---------- SCANLINE MESSAGE (for upcoming work) ----------
    // Predict next chunk based on current rowsPerChunk.
    const scanStart = endRow;
    if (scanStart < fbH) {
        const scanRows = rowsPerChunk; // same thickness as current chunk
        const scanEnd = Math.min(fbH, scanStart + scanRows);

        // Tell main thread which rows will be processed next.
        // Main thread should draw this region as solid white.
        postMessage({
            type: "scan",
            jobId: job.jobId,
            fbW,
            fbH,
            yStart: scanStart,
            yEnd: scanEnd,
        });
    }
    // ----------------------------------------------------------

    const t0 = (typeof performance !== "undefined"
        ? performance.now()
        : Date.now());

    renderRows(
        job.cx,
        job.cy,
        job.zoom,
        job.scale,
        startRow,
        endRow,
        job.fillInterior | 0,
    );

    const t1 = (typeof performance !== "undefined"
        ? performance.now()
        : Date.now());
    const elapsed = t1 - t0;

    job._nextRow = endRow;

    const numRows = endRow - startRow;
    const bandLen = fbW * numRows;
    const grayBand = new Uint8Array(bandLen);

    for (let row = startRow; row < endRow; row++) {
        const bandRow = row - startRow;
        const dstBase = bandRow * fbW;
        const srcRowBase = row * fbW * 4;
        for (let x = 0; x < fbW; x++) {
            grayBand[dstBase + x] = fbView[srcRowBase + x * 4];
        }
    }

    postMessage(
        {
            type: "partial",
            jobId: job.jobId,
            fbW,
            fbH,
            gray: grayBand,
            yStart: startRow,
            yEnd: endRow,
            cx: job.cx,
            cy: job.cy,
            zoom: job.zoom,
            scale: job.scale,
        },
        [grayBand.buffer],
    );

    // adapt chunk size to hit TARGET_CHUNK_MS
    if (elapsed < TARGET_CHUNK_MS * 0.7) {
        job.rowsPerChunk = Math.min(fbH, rowsPerChunk * 2);
    } else if (elapsed > TARGET_CHUNK_MS * 1.3 && rowsPerChunk > 1) {
        job.rowsPerChunk = Math.max(1, Math.floor(rowsPerChunk / 2));
    } else {
        job.rowsPerChunk = rowsPerChunk;
    }

    if (endRow >= fbH) {
        const grayFull = new Uint8Array(fbW * fbH);
        for (let i = 0, j = 0; i < grayFull.length; i++, j += 4) {
            grayFull[i] = fbView[j];
        }

        postMessage(
            {
                type: "frame",
                jobId: job.jobId,
                fbW,
                fbH,
                gray: grayFull,
                cx: job.cx,
                cy: job.cy,
                zoom: job.zoom,
                scale: job.scale,
            },
            [grayFull.buffer],
        );

        jobInProgress = false;
        currentJob = null;

        if (queuedJob) {
            const next = queuedJob;
            queuedJob = null;
            startJob(next);
        }
    } else {
        setTimeout(renderNextChunk, 0);
    }
}

self.onmessage = function (e) {
    const msg = e.data;
    if (!wasmReady) return;

    if (msg.type === "render") {
        const {
            jobId,
            fbW,
            fbH,
            cx,
            cy,
            zoom,
            scale,
            fillInterior,
        } = msg;

        const job = {
            jobId,
            fbW,
            fbH,
            cx,
            cy,
            zoom,
            scale,
            fillInterior: fillInterior | 0,
            _nextRow: 0,
            rowsPerChunk: 0,
        };

        if (!jobInProgress) {
            startJob(job);
        } else {
            cancelRequested = true;
            queuedJob = job;
        }
    } else if (msg.type === "cancel") {
        const { jobId } = msg;
        if (jobInProgress && currentJob && currentJob.jobId === jobId) {
            cancelRequested = true;
        }
    }
};
