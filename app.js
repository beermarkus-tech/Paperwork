import {
  getCachedThumbnail,
  putCachedThumbnail,
  getStoredFolderHandle,
  setStoredFolderHandle,
} from "./idb.js";
import { renderFirstPageThumbnail } from "./pdf-thumbnails.js";
import { loadDocument, renderPageToCanvas } from "./pdf-viewer.js";
import { savePageRotation } from "./pdf-rotate.js";
import { renameFileHandle } from "./file-ops.js";

// Bumped by hand alongside sw.js's CACHE_NAME on every deploy, so the
// number on screen always identifies exactly which build is running.
const APP_VERSION = 22;
const appVersionEl = document.getElementById("app-version");
if (appVersionEl) appVersionEl.textContent = `· v${APP_VERSION}`;

const pickBtn = document.getElementById("pick-folder-btn");
const changeFolderBtn = document.getElementById("change-folder-btn");
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
const viewerSaveStatus = document.getElementById("viewer-save-status");
const pageNavPrev = document.getElementById("page-nav-prev");
const pageNavNext = document.getElementById("page-nav-next");
const renameInput = document.getElementById("rename-input");
const renameDateBtn = document.getElementById("rename-date-btn");
const renameChipsEl = document.getElementById("rename-chips");
const renameApplyBtn = document.getElementById("rename-apply-btn");
const renameStatusEl = document.getElementById("rename-status");
const dateModal = document.getElementById("date-modal");
const dateModalTitle = document.getElementById("date-modal-title");
const dateModalGrid = document.getElementById("date-modal-grid");
const datePrevBtn = document.getElementById("date-modal-prev-btn");
const dateNextBtn = document.getElementById("date-modal-next-btn");
const dateModalCancelBtn = document.getElementById("date-modal-cancel-btn");
const dateModalOkBtn = document.getElementById("date-modal-ok-btn");

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
      entries.push({ name, handle, file, size: file.size, lastModified: file.lastModified });
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

// Maps an entry to its thumbnail-strip elements so a background save (e.g.
// after a rotation) can refresh the thumbnail without a full folder rescan.
const entryElements = new Map();
let currentFolderName = null;
let currentDirHandle = null;

