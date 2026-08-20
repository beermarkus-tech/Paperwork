import {
  getCachedThumbnail,
  putCachedThumbnail,
  getStoredFolderHandle,
  setStoredFolderHandle,
  getStoredDestinations,
  setStoredDestinations,
  getStoredChipLabels,
  setStoredChipLabels,
} from "./idb.js";
import { renderFirstPageThumbnail } from "./pdf-thumbnails.js";
import { loadDocument, renderPageToCanvas } from "./pdf-viewer.js";
import { savePageRotation } from "./pdf-rotate.js";
import { deletePageFromFile, restoreFileBytes, splitPdfIntoPages, joinPdfFiles } from "./pdf-pages.js";
import { renameFileHandle, moveFileHandle, fileExistsInDir } from "./file-ops.js";

// Bumped by hand alongside sw.js's CACHE_NAME on every deploy, so the
// number on screen always identifies exactly which build is running.
const APP_VERSION = 38;
const appVersionEl = document.getElementById("app-version");
if (appVersionEl) appVersionEl.textContent = `· v${APP_VERSION}`;

const pickBtn = document.getElementById("pick-folder-btn");
const changeFolderBtn = document.getElementById("change-folder-btn");
const statusEl = document.getElementById("status");
const progressEl = document.getElementById("progress");
const resultsEl = document.getElementById("results");
const resultsHeading = document.getElementById("results-heading");
const stripEl = document.getElementById("thumbnail-strip");
const splitBtn = document.getElementById("split-btn");
const joinBtn = document.getElementById("join-btn");
const batchToast = document.getElementById("batch-toast");
const batchToastText = document.getElementById("batch-toast-text");
const batchToastBtn = document.getElementById("batch-toast-btn");

const destinationsScreen = document.getElementById("destinations-screen");
const destinationsList = document.getElementById("destinations-list");
const destinationsAddInput = document.getElementById("destinations-add-input");
const destinationsAddBtn = document.getElementById("destinations-add-btn");
const destinationsStatusEl = document.getElementById("destinations-status");
const destinationsDoneBtn = document.getElementById("destinations-done-btn");

const destinationBarEl = document.getElementById("destination-bar");
const editDestinationsBtn = document.getElementById("edit-destinations-btn");
const undoToast = document.getElementById("undo-toast");
const undoToastText = document.getElementById("undo-toast-text");
const undoToastBtn = document.getElementById("undo-toast-btn");

const viewerEl = document.getElementById("viewer");
const viewerStageEl = document.getElementById("viewer-stage");
const viewerCanvas = document.getElementById("viewer-canvas");
const viewerIndicator = document.getElementById("viewer-indicator");
const viewerCloseBtn = document.getElementById("viewer-close-btn");
const viewerRotateBtn = document.getElementById("viewer-rotate-btn");
const viewerSaveStatus = document.getElementById("viewer-save-status");
const pageNavPrev = document.getElementById("page-nav-prev");
const pageNavNext = document.getElementById("page-nav-next");
const deletePageBtn = document.getElementById("delete-page-btn");
const renameInput = document.getElementById("rename-input");
const renameDateBtn = document.getElementById("rename-date-btn");
const renameChipsEl = document.getElementById("rename-chips");
const editChipsBtn = document.getElementById("edit-chips-btn");
const renameApplyBtn = document.getElementById("rename-apply-btn");
const renameStatusEl = document.getElementById("rename-status");

const chipsScreen = document.getElementById("chips-screen");
const chipsList = document.getElementById("chips-list");
const chipsAddInput = document.getElementById("chips-add-input");
const chipsAddBtn = document.getElementById("chips-add-btn");
const chipsStatusEl = document.getElementById("chips-status");
const chipsDoneBtn = document.getElementById("chips-done-btn");
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
    if (batchMode) {
      toggleBatchSelection(entry);
      return;
    }
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

