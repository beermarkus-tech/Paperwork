import { getCachedThumbnail, putCachedThumbnail } from "./idb.js";
import { renderFirstPageThumbnail } from "./pdf-thumbnails.js";
import { loadDocument, renderPageToCanvas } from "./pdf-viewer.js";

const pickBtn = document.getElementById("pick-folder-btn");
const statusEl = document.getElementById("status");
const progressEl = document.getElementById("progress");
const resultsEl = document.getElementById("results");
const stripEl = document.getElementById("thumbnail-strip");

const viewerEl = document.getElementById("viewer");
const viewerStageEl = document.getElementById("viewer-stage");
const viewerCanvas = document.getElementById("viewer-canvas");
const viewerIndicator = document.getElementById("viewer-indicator");
const viewerCloseBtn = document.getElementById("viewer-close-btn");
const viewerRotateBtn = document.getElementById("viewer-rotate-btn");

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

async function collectPdfEntries(dirHandle) {
  const entries = [];
  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind === "file" && name.toLowerCase().endsWith(".pdf")) {
      const file = await handle.getFile();
      entries.push({ name, file, size: file.size, lastModified: file.lastModified });
    }
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

function buildThumbnailItem(entry, onOpen) {
  const item = document.createElement("div");
  item.className = "thumb-item";

  const imgWrap = document.createElement("div");
  imgWrap.className = "thumb-image";
  item.appendChild(imgWrap);

  const caption = document.createElement("div");
  caption.className = "thumb-caption";
  caption.textContent = entry.name;
  item.appendChild(caption);

  const size = document.createElement("div");
  size.className = "thumb-size";
  size.textContent = formatBytes(entry.size);
  item.appendChild(size);

  item.addEventListener("click", () => {
    for (const el of stripEl.querySelectorAll(".thumb-item.selected")) {
      el.classList.remove("selected");
    }
    item.classList.add("selected");
    onOpen();
  });

  return { item, imgWrap };
}

function setThumbnailImage(imgWrap, blob) {
  const url = URL.createObjectURL(blob);
  const img = document.createElement("img");
  img.src = url;
  img.alt = "";
  img.loading = "lazy";
  imgWrap.replaceChildren(img);
}

async function generateThumbnails(folderName, entries, elements) {
  progressEl.max = entries.length;
  progressEl.value = 0;
  progressEl.hidden = false;

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const { imgWrap } = elements[i];
    const key = `${folderName}/${entry.name}`;

    statusEl.textContent = `Rendering thumbnails… ${i + 1} / ${entries.length}`;

    let cached = await getCachedThumbnail(key);
    const isFresh =
      cached && cached.size === entry.size && cached.lastModified === entry.lastModified;

    if (isFresh) {
      entry.pageCount = cached.pageCount;
      setThumbnailImage(imgWrap, cached.thumbnail);
    } else {
      try {
        const { blob, pageCount } = await renderFirstPageThumbnail(entry.file);
        entry.pageCount = pageCount;
        setThumbnailImage(imgWrap, blob);
        await putCachedThumbnail({
          key,
          size: entry.size,
          lastModified: entry.lastModified,
          pageCount,
          thumbnail: blob,
        });
      } catch (err) {
        console.error(`Failed to render thumbnail for ${entry.name}:`, err);
        imgWrap.classList.add("thumb-error");
        const errorText = document.createElement("div");
        errorText.className = "thumb-error-text";
        errorText.textContent = `⚠️ ${err.name || "Error"}: ${err.message || err}`;
        imgWrap.replaceChildren(errorText);
      }
    }

    progressEl.value = i + 1;
  }

  progressEl.hidden = true;
}

// --- Main viewer ---

const viewerState = {
  entries: [],
  index: 0,
  pdf: null,
  loadingTask: null,
  pageNumber: 1,
  rotationByPage: new Map(),
  zoom: 1,
  panX: 0,
  panY: 0,
};

function applyViewerTransform() {
  viewerCanvas.style.transform = `translate(${viewerState.panX}px, ${viewerState.panY}px) scale(${viewerState.zoom})`;
}

function resetZoomPan() {
  viewerState.zoom = 1;
  viewerState.panX = 0;
  viewerState.panY = 0;
  applyViewerTransform();
}

