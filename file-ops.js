// Renames a file within the same directory. Uses FileSystemFileHandle.move()
// where available (keeps the same handle valid, pointing at the renamed
// entry); falls back to a copy-then-delete for browsers without it yet.
export async function renameFileHandle(dirHandle, handle, oldName, newName) {
  if (typeof handle.move === "function") {
    await handle.move(newName);
    return handle;
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