// --- Split & join (batch mode on the thumbnail grid) ---
// "batchMode" arms one of the two buttons; a second tap on the same button
// confirms whatever's selected (or, with nothing selected, just cancels).
// Split only ever keeps one entry selected — tapping a different one moves
// the selection rather than adding to it. Join keeps an ordered list, shown
// as numbered badges, so the join order matches tap order.
let batchMode = null; // "split" | "join" | null
let batchSelection = [];

function updateBatchButtons() {
  splitBtn.textContent = batchMode === "split" ? "✓" : "✂️";
  splitBtn.classList.toggle("armed", batchMode === "split");
  splitBtn.disabled = batchMode === "join";
  joinBtn.textContent = batchMode === "join" ? "✓" : "🔗";
  joinBtn.classList.toggle("armed", batchMode === "join");
  joinBtn.disabled = batchMode === "split";
}

function renderBatchSelection() {
  for (const { item, imgWrap } of entryElements.values()) {
    item.classList.remove("batch-selected");
    const badge = imgWrap.querySelector(".batch-badge");
    if (badge) badge.remove();
  }
  batchSelection.forEach((entry, i) => {
    const elements = entryElements.get(entry);
    if (!elements) return;
    elements.item.classList.add("batch-selected");
    if (batchMode === "join") {
      const badge = document.createElement("span");
      badge.className = "batch-badge";
      badge.textContent = String(i + 1);
      elements.imgWrap.appendChild(badge);
    }
  });
}

function toggleBatchSelection(entry) {
  const idx = batchSelection.indexOf(entry);
  if (idx !== -1) {
    batchSelection.splice(idx, 1);
  } else if (batchMode === "split") {
    batchSelection = [entry];
  } else {
    batchSelection.push(entry);
  }
  renderBatchSelection();
}

function enterBatchMode(mode) {
  batchMode = mode;
  batchSelection = [];
  renderBatchSelection();
  updateBatchButtons();
  statusEl.textContent =
    mode === "split" ? "Tap a PDF to split it into pages." : "Tap PDFs in the order to join them, then tap Join again.";
}

function exitBatchMode() {
  batchMode = null;
  batchSelection = [];
  renderBatchSelection();
  updateBatchButtons();
  statusEl.textContent = "";
}

function zeroPad(n, width) {
  return String(n).padStart(width, "0");
}

async function performSplit(entry) {
  const oldName = entry.name;
  const baseName = oldName.replace(PDF_EXTENSION_RE, "");

  let pages;
  try {
    pages = await splitPdfIntoPages(entry.file);
  } catch (err) {
    statusEl.textContent = `⚠️ Couldn't split "${oldName}": ${err.message || err}`;
    return;
  }

  const width = String(pages.length).length;
  const targetNames = pages.map((_, i) => `${baseName} ${zeroPad(i + 1, width)}.pdf`);
  for (const name of targetNames) {
    if (await fileExistsInDir(currentDirHandle, name)) {
      statusEl.textContent = `⚠️ Can't split: "${name}" already exists in this folder.`;
      return;
    }
  }

  const backupBytes = await entry.file.arrayBuffer();
  try {
    for (let i = 0; i < targetNames.length; i += 1) {
      const handle = await currentDirHandle.getFileHandle(targetNames[i], { create: true });
      const writable = await handle.createWritable();
      try {
        await writable.write(pages[i]);
      } finally {
        await writable.close();
      }
    }
    await currentDirHandle.removeEntry(oldName);
  } catch (err) {
    for (const name of targetNames) {
      await currentDirHandle.removeEntry(name).catch(() => {});
    }
    statusEl.textContent = `⚠️ Couldn't split "${oldName}": ${err.message || err}`;
    return;
  }

  const dirHandle = currentDirHandle;
  statusEl.textContent = "";
  gridToast.show(`Split "${oldName}" into ${targetNames.length} pages`, {
    restore: async () => {
      for (const name of targetNames) {
        await dirHandle.removeEntry(name).catch(() => {});
      }
      const newHandle = await dirHandle.getFileHandle(oldName, { create: true });
      await restoreFileBytes(newHandle, backupBytes);
      await loadFolder(dirHandle);
    },
  });

  await loadFolder(dirHandle);
}

