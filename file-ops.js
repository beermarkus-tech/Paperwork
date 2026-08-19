// Renames a file within the same directory. Uses FileSystemFileHandle.move()
// where available (keeps the same handle valid, pointing at the renamed
// entry); falls back to a copy-then-delete otherwise. Some platforms (seen
// on Android Chrome, likely a Storage Access Framework provider that
// doesn't support atomic rename) expose move() as a function but have it
// throw at call time, so a feature check alone isn't enough — actually
// attempt it and fall back on failure too, not just on absence.
export async function renameFileHandle(dirHandle, handle, oldName, newName) {
  if (typeof handle.move === "function") {
    try {
      await handle.move(newName);
      return handle;
    } catch (err) {
      console.warn("FileSystemFileHandle.move() failed, falling back to copy+delete:", err);
    }
  }

  const file = await handle.getFile();
  const bytes = await file.arrayBuffer();
  const newHandle = await dirHandle.getFileHandle(newName, { create: true });
  const writable = await newHandle.createWritable();
  try {
    await writable.write(bytes);
  } finally {
    await writable.close();
  }
  await dirHandle.removeEntry(oldName);
  return newHandle;
}