async function renderCurrentPage() {
  const entry = viewerState.entries[viewerState.index];
  const rotation = viewerState.rotationByPage.get(viewerState.pageNumber) || 0;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const maxWidth = viewerStageEl.clientWidth * dpr;
  const maxHeight = viewerStageEl.clientHeight * dpr;

  await renderPageToCanvas(
    viewerState.pdf,
    viewerState.pageNumber,
    rotation,
    viewerCanvas,
    maxWidth,
    maxHeight,
  );

  viewerIndicator.textContent = `${entry.name} — page ${viewerState.pageNumber} of ${viewerState.pdf.numPages}`;
}

async function openDocumentAt(index) {
  if (viewerState.loadingTask) {
    const oldTask = viewerState.loadingTask;
    viewerState.loadingTask = null;
    viewerState.pdf = null;
    await oldTask.destroy().catch(() => {});
  }

  viewerState.index = index;
  viewerState.pageNumber = 1;
  viewerState.rotationByPage = new Map();
  resetZoomPan();

  const entry = viewerState.entries[index];
  viewerIndicator.textContent = `${entry.name} — loading…`;

  const { pdf, loadingTask } = await loadDocument(entry.file);
  viewerState.pdf = pdf;
  viewerState.loadingTask = loadingTask;
  await renderCurrentPage();
}

function openViewer(entries, index) {
  viewerState.entries = entries;
  viewerEl.hidden = false;
  openDocumentAt(index).catch((err) => {
    console.error("Failed to open document in viewer:", err);
    viewerIndicator.textContent = `⚠️ ${err.name || "Error"}: ${err.message || err}`;
  });
}

async function closeViewer() {
  viewerEl.hidden = true;
  if (viewerState.loadingTask) {
    const task = viewerState.loadingTask;
    viewerState.loadingTask = null;
    viewerState.pdf = null;
    await task.destroy().catch(() => {});
  }
}

const EXIT_MS = 80;
const ENTER_MS = 120;
let isNavigating = false;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function animateNavigation(axis, direction, performNavigation) {
  if (isNavigating) return;
  isNavigating = true;
  try {
    const distance =
      axis === "x" ? viewerStageEl.clientWidth * 0.35 : viewerStageEl.clientHeight * 0.35;
    const exitOffset = direction > 0 ? -distance : distance;
    const enterOffset = -exitOffset;
    const translate = (px) => (axis === "x" ? `translateX(${px}px)` : `translateY(${px}px)`);

    viewerCanvas.style.transition = `transform ${EXIT_MS}ms ease-in, opacity ${EXIT_MS}ms ease-in`;
    requestAnimationFrame(() => {
      viewerCanvas.style.transform = translate(exitOffset);
      viewerCanvas.style.opacity = "0";
    });
    await wait(EXIT_MS);

    await performNavigation();

    viewerCanvas.style.transition = "none";
    viewerCanvas.style.transform = translate(enterOffset);
    viewerCanvas.style.opacity = "0";
    void viewerCanvas.offsetWidth; // force reflow so the next transition starts from here

    viewerCanvas.style.transition = `transform ${ENTER_MS}ms ease-out, opacity ${ENTER_MS}ms ease-out`;
    requestAnimationFrame(() => {
      viewerCanvas.style.transform = "translate(0px, 0px)";
      viewerCanvas.style.opacity = "1";
    });
    await wait(ENTER_MS);
    viewerCanvas.style.transition = "";
  } finally {
    isNavigating = false;
  }
}

function goToPage(delta) {
  if (!viewerState.pdf || isNavigating) return;
  const next = viewerState.pageNumber + delta;
  if (next < 1 || next > viewerState.pdf.numPages) return;
  animateNavigation("x", delta, async () => {
    viewerState.pageNumber = next;
    resetZoomPan();
    await renderCurrentPage();
  }).catch((err) => console.error("Failed to render page:", err));
}

function goToDocument(delta) {
  if (isNavigating) return;
  const next = viewerState.index + delta;
  if (next < 0 || next >= viewerState.entries.length) return;
  animateNavigation("y", delta, () => openDocumentAt(next)).catch((err) =>
    console.error("Failed to open document:", err),
  );
}

viewerCloseBtn.addEventListener("click", closeViewer);

viewerRotateBtn.addEventListener("click", () => {
  if (!viewerState.pdf) return;
  const current = viewerState.rotationByPage.get(viewerState.pageNumber) || 0;
  viewerState.rotationByPage.set(viewerState.pageNumber, (current + 90) % 360);
  resetZoomPan();
  renderCurrentPage().catch((err) => console.error("Failed to render page:", err));
});