async function performJoin(entries) {
  const firstEntry = entries[0];
  const baseName = firstEntry.name.replace(PDF_EXTENSION_RE, "");
  const targetName = `${baseName} joined.pdf`;

  if (await fileExistsInDir(currentDirHandle, targetName)) {
    statusEl.textContent = `⚠️ Can't join: "${targetName}" already exists in this folder.`;
    return;
  }

  let joinedBytes;
  try {
    joinedBytes = await joinPdfFiles(entries.map((e) => e.file));
  } catch (err) {
    statusEl.textContent = `⚠️ Couldn't join PDFs: ${err.message || err}`;
    return;
  }

  const originalNames = entries.map((e) => e.name);
  const backups = await Promise.all(entries.map((e) => e.file.arrayBuffer()));

  const dirHandle = currentDirHandle;
  try {
    const handle = await dirHandle.getFileHandle(targetName, { create: true });
    const writable = await handle.createWritable();
    try {
      await writable.write(joinedBytes);
    } finally {
      await writable.close();
    }
    for (const name of originalNames) {
      await dirHandle.removeEntry(name);
    }
  } catch (err) {
    await dirHandle.removeEntry(targetName).catch(() => {});
    statusEl.textContent = `⚠️ Couldn't join PDFs: ${err.message || err}`;
    return;
  }

  statusEl.textContent = "";
  gridToast.show(`Joined ${entries.length} PDFs into "${targetName}"`, {
    restore: async () => {
      await dirHandle.removeEntry(targetName).catch(() => {});
      for (let i = 0; i < originalNames.length; i += 1) {
        const handle = await dirHandle.getFileHandle(originalNames[i], { create: true });
        await restoreFileBytes(handle, backups[i]);
      }
      await loadFolder(dirHandle);
    },
  });

  await loadFolder(dirHandle);
}

splitBtn.addEventListener("click", () => {
  if (batchMode !== "split") {
    enterBatchMode("split");
    return;
  }
  if (batchSelection.length === 0) {
    exitBatchMode();
    return;
  }
  const entry = batchSelection[0];
  if (entry.pageCount === 1) {
    gridToast.show(`"${entry.name}" only has one page — nothing to split.`, { duration: 3000 });
    return;
  }
  exitBatchMode();
  performSplit(entry).catch((err) => {
    console.error(`Failed to split "${entry.name}":`, err);
    statusEl.textContent = `⚠️ Couldn't split "${entry.name}": ${err.message || err}`;
  });
});

joinBtn.addEventListener("click", () => {
  if (batchMode !== "join") {
    enterBatchMode("join");
    return;
  }
  if (batchSelection.length < 2) {
    exitBatchMode();
    return;
  }
  const entries = [...batchSelection];
  exitBatchMode();
  performJoin(entries).catch((err) => {
    console.error("Failed to join PDFs:", err);
    statusEl.textContent = `⚠️ Couldn't join PDFs: ${err.message || err}`;
  });
});

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

  viewerIndicator.textContent = `Page ${viewerState.pageNumber} of ${viewerState.pdf.numPages}`;
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
  disarmDelete();
  viewerEl.classList.remove("keyboard-open");

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

  viewerIndicator.textContent = "Loading…";

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
  disarmDelete();
  viewerEl.classList.remove("keyboard-open");
  viewerEl.hidden = true;
  if (viewerState.loadingTask) {
    const task = viewerState.loadingTask;
    viewerState.loadingTask = null;
    viewerState.pdf = null;
    await task.destroy().catch(() => {});
  }
}