async function renderAndCacheThumbnail(folderName, entry, imgWrap) {
  const key = `${folderName}/${entry.name}`;
  try {
    const { blob, pageCount } = await renderFirstPageThumbnail(entry.file);
    entry.pageCount = pageCount;
    imgWrap.classList.remove("thumb-error");
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

async function refreshThumbnailFor(entry) {
  const elements = entryElements.get(entry);
  if (!elements || !currentFolderName) return;
  await renderAndCacheThumbnail(currentFolderName, entry, elements.imgWrap);
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
      await renderAndCacheThumbnail(folderName, entry, imgWrap);
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

// Rotation is view-only for now (not yet written back to the file — see
// Stage 5), but should still survive navigating away from a document and
// back within the current session. Keyed by filename so it outlives a
// document being closed and reopened; cleared when a new folder is loaded.
let rotationsByDocument = new Map();

function getRotationMapFor(entry) {
  let map = rotationsByDocument.get(entry.name);
  if (!map) {
    map = new Map();
    rotationsByDocument.set(entry.name, map);
  }
  return map;
}

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
  // Undefined (not yet in the map) tells pdf-viewer.js to use the page's own
  // intrinsic rotation; the returned value seeds the map so it reads as an
  // absolute rotation from here on, correctly starting from what's already
  // on disk rather than always assuming 0.
  const requestedRotation = viewerState.rotationByPage.get(viewerState.pageNumber);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const maxWidth = viewerStageEl.clientWidth * dpr;
  const maxHeight = viewerStageEl.clientHeight * dpr;

  const appliedRotation = await renderPageToCanvas(
    viewerState.pdf,
    viewerState.pageNumber,
    requestedRotation,
    viewerCanvas,
    maxWidth,
    maxHeight,
  );
  viewerState.rotationByPage.set(viewerState.pageNumber, appliedRotation);

  viewerIndicator.textContent = `${entry.name} — page ${viewerState.pageNumber} of ${viewerState.pdf.numPages}`;
  updatePageNavArrows();
}

function updatePageNavArrows() {
  const pdf = viewerState.pdf;
  pageNavPrev.hidden = !pdf || viewerState.pageNumber <= 1;
  pageNavNext.hidden = !pdf || viewerState.pageNumber >= pdf.numPages;
}

// --- Rotation persistence: debounced save + flush-on-navigate ---

const ROTATION_SAVE_DEBOUNCE_MS = 2500;
let pendingRotationSave = null; // { entry, pageNumber, rotation, timer }

function setSaveStatus(state) {
  // state: "saving" | "saved" | null
  viewerSaveStatus.hidden = !state;
  viewerSaveStatus.className = state ? `save-status ${state}` : "save-status";
}

function scheduleRotationSave(entry, pageNumber, rotation) {
  if (pendingRotationSave && pendingRotationSave.timer) {
    clearTimeout(pendingRotationSave.timer);
  }
  pendingRotationSave = {
    entry,
    pageNumber,
    rotation,
    timer: setTimeout(flushPendingRotationSave, ROTATION_SAVE_DEBOUNCE_MS),
  };
  setSaveStatus("saving");
}

async function flushPendingRotationSave() {
  if (!pendingRotationSave) return;
  const { entry, pageNumber, rotation, timer } = pendingRotationSave;
  clearTimeout(timer);
  pendingRotationSave = null;

  try {
    await savePageRotation(entry.handle, entry.file, pageNumber, rotation);
    entry.file = await entry.handle.getFile();
    entry.size = entry.file.size;
    entry.lastModified = entry.file.lastModified;
    setSaveStatus("saved");
    refreshThumbnailFor(entry).catch((err) => {
      console.error(`Failed to refresh thumbnail for ${entry.name}:`, err);
    });
  } catch (err) {
    console.error(`Failed to save rotation for ${entry.name}:`, err);
    setSaveStatus(null);
    statusEl.textContent = `⚠️ Couldn't save rotation for "${entry.name}": ${err.message || err}`;
  }
}

async function openDocumentAt(index) {
  flushPendingRotationSave();
  closeDateModal();

  if (viewerState.loadingTask) {
    const oldTask = viewerState.loadingTask;
    viewerState.loadingTask = null;
    viewerState.pdf = null;
    await oldTask.destroy().catch(() => {});
  }

  viewerState.index = index;
  viewerState.pageNumber = 1;
  pageNavPrev.hidden = true;
  pageNavNext.hidden = true;

  const entry = viewerState.entries[index];
  viewerState.rotationByPage = getRotationMapFor(entry);
  resetZoomPan();
  setSaveStatus(null);
  populateRenameBar(entry);

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
  flushPendingRotationSave();
  closeDateModal();
  viewerEl.hidden = true;
  if (viewerState.loadingTask) {
    const task = viewerState.loadingTask;
    viewerState.loadingTask = null;
    viewerState.pdf = null;
    await task.destroy().catch(() => {});
  }
}

// --- Rename bar ---
// Template chips are a fixed default set for now; making them user-editable
// is deferred to the destination-folder settings screen (next Stage 4 slice).
const RENAME_CHIPS = ["Invoice", "Receipt", "Statement", "Contract", "Insurance", "Medical", "Tax"];
const PDF_EXTENSION_RE = /\.pdf$/i;
const ILLEGAL_FILENAME_CHARS_RE = /[\\/:*?"<>|]/;

for (const chipText of RENAME_CHIPS) {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "rename-chip";
  chip.textContent = chipText;
  chip.addEventListener("click", () => {
    const current = renameInput.value.trim();
    renameInput.value = current ? `${current} ${chipText}` : chipText;
    renameInput.focus();
    setRenameStatus(null);
  });
  renameChipsEl.appendChild(chip);
}

function setRenameStatus(kind, message) {
  renameStatusEl.textContent = message || "";
  renameStatusEl.className = kind || "";
}

// Matches a date prefix this same UI would have inserted, so a later pick
// replaces it instead of stacking another date in front of it.
const DATE_PREFIX_RE = /^(\d{4}-\d{2}-\d{2})(?: - )?/;

function applyDateToFilename(dateStr) {
  const current = renameInput.value.trim();
  const match = current.match(DATE_PREFIX_RE);
  const rest = match ? current.slice(match[0].length) : current;
  renameInput.value = rest ? `${dateStr} - ${rest}` : dateStr;
  setRenameStatus(null);
}

function populateRenameBar(entry) {
  renameInput.value = entry.name.replace(PDF_EXTENSION_RE, "");
  setRenameStatus(null);
}

// Mobile Chrome sometimes repositions the cursor right after a tap-triggered
// focus, undoing a select() called synchronously inside the focus handler —
// deferring it a tick lets that happen first, so the selection sticks.
renameInput.addEventListener("focus", () => {
  setTimeout(() => renameInput.select(), 0);
});

// --- Custom date picker ---
// Android Chrome's native <input type="date"> picker only reports a value
// when the user taps a specific day in its grid — confirming the shown
// default/current selection with no interaction fires no event at all, so a
// plain OK tap would silently do nothing. Owning the whole calendar grid
// ourselves, with our own OK/Cancel, avoids that gap entirely: whatever day
// is highlighted when OK is tapped is what gets applied, full stop.
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAY_LABELS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

let pickerYear = 0;
let pickerMonth = 0; // 0-11
let pickerSelected = null; // { year, month, day }

function formatDateParts({ year, month, day }) {
  const mm = String(month + 1).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

function renderDateGrid() {
  dateModalTitle.textContent = `${MONTH_NAMES[pickerMonth]} ${pickerYear}`;
  dateModalGrid.innerHTML = "";

  for (const label of WEEKDAY_LABELS) {
    const cell = document.createElement("div");
    cell.className = "date-grid-weekday";
    cell.textContent = label;
    dateModalGrid.appendChild(cell);
  }

  const today = new Date();
  const startOffset = new Date(pickerYear, pickerMonth, 1).getDay();
  const daysInMonth = new Date(pickerYear, pickerMonth + 1, 0).getDate();

  for (let i = 0; i < startOffset; i += 1) {
    dateModalGrid.appendChild(document.createElement("div"));
  }

  for (let day = 1; day <= daysInMonth; day += 1) {
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "date-grid-day";
    cell.textContent = String(day);

    if (
      today.getFullYear() === pickerYear &&
      today.getMonth() === pickerMonth &&
      today.getDate() === day
    ) {
      cell.classList.add("today");
    }
    if (
      pickerSelected.year === pickerYear &&
      pickerSelected.month === pickerMonth &&
      pickerSelected.day === day
    ) {
      cell.classList.add("selected");
    }

    cell.addEventListener("click", () => {
      pickerSelected = { year: pickerYear, month: pickerMonth, day };
      renderDateGrid();
    });
    dateModalGrid.appendChild(cell);
  }
}

function closeDateModal() {
  dateModal.hidden = true;
}

renameDateBtn.addEventListener("click", () => {
  const current = renameInput.value.trim();
  const match = current.match(DATE_PREFIX_RE);
  if (match) {
    const [y, m, d] = match[1].split("-").map(Number);
    pickerSelected = { year: y, month: m - 1, day: d };
  } else {
    const now = new Date();
    pickerSelected = { year: now.getFullYear(), month: now.getMonth(), day: now.getDate() };
  }
  pickerYear = pickerSelected.year;
  pickerMonth = pickerSelected.month;
  renderDateGrid();
  dateModal.hidden = false;
});

datePrevBtn.addEventListener("click", () => {
  pickerMonth -= 1;
  if (pickerMonth < 0) {
    pickerMonth = 11;
    pickerYear -= 1;
  }
  renderDateGrid();
});

dateNextBtn.addEventListener("click", () => {
  pickerMonth += 1;
  if (pickerMonth > 11) {
    pickerMonth = 0;
    pickerYear += 1;
  }
  renderDateGrid();
});

dateModalCancelBtn.addEventListener("click", closeDateModal);

dateModal.addEventListener("click", (e) => {
  if (e.target === dateModal) closeDateModal();
});

dateModalOkBtn.addEventListener("click", () => {
  applyDateToFilename(formatDateParts(pickerSelected));
  closeDateModal();
});

renameApplyBtn.addEventListener("click", () => {
  commitRename().catch((err) => {
    console.error("Failed to rename file:", err);
    setRenameStatus("error", `⚠️ ${err.message || err}`);
  });
});

async function commitRename() {
  if (!viewerState.pdf || !currentDirHandle) return;
  const entry = viewerState.entries[viewerState.index];
  const trimmed = renameInput.value.trim();

  if (!trimmed) {
    setRenameStatus("error", "Filename can't be empty.");
    return;
  }
  if (ILLEGAL_FILENAME_CHARS_RE.test(trimmed)) {
    setRenameStatus("error", `Filename can't contain \\ / : * ? " < > |`);
    return;
  }

  const newName = `${trimmed}.pdf`;
  const oldName = entry.name;
  if (newName === oldName) {
    setRenameStatus(null);
    return;
  }
  const collision = viewerState.entries.some((other) => other !== entry && other.name === newName);
  if (collision) {
    setRenameStatus("error", `"${newName}" already exists in this folder.`);
    return;
  }

  renameApplyBtn.disabled = true;
  setRenameStatus(null, "Renaming…");
  try {
    entry.handle = await renameFileHandle(currentDirHandle, entry.handle, oldName, newName);
    entry.name = newName;
    entry.file = await entry.handle.getFile();
    entry.size = entry.file.size;
    entry.lastModified = entry.file.lastModified;

    const oldRotationMap = rotationsByDocument.get(oldName);
    rotationsByDocument.delete(oldName);
    if (oldRotationMap) rotationsByDocument.set(newName, oldRotationMap);

    if (currentFolderName) {
      const oldCached = await getCachedThumbnail(`${currentFolderName}/${oldName}`);
      if (oldCached) {
        await putCachedThumbnail({ ...oldCached, key: `${currentFolderName}/${newName}` });
      }
    }

    const elements = entryElements.get(entry);
    if (elements) {
      const caption = elements.item.querySelector(".thumb-caption");
      if (caption) caption.textContent = newName;
    }

    viewerIndicator.textContent = `${entry.name} — page ${viewerState.pageNumber} of ${viewerState.pdf.numPages}`;
    setRenameStatus("success", "Renamed.");
  } finally {
    renameApplyBtn.disabled = false;
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
  flushPendingRotationSave();
  animateNavigation("x", delta, async () => {
    viewerState.pageNumber = next;
    resetZoomPan();
    setSaveStatus(null);
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
  const next = (current + 90) % 360;
  viewerState.rotationByPage.set(viewerState.pageNumber, next);
  resetZoomPan();
  renderCurrentPage().catch((err) => console.error("Failed to render page:", err));

  const entry = viewerState.entries[viewerState.index];
  scheduleRotationSave(entry, viewerState.pageNumber, next);
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

let pendingReconnectHandle = null;

function updateFolderButtons() {
  if (pendingReconnectHandle) {
    pickBtn.textContent = `Reconnect to "${pendingReconnectHandle.name}"…`;
    changeFolderBtn.hidden = false;
  } else {
    pickBtn.textContent = "Choose inbox folder…";
    changeFolderBtn.hidden = true;
  }
}

async function loadFolder(dirHandle) {
  // Flip the button/link state immediately — before the (potentially slow)
  // scan and thumbnail generation — since access is already confirmed at
  // this point and there's no reason to keep showing "Reconnect…" while it runs.
  pendingReconnectHandle = null;
  updateFolderButtons();

  statusEl.textContent = `Scanning "${dirHandle.name}"…`;

  const entries = await collectPdfEntries(dirHandle);
  statusEl.textContent = `Found ${entries.length} PDF${entries.length === 1 ? "" : "s"} in "${dirHandle.name}".`;

  rotationsByDocument = new Map();
  entryElements.clear();
  currentFolderName = dirHandle.name;
  currentDirHandle = dirHandle;
  stripEl.innerHTML = "";
  if (entries.length === 0) {
    resultsEl.hidden = true;
  } else {
    const elements = entries.map((entry, index) => {
      const { item, imgWrap } = buildThumbnailItem(entry, () => openViewer(entries, index));
      stripEl.appendChild(item);
      entryElements.set(entry, { item, imgWrap });
      return { item, imgWrap };
    });
    resultsEl.hidden = false;

    await generateThumbnails(dirHandle.name, entries, elements);
    statusEl.textContent = `Found ${entries.length} PDF${entries.length === 1 ? "" : "s"} in "${dirHandle.name}".`;
  }
}

async function pickNewFolder() {
  statusEl.textContent = "Waiting for folder selection…";
  try {
    const dirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
    await setStoredFolderHandle(dirHandle).catch((err) => {
      console.error("Failed to store folder handle for next launch:", err);
    });
    await loadFolder(dirHandle);
  } catch (err) {
    if (err.name === "AbortError") {
      statusEl.textContent = "Folder selection cancelled.";
      return;
    }
    statusEl.textContent = `Error: ${err.message || err}`;
    console.error(err);
  }
}

async function reconnectFolder(handle) {
  statusEl.textContent = `Requesting access to "${handle.name}"…`;
  try {
    const permission = await handle.requestPermission({ mode: "readwrite" });
    if (permission !== "granted") {
      statusEl.textContent = `Access to "${handle.name}" wasn't granted. Choose a folder to continue.`;
      pendingReconnectHandle = null;
      updateFolderButtons();
      return;
    }
    await loadFolder(handle);
  } catch (err) {
    statusEl.textContent = `Error: ${err.message || err}`;
    console.error(err);
  }
}

async function attemptAutoReconnect() {
  let stored;
  try {
    stored = await getStoredFolderHandle();
  } catch (err) {
    console.error("Failed to read stored folder handle:", err);
    return;
  }
  if (!stored || !("queryPermission" in stored)) return;

  let permission;
  try {
    permission = await stored.queryPermission({ mode: "readwrite" });
  } catch (err) {
    console.error("Failed to query permission for stored folder handle:", err);
    return;
  }

  if (permission === "granted") {
    statusEl.textContent = `Reconnected to "${stored.name}". Scanning…`;
    loadFolder(stored).catch((err) => {
      statusEl.textContent = `Error: ${err.message || err}`;
      console.error(err);
    });
  } else {
    pendingReconnectHandle = stored;
    updateFolderButtons();
    statusEl.textContent = `Tap to reconfirm access to "${stored.name}".`;
  }
}

if (!("showDirectoryPicker" in window)) {
  statusEl.textContent =
    "This browser does not support the File System Access API (showDirectoryPicker). " +
    "Paperwork needs a Chromium browser with this API available.";
  pickBtn.disabled = true;
} else {
  pickBtn.addEventListener("click", () => {
    if (pendingReconnectHandle) {
      reconnectFolder(pendingReconnectHandle);
    } else {
      pickNewFolder();
    }
  });
  changeFolderBtn.addEventListener("click", pickNewFolder);
  attemptAutoReconnect();
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((err) => {
      console.error("Service worker registration failed:", err);
    });
  });
}
