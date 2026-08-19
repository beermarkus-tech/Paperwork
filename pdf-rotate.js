import { PDFDocument, degrees } from "./vendor/pdf-lib/pdf-lib.esm.min.js";

export async function savePageRotation(fileHandle, file, pageNumber, absoluteRotationDegrees) {
  const bytes = await file.arrayBuffer();
  const pdfDoc = await PDFDocument.load(bytes);
  const page = pdfDoc.getPage(pageNumber - 1);
  page.setRotation(degrees(absoluteRotationDegrees));

  const outBytes = await pdfDoc.save();
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(outBytes);
  } finally {
    await writable.close();
  }
}