// --- Rename bar ---
const DEFAULT_CHIP_LABELS = ["Invoice", "Receipt", "Statement", "Contract", "Insurance", "Medical", "Tax"];
const PDF_EXTENSION_RE = /\.pdf$/i;
const ILLEGAL_FILENAME_CHARS_RE = /[\\/:*?"<>|]/;

let chipLabels = DEFAULT_CHIP_LABELS;

function renderRenameChips() {
  renameChipsEl.innerHTML = "";
  for (const chipText of chipLabels) {
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
}

renderRenameChips();

function setRenameStatus(kind, message) {
  renameStatusEl.textContent = message || "";
  renameStatusEl.className = kind || "";
}

// state: "saving" | "success" | null. Mirrors the rotation save indicator's
// spinner/checkmark pattern, but on the rename button itself rather than a
// separate status line, since the button already reads as a checkmark.
function setRenameButtonState(state) {
  renameApplyBtn.classList.remove("saving", "success");
  if (state) renameApplyBtn.classList.add(state);
}

// Matches a date prefix this same UI would have inserted, so a later pick
// replaces it instead of stacking another date in front of it. The
// separator is matched loosely (any whitespace, an optional single dash,
// any whitespace) so it absorbs both the current plain-space style and any
// dash-separated prefix left over from an older version or manual editing —
// applyDateToFilename always rejoins with a single space, never a dash.
const DATE_PREFIX_RE = /^(\d{4}-\d{2}-\d{2})\s*-?\s*/;

function applyDateToFilename(dateStr) {
  const current = renameInput.value.trim();
  const match = current.match(DATE_PREFIX_RE);
  const rest = (match ? current.slice(match[0].length) : current).trim();
  renameInput.value = rest ? `${dateStr} ${rest}` : dateStr;
  setRenameStatus(null);
}

function populateRenameBar(entry) {
  renameInput.value = entry.name.replace(PDF_EXTENSION_RE, "");
  setRenameStatus(null);
  setRenameButtonState(null);
  renderDestinationBar();
}

// Mobile Chrome sometimes repositions the cursor right after a tap-triggered
// focus, undoing a select() called synchronously inside the focus handler —
// deferring it a tick lets that happen first, so the selection sticks.
renameInput.addEventListener("focus", () => {
  setTimeout(() => renameInput.select(), 0);
});

// Hides the PDF preview (and shows the chip labels in its place) while the
// on-screen keyboard is actually up. Driven by VisualViewport rather than
// focus/blur on the filename field: dismissing the keyboard via the
// system back gesture/button, or the keyboard's own close control, doesn't
// reliably blur the input on Android — the field can stay logically
// focused with the keyboard gone, which left the preview stuck hidden.
// Comparing the visual viewport's height against the layout viewport's
// reflects the keyboard's real on-screen state regardless of how it closes.
if (window.visualViewport) {
  const KEYBOARD_HEIGHT_THRESHOLD = 150;
  window.visualViewport.addEventListener("resize", () => {
    const keyboardOpen = window.innerHeight - window.visualViewport.height > KEYBOARD_HEIGHT_THRESHOLD;
    viewerEl.classList.toggle("keyboard-open", keyboardOpen);
  });
}

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
    setRenameButtonState(null);
    setRenameStatus("error", `⚠️ ${err.message || err}`);
  });
});

async function commitRename() {
  if (!viewerState.pdf || !currentDirHandle) return;
  const entry = viewerState.entries[viewerState.index];
  const trimmed = renameInput.value.trim();
  setRenameStatus(null);
  setRenameButtonState(null);

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
  setRenameButtonState("saving");
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

    setRenameButtonState("success");
  } finally {
    renameApplyBtn.disabled = false;
  }
}

// --- Shared "manage a list of short text labels" sheet pattern ---
// Destination folders and rename chips are two instances of the same UI
// (a list with per-row remove buttons, plus an add row); this renders
// either one into its container.
function renderSettingsList(containerEl, items, emptyText, onRemove) {
  containerEl.innerHTML = "";
  if (items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "settings-empty";
    empty.textContent = emptyText;
    containerEl.appendChild(empty);
    return;
  }
  for (const name of items) {
    const row = document.createElement("div");
    row.className = "settings-row";

    const nameEl = document.createElement("span");
    nameEl.className = "settings-row-name";
    nameEl.textContent = name;
    row.appendChild(nameEl);

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "settings-row-remove";
    removeBtn.setAttribute("aria-label", `Remove ${name}`);
    removeBtn.textContent = "✕";
    removeBtn.addEventListener("click", () => onRemove(name));
    row.appendChild(removeBtn);

    containerEl.appendChild(row);
  }
}

