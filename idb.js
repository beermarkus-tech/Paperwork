const DB_NAME = "paperwork";
const DB_VERSION = 2;
const THUMBNAIL_STORE = "thumbnails";
const META_STORE = "meta";
const FOLDER_HANDLE_KEY = "inboxFolderHandle";
const DESTINATIONS_KEY = "destinations";
const CHIP_LABELS_KEY = "chipLabels";

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(THUMBNAIL_STORE)) {
          db.createObjectStore(THUMBNAIL_STORE, { keyPath: "key" });
        }
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE, { keyPath: "key" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        dbPromise = null;
        reject(request.error);
      };
      // Fires if another tab/window has the same DB open at an older
      // version, blocking this upgrade — without a handler the request just
      // sits forever and every caller waiting on openDb() hangs silently.
      request.onblocked = () => {
        dbPromise = null;
        reject(new Error("Database is blocked by another open Paperwork tab — close it and reload."));
      };
    });
  }
  return dbPromise;
}

export async function getCachedThumbnail(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(THUMBNAIL_STORE, "readonly");
    const request = tx.objectStore(THUMBNAIL_STORE).get(key);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

export async function putCachedThumbnail(record) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(THUMBNAIL_STORE, "readwrite");
    tx.objectStore(THUMBNAIL_STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getStoredFolderHandle() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE, "readonly");
    const request = tx.objectStore(META_STORE).get(FOLDER_HANDLE_KEY);
    request.onsuccess = () => resolve(request.result ? request.result.value : null);
    request.onerror = () => reject(request.error);
  });
}

export async function setStoredFolderHandle(handle) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE, "readwrite");
    tx.objectStore(META_STORE).put({ key: FOLDER_HANDLE_KEY, value: handle });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Resolves null when nothing has ever been stored for this key, so callers
// can tell "never set" apart from an explicit falsy/empty value.
async function getStoredValue(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE, "readonly");
    const request = tx.objectStore(META_STORE).get(key);
    request.onsuccess = () => resolve(request.result ? request.result.value : null);
    request.onerror = () => reject(request.error);
  });
}

async function setStoredValue(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE, "readwrite");
    tx.objectStore(META_STORE).put({ key, value });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export const getStoredDestinations = () => getStoredValue(DESTINATIONS_KEY);
export const setStoredDestinations = (names) => setStoredValue(DESTINATIONS_KEY, names);
export const getStoredChipLabels = () => getStoredValue(CHIP_LABELS_KEY);
export const setStoredChipLabels = (labels) => setStoredValue(CHIP_LABELS_KEY, labels);
