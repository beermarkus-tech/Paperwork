const pickBtn = document.getElementById("pick-folder-btn");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const fileListEl = document.getElementById("file-list");

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

async function scanFolderForPdfs(dirHandle) {
  const pdfs = [];
  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind === "file" && name.toLowerCase().endsWith(".pdf")) {
      const file = await handle.getFile();
      pdfs.push({ name, size: file.size });
    }
  }
  pdfs.sort((a, b) => a.name.localeCompare(b.name));
  return pdfs;
}

function renderPdfList(pdfs) {
  fileListEl.innerHTML = "";
  if (pdfs.length === 0) {
    resultsEl.hidden = true;
    return;
  }
  for (const pdf of pdfs) {
    const li = document.createElement("li");
    const sizeSpan = document.createElement("span");
    sizeSpan.className = "size";
    sizeSpan.textContent = formatBytes(pdf.size);
    li.textContent = pdf.name;
    li.appendChild(sizeSpan);
    fileListEl.appendChild(li);
  }
  resultsEl.hidden = false;
}

async function handlePickFolder() {
  statusEl.textContent = "Waiting for folder selection…";
  try {
    const dirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
    statusEl.textContent = `Scanning "${dirHandle.name}"…`;
    const pdfs = await scanFolderForPdfs(dirHandle);
    statusEl.textContent = `Found ${pdfs.length} PDF${pdfs.length === 1 ? "" : "s"} in "${dirHandle.name}".`;
    renderPdfList(pdfs);
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