function setStatusText(el, kind, message) {
  el.textContent = message || "";
  el.className = kind || "";
}

// --- Destination folders & tap-to-file ---

let destinations = [];

function renderDestinationsList() {
  renderSettingsList(destinationsList, destinations, "No destinations yet — add one below.", removeDestination);
}

function renderDestinationBar() {
  destinationBarEl.innerHTML = "";
  for (const name of destinations) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "destination-btn";
    btn.textContent = name;
    btn.addEventListener("click", () => {
      fileCurrentDocumentTo(name).catch((err) => {
        console.error(`Failed to file into "${name}":`, err);
        setRenameStatus("error", `⚠️ ${err.message || err}`);
      });
    });
    destinationBarEl.appendChild(btn);
  }
}

async function collectSubfolderNames(dirHandle) {
  const names = [];
  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind === "directory") names.push(name);
  }
  names.sort((a, b) => a.localeCompare(b));
  return names;
}

// Two-way sync between the stored destinations list and the folders that
// actually exist inside dirHandle: subfolders already sitting in the inbox
// (created outside the app, or from a previous session with a different
// inbox folder) are imported into the list and the viewer's destination
// bar; anything already in the list that this particular folder doesn't
// have yet gets created, same as before.
async function syncDestinationsWithFolder(dirHandle) {
  let onDisk;
  try {
    onDisk = await collectSubfolderNames(dirHandle);
  } catch (err) {
    console.error("Failed to scan for existing subfolders:", err);
    onDisk = [];
  }

  let changed = false;
  for (const name of onDisk) {
    if (!destinations.includes(name)) {
      destinations = [...destinations, name];
      changed = true;
    }
  }
  if (changed) {
    renderDestinationsList();
    renderDestinationBar();
    try {
      await setStoredDestinations(destinations);
    } catch (err) {
      console.error("Failed to persist destinations:", err);
    }
  }

  for (const name of destinations) {
    if (!onDisk.includes(name)) {
      try {
        await dirHandle.getDirectoryHandle(name, { create: true });
      } catch (err) {
        console.error(`Failed to ensure destination folder "${name}" exists:`, err);
      }
    }
  }
}

async function removeDestination(name) {
  destinations = destinations.filter((d) => d !== name);
  renderDestinationsList();
  renderDestinationBar();
  try {
    await setStoredDestinations(destinations);
  } catch (err) {
    console.error("Failed to persist destinations:", err);
  }
}

function setDestinationsStatus(kind, message) {
  setStatusText(destinationsStatusEl, kind, message);
}

async function addDestination() {
  const name = destinationsAddInput.value.trim();
  setDestinationsStatus(null);

  if (!name) return;
  if (ILLEGAL_FILENAME_CHARS_RE.test(name)) {
    setDestinationsStatus("error", `Name can't contain \\ / : * ? " < > |`);
    return;
  }
  if (destinations.includes(name)) {
    setDestinationsStatus("error", `"${name}" is already in the list.`);
    return;
  }

  destinationsAddBtn.disabled = true;
  try {
    await currentDirHandle.getDirectoryHandle(name, { create: true });
    destinations = [...destinations, name];
    await setStoredDestinations(destinations);
    renderDestinationsList();
    renderDestinationBar();
    destinationsAddInput.value = "";
  } catch (err) {
    console.error(`Failed to create destination folder "${name}":`, err);
    setDestinationsStatus("error", `⚠️ ${err.message || err}`);
  } finally {
    destinationsAddBtn.disabled = false;
  }
}

editDestinationsBtn.addEventListener("click", () => {
  renderDestinationsList();
  setDestinationsStatus(null);
  destinationsScreen.hidden = false;
});

destinationsDoneBtn.addEventListener("click", () => {
  destinationsScreen.hidden = true;
});

destinationsAddBtn.addEventListener("click", () => {
  addDestination();
});

destinationsAddInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    addDestination();
  }
});

// --- Rename chip labels (editable) ---

function renderChipsList() {
  renderSettingsList(chipsList, chipLabels, "No chip labels yet — add one below.", removeChipLabel);
}

