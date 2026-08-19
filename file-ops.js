// Moves (and optionally renames) a file, within the same directory or into a
// different one. Uses FileSystemFileHandle.move() where available (keeps the
// same handle valid, pointing at the moved entry); falls back to a
// copy-then-delete otherwise. Some platforms (seen on Android Chrome, likely
// a Storage Access Framework provider that doesn't support atomic rename)
// expose move() as a function but have it throw at call time, so a feature
// check alone isn't enough — actually attempt it and fall back on failure
// too, not just on absence.
export async function moveFileHandle(sourceDirHandle, handle, oldName, destDirHandle, newName) {
  if (typeof handle.move === "function") {
    try {
      if (destDirHandle === sourceDirHandle) {
        await handle.move(newName);
      } else {
        await handle.move(destDirHandle, newName);
      }
      return handle;
    } catch (err) {
      console.warn("FileSystemFileHandle.move() failed, falling back to copy+delete:", err);
    }
  }

  const file = await handle.getFile();
  const bytes = await file.arrayBuffer();
  const newHandle = await destDirHandle.getFileHandle(newName, { create: true });
  const writable = await newHandle.createWritable();
  try {
    await writable.write(bytes);
  } finally {
    await writable.close();
  }
  await sourceDirHandle.removeEntry(oldName);
  return newHandle;
}

// Renames a file within the same directory.
export async function renameFileHandle(dirHandle, handle, oldName, newName) {
  return moveFileHandle(dirHandle, handle, oldName, dirHandle, newName);
}

// Returns true if a file with this name already exists directly inside dirHandle.
export async function fileExistsInDir(dirHandle, name) {
  try {
    await dirHandle.getFileHandle(name);
    return true;
  } catch (err) {
    if (err.name === "NotFoundError") return false;
    throw err;
  }
}
