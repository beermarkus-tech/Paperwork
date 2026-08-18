import * as pdfjsLib from "./vendor/pdfjs/pdf.min.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "./vendor/pdfjs/pdf.worker.min.js",
  import.meta.url,
).href;

export default pdfjsLib;