function setChipsStatus(kind, message) {
  setStatusText(chipsStatusEl, kind, message);
}

async function removeChipLabel(label) {
  chipLabels = chipLabels.filter((l) => l !== label);
  renderChipsList();
  renderRenameChips();
  try {
    await setStoredChipLabels(chipLabels);
  } catch (err) {
    console.error("Failed to persist chip labels:", err);
  }
}

async function addChipLabel() {
  const label = chipsAddInput.value.trim();
  setChipsStatus(null);

  if (!label) return;
  if (chipLabels.includes(label)) {
    setChipsStatus("error", `"${label}" is already in the list.`);
    return;
  }

  chipsAddBtn.disabled = true;
  try {
    chipLabels = [...chipLabels, label];
    await setStoredChipLabels(chipLabels);
    renderChipsList();
    renderRenameChips();
    chipsAddInput.value = "";
  } catch (err) {
    console.error("Failed to persist chip labels:", err);
    setChipsStatus("error", `⚠️ ${err.message || err}`);
  } finally {
    chipsAddBtn.disabled = false;
  }
}

editChipsBtn.addEventListener("click", () => {
  renderChipsList();
  setChipsStatus(null);
  chipsScreen.hidden = false;
});

chipsDoneBtn.addEventListener("click", () => {
  chipsScreen.hidden = true;
});

chipsAddBtn.addEventListener("click", () => {
  addChipLabel();
});

chipsAddInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    addChipLabel();
  }
});

function setDestinationBarDisabled(disabled) {
  for (const btn of destinationBarEl.querySelectorAll("button")) {
    btn.disabled = disabled;
  }
}

function removeEntryFromViewer(entry, name) {
  const idx = viewerState.entries.indexOf(entry);
  if (idx !== -1) viewerState.entries.splice(idx, 1);
  const elements = entryElements.get(entry);
  if (elements) {
    elements.item.remove();
    entryElements.delete(entry);
  }
  rotationsByDocument.delete(name);
}

function advanceAfterFiling(index) {
  if (viewerState.entries.length === 0) {
    closeViewer();
    resultsEl.hidden = true;
    if (currentFolderName) {
      statusEl.textContent = `No PDFs found in "${currentFolderName}".`;
    }
    return;
  }
  const nextIndex = Math.min(index, viewerState.entries.length - 1);
  openDocumentAt(nextIndex).catch((err) => {
    console.error("Failed to open next document after filing:", err);
  });
}

async function fileCurrentDocumentTo(destinationName) {
  if (!viewerState.pdf || !currentDirHandle) return;
  const entry = viewerState.entries[viewerState.index];
  const index = viewerState.index;
  const trimmed = renameInput.value.trim();
  setRenameStatus(null);

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
  const sourceDirHandle = currentDirHandle;

  await flushPendingRotationSave();

  let destDirHandle;
  try {
    destDirHandle = await sourceDirHandle.getDirectoryHandle(destinationName, { create: true });
  } catch (err) {
    setRenameStatus("error", `Couldn't open "${destinationName}": ${err.message || err}`);
    return;
  }

  const collision = await fileExistsInDir(destDirHandle, newName);
  if (collision) {
    setRenameStatus("error", `"${newName}" already exists in "${destinationName}".`);
    return;
  }

  setDestinationBarDisabled(true);
  renameApplyBtn.disabled = true;
  try {
    const newHandle = await moveFileHandle(sourceDirHandle, entry.handle, oldName, destDirHandle, newName);
    removeEntryFromViewer(entry, oldName);
    viewerToast.show(`Filed to "${destinationName}"`, {
      restore: async () => {
        await moveFileHandle(destDirHandle, newHandle, newName, sourceDirHandle, oldName);
        if (!viewerEl.hidden) await closeViewer();
        if (sourceDirHandle === currentDirHandle) {
          await loadFolder(currentDirHandle);
        }
      },
    });
    advanceAfterFiling(index);
  } finally {
    setDestinationBarDisabled(false);
    renameApplyBtn.disabled = false;
  }
}

