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

// Returns one Uint8Array per page, each a standalone one-page PDF. Doesn't
// write anything itself — the caller needs to check every target filename
// for collisions before committing any of them to disk.
export async function splitPdfIntoPages(file) {
  const bytes = await file.arrayBuffer();
  const srcDoc = await PDFDocument.load(bytes);
  const pageCount = srcDoc.getPageCount();
  const pages = [];
  for (let i = 0; i < pageCount; i += 1) {
    const pageDoc = await PDFDocument.create();
    const [copiedPage] = await pageDoc.copyPages(srcDoc, [i]);
    pageDoc.addPage(copiedPage);
    pages.push(await pageDoc.save());
  }
  return pages;
}

// Concatenates multiple PDF files, in the given order, into one. Each
// source page's own rotation carries over since it's copied along with the
// page itself. Doesn't write anything — same reasoning as splitPdfIntoPages.
export async function joinPdfFiles(files) {
  const joinedDoc = await PDFDocument.create();
  for (const file of files) {
    const bytes = await file.arrayBuffer();
    const srcDoc = await PDFDocument.load(bytes);
    const copiedPages = await joinedDoc.copyPages(srcDoc, srcDoc.getPageIndices());
    for (const page of copiedPages) {
      joinedDoc.addPage(page);
    }
  }
  return joinedDoc.save();
}
