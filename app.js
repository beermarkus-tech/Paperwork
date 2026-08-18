import { getCachedThumbnail, putCachedThumbnail } from "./idb.js";
import { renderFirstPageThumbnail } from "./pdf-thumbnails.js";

const pickBtn = document.getElementById("pick-folder-btn");
const statusEl = document.getElementById("status");
const progressEl = document.getElementById("progress");
const resultsEl = document.getElementById("results");
const stripEl = document.getElementById("thumbnail-strip");

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

function buildThumbnailItem(entry) {
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
    const pages = entry.pageCount ? `, ${entry.pageCount} page${entry.pageCount === 1 ? "" : "s"}` : "";
    statusEl.textContent = `Selected "${entry.name}"${pages}. (Full-page viewer arrives in Stage 3.)`;
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

    const elements = entries.map((entry) => {
      const { item, imgWrap } = buildThumbnailItem(entry);
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
