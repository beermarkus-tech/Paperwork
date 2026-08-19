import { PDFDocument } from "./vendor/pdf-lib/pdf-lib.esm.min.js";

async function writeBytes(fileHandle, bytes) {
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(bytes);
  } finally {
    await writable.close();
  }
}

// Removes one page and writes the file back. Returns the resulting page
// count so the caller can tell whether the document just became empty.
export async function deletePageFromFile(fileHandle, file, pageNumber) {
  const bytes = await file.arrayBuffer();
  const pdfDoc = await PDFDocument.load(bytes);
  pdfDoc.removePage(pageNumber - 1);
  const newPageCount = pdfDoc.getPageCount();
  await writeBytes(fileHandle, await pdfDoc.save());
  return newPageCount;
}

// Writes previously-captured bytes straight back to a file handle — used to
// undo a page deletion without needing to re-derive anything about what
// changed (rotations included, since those live in the bytes themselves).
export async function restoreFileBytes(fileHandle, bytes) {
  await writeBytes(fileHandle, bytes);
}