// A single "last action" undo slot per toast, good for one step back. Each
// action supplies its own restore closure rather than the toast knowing
// about every action type, so adding another undoable action later doesn't
// mean growing a dispatch switch here. Two instances exist: one scoped to
// the viewer (filing, page/document deletion) and one for the thumbnail
// grid (split/join) — they can't share a DOM element since the viewer's
// toast lives inside #viewer-stage, hidden whenever the grid is showing.
function createToast(toastEl, textEl, btnEl) {
  let timer = null;
  let pendingRestore = null;

  function hide() {
    toastEl.hidden = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    pendingRestore = null;
  }

  function show(message, { restore = null, duration = 5000 } = {}) {
    pendingRestore = restore;
    textEl.textContent = message;
    btnEl.hidden = !restore;
    toastEl.hidden = false;
    if (timer) clearTimeout(timer);
    timer = setTimeout(hide, duration);
  }

  btnEl.addEventListener("click", async () => {
    if (!pendingRestore) return;
    const restore = pendingRestore;
    hide();
    try {
      await restore();
    } catch (err) {
      console.error("Failed to undo:", err);
      statusEl.textContent = `⚠️ Couldn't undo: ${err.message || err}`;
    }
  });

  return { show, hide };
}

const viewerToast = createToast(undoToast, undoToastText, undoToastBtn);
const gridToast = createToast(batchToast, batchToastText, batchToastBtn);

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
  disarmDelete();
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

// --- Page deletion: tap arms the trash icon, a second tap on the same
// page confirms. Disarms on any navigation so a later, unrelated tap can
// never land as a confirm. ---

let armedDeletePage = null; // { entry, pageNumber } while armed
let armedDeleteTimer = null;
const DELETE_ARM_TIMEOUT_MS = 3000;

function disarmDelete() {
  armedDeletePage = null;
  deletePageBtn.classList.remove("armed");
  if (armedDeleteTimer) {
    clearTimeout(armedDeleteTimer);
    armedDeleteTimer = null;
  }
}

function armDelete(entry, pageNumber) {
  armedDeletePage = { entry, pageNumber };
  deletePageBtn.classList.add("armed");
  if (armedDeleteTimer) clearTimeout(armedDeleteTimer);
  armedDeleteTimer = setTimeout(disarmDelete, DELETE_ARM_TIMEOUT_MS);
}

deletePageBtn.addEventListener("click", () => {
  if (!viewerState.pdf) return;
  const entry = viewerState.entries[viewerState.index];
  const pageNumber = viewerState.pageNumber;

  if (armedDeletePage && armedDeletePage.entry === entry && armedDeletePage.pageNumber === pageNumber) {
    disarmDelete();
    performPageDelete(entry, pageNumber).catch((err) => {
      console.error("Failed to delete page:", err);
      statusEl.textContent = `⚠️ Couldn't delete page: ${err.message || err}`;
    });
  } else {
    armDelete(entry, pageNumber);
  }
});

