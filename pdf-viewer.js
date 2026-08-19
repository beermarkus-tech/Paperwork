import pdfjsLib from "./pdfjs.js";

export async function loadDocument(file) {
  const arrayBuffer = await file.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
  const pdf = await loadingTask.promise;
  return { pdf, loadingTask };
}

// `rotation` may be omitted (undefined), in which case pdf.js falls back to
// the page's own intrinsic rotation. Returns the rotation actually applied,
// so callers can seed their own state with it.
export async function renderPageToCanvas(pdf, pageNumber, rotation, canvas, maxWidth, maxHeight) {
  const page = await pdf.getPage(pageNumber);
  const baseViewport = page.getViewport({ scale: 1, rotation });
  const scale = Math.max(
    Math.min(maxWidth / baseViewport.width, maxHeight / baseViewport.height),
    0.1,
  );
  const viewport = page.getViewport({ scale, rotation });

  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const context = canvas.getContext("2d");
  await page.render({ canvasContext: context, viewport }).promise;

  return viewport.rotation;
}