// Touch gestures: pinch to zoom, single-finger pan when zoomed,
// horizontal swipe for pages, vertical swipe for documents.
const pointers = new Map();
let pinchStartDist = 0;
let pinchStartZoom = 1;
let dragStart = null;
let panStart = null;

function pointerDistance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

viewerStageEl.addEventListener("pointerdown", (e) => {
  viewerStageEl.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (pointers.size === 1) {
    dragStart = { x: e.clientX, y: e.clientY };
    panStart = { x: viewerState.panX, y: viewerState.panY };
  } else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinchStartDist = pointerDistance(a, b);
    pinchStartZoom = viewerState.zoom;
    dragStart = null;
  }
});

viewerStageEl.addEventListener("pointermove", (e) => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    if (pinchStartDist > 0) {
      const rawZoom = pinchStartZoom * (pointerDistance(a, b) / pinchStartDist);
      viewerState.zoom = Math.min(Math.max(rawZoom, 1), 5);
      applyViewerTransform();
    }
    return;
  }

  if (pointers.size === 1) {
    const p = [...pointers.values()][0];
    if (!dragStart) {
      dragStart = { x: p.x, y: p.y };
      panStart = { x: viewerState.panX, y: viewerState.panY };
    }
    if (viewerState.zoom > 1.02) {
      viewerState.panX = panStart.x + (p.x - dragStart.x);
      viewerState.panY = panStart.y + (p.y - dragStart.y);
      applyViewerTransform();
    }
  }
});

function endPointer(e) {
  const wasSingle = pointers.size === 1 && pointers.has(e.pointerId);
  const lastPos = pointers.get(e.pointerId);
  pointers.delete(e.pointerId);

  if (wasSingle && dragStart && viewerState.zoom <= 1.02 && lastPos) {
    const dx = lastPos.x - dragStart.x;
    const dy = lastPos.y - dragStart.y;
    const SWIPE_THRESHOLD = 50;
    if (Math.max(Math.abs(dx), Math.abs(dy)) > SWIPE_THRESHOLD) {
      if (Math.abs(dx) > Math.abs(dy)) {
        goToPage(dx < 0 ? 1 : -1);
      } else {
        goToDocument(dy < 0 ? 1 : -1);
      }
    }
  }

  if (pointers.size < 2 && viewerState.zoom < 1.05) {
    resetZoomPan();
  }
  if (pointers.size === 0) {
    dragStart = null;
  }
}

viewerStageEl.addEventListener("pointerup", endPointer);
viewerStageEl.addEventListener("pointercancel", endPointer);

// --- Folder setup ---

async function handlePickFolder() {
  statusEl.textContent = "Waiting for folder selection…";
  try {
    const dirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
    statusEl.textContent = `Scanning "${dirHandle.name}"…`;

    const entries = await collectPdfEntries(dirHandle);
    statusEl.textContent = `Found ${entries.length} PDF${entries.length === 1 ? "" : "s"} in "${dirHandle.name}".`;

    stripEl.innerHTML = "";
    if (entries.length === 0) {
      resultsEl.hidden = true;
      return;
    }

    const elements = entries.map((entry, index) => {
      const { item, imgWrap } = buildThumbnailItem(entry, () => openViewer(entries, index));
      stripEl.appendChild(item);
      return { item, imgWrap };
    });
    resultsEl.hidden = false;

    await generateThumbnails(dirHandle.name, entries, elements);
    statusEl.textContent = `Found ${entries.length} PDF${entries.length === 1 ? "" : "s"} in "${dirHandle.name}".`;
  } catch (err) {
    if (err.name === "AbortError") {
      statusEl.textContent = "Folder selection cancelled.";
      return;
    }
    statusEl.textContent = `Error: ${err.message || err}`;
    console.error(err);
  }
}

if (!("showDirectoryPicker" in window)) {
  statusEl.textContent =
    "This browser does not support the File System Access API (showDirectoryPicker). " +
    "Paperwork needs a Chromium browser with this API available.";
  pickBtn.disabled = true;
} else {
  pickBtn.addEventListener("click", handlePickFolder);
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((err) => {
      console.error("Service worker registration failed:", err);
    });
  });
}