async function performPageDelete(entry, pageNumber) {
  const index = viewerState.index;
  const oldName = entry.name;
  const wasOnlyPage = viewerState.pdf.numPages === 1;

  await flushPendingRotationSave();
  const backupBytes = await entry.file.arrayBuffer();

  if (wasOnlyPage) {
    await currentDirHandle.removeEntry(oldName);
    removeEntryFromViewer(entry, oldName);
    viewerToast.show(`Deleted "${oldName}"`, {
      restore: async () => {
        const newHandle = await currentDirHandle.getFileHandle(oldName, { create: true });
        await restoreFileBytes(newHandle, backupBytes);
        if (!viewerEl.hidden) await closeViewer();
        await loadFolder(currentDirHandle);
      },
    });
    advanceAfterFiling(index);
    return;
  }

  const newPageCount = await deletePageFromFile(entry.handle, entry.file, pageNumber);
  entry.file = await entry.handle.getFile();
  entry.size = entry.file.size;
  entry.lastModified = entry.file.lastModified;

  // Rotation state is keyed by page number: pages after the deleted one
  // shift down by one, and the deleted page's own entry is dropped. The
  // rest of the document (including everyone else's rotation) lives in the
  // bytes themselves, so nothing else needs to change here.
  const shifted = new Map();
  for (const [pn, rot] of getRotationMapFor(entry)) {
    if (pn < pageNumber) shifted.set(pn, rot);
    else if (pn > pageNumber) shifted.set(pn - 1, rot);
  }
  rotationsByDocument.set(entry.name, shifted);
  viewerState.rotationByPage = shifted;

  const oldTask = viewerState.loadingTask;
  viewerState.loadingTask = null;
  viewerState.pdf = null;
  await oldTask.destroy().catch(() => {});

  const { pdf, loadingTask } = await loadDocument(entry.file);
  viewerState.pdf = pdf;
  viewerState.loadingTask = loadingTask;
  viewerState.pageNumber = Math.min(pageNumber, newPageCount);
  resetZoomPan();
  await renderCurrentPage();

  refreshThumbnailFor(entry).catch((err) => {
    console.error(`Failed to refresh thumbnail for ${entry.name}:`, err);
  });

  viewerToast.show(`Deleted page ${pageNumber}`, {
    restore: async () => {
      await restoreFileBytes(entry.handle, backupBytes);
      entry.file = await entry.handle.getFile();
      entry.size = entry.file.size;
      entry.lastModified = entry.file.lastModified;
      // The restored bytes carry their own original rotations; simplest to
      // drop the in-session map for this document and let it be re-read from
      // the file (same as opening a document for the first time) rather than
      // trying to un-shift it back into place by hand.
      rotationsByDocument.delete(entry.name);
      refreshThumbnailFor(entry).catch((err) => {
        console.error(`Failed to refresh thumbnail for ${entry.name}:`, err);
      });
      if (!viewerEl.hidden && viewerState.entries[viewerState.index] === entry) {
        await openDocumentAt(viewerState.index);
      }
    },
  });
}

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
  // Ignore taps that start on a real control (the delete-page button, the
  // undo toast's button) — both now live inside the stage so their taps
  // overlay the PDF, but they must never be swallowed into pinch/pan/swipe
  // tracking or have their click suppressed by pointer capture retargeting.
  if (e.target.closest("button")) return;
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
  // A stale split/join selection would reference entries this rescan is
  // about to discard, so drop it rather than let it point at nothing.
  batchMode = null;
  batchSelection = [];
  updateBatchButtons();

  statusEl.textContent = `Scanning "${dirHandle.name}"…`;

  const entries = await collectPdfEntries(dirHandle);

  rotationsByDocument = new Map();
  entryElements.clear();
  currentFolderName = dirHandle.name;
  currentDirHandle = dirHandle;
  syncDestinationsWithFolder(dirHandle);
  stripEl.innerHTML = "";
  if (entries.length === 0) {
    resultsEl.hidden = true;
    statusEl.textContent = `No PDFs found in "${dirHandle.name}".`;
  } else {
    resultsHeading.textContent = `${entries.length} PDF${entries.length === 1 ? "" : "s"} found`;
    const elements = entries.map((entry, index) => {
      const { item, imgWrap } = buildThumbnailItem(entry, () => openViewer(entries, index));
      stripEl.appendChild(item);
      entryElements.set(entry, { item, imgWrap });
      return { item, imgWrap };
    });
    resultsEl.hidden = false;

    await generateThumbnails(dirHandle.name, entries, elements);
    statusEl.textContent = "";
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

getStoredDestinations()
  .then((stored) => {
    destinations = stored || [];
    renderDestinationBar();
    if (currentDirHandle) syncDestinationsWithFolder(currentDirHandle);
  })
  .catch((err) => {
    console.error("Failed to read stored destinations:", err);
  });

getStoredChipLabels()
  .then((stored) => {
    // null means never stored (first run) — keep the built-in defaults.
    // An explicit [] means the user cleared every chip on purpose; respect it.
    if (stored !== null) {
      chipLabels = stored;
      renderRenameChips();
    }
  })
  .catch((err) => {
    console.error("Failed to read stored chip labels:", err);
  });

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
