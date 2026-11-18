type PdfJsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
type PdfDocumentProxy = Awaited<
  ReturnType<PdfJsModule["getDocument"]>["promise"]
>;
type PdfPageProxy = Awaited<ReturnType<PdfDocumentProxy["getPage"]>>;
type PdfRenderTask = ReturnType<PdfPageProxy["render"]>;

const PDF_JS_ASSET_BASE = "/pdfjs/5.5.207";
export const PDF_JS_STANDARD_FONT_DATA_URL =
  `${PDF_JS_ASSET_BASE}/standard_fonts/`;
export const PDF_JS_WORKER_SRC =
  `${PDF_JS_ASSET_BASE}/legacy/build/pdf.worker.min.mjs`;

let pdfJsModulePromise: Promise<PdfJsModule> | null = null;

function createRenderContext(width: number, height: number) {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");

    if (!context) {
      throw new Error("Unable to create an offscreen PDF preview context.");
    }

    return context;
  }

  if (typeof document === "undefined") {
    throw new Error("Unable to create a PDF preview context.");
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("Unable to create a PDF preview context.");
  }

  return context;
}

export async function loadPdfJsModule(): Promise<PdfJsModule> {
  pdfJsModulePromise ??= import("pdfjs-dist/legacy/build/pdf.mjs").then((pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerSrc = PDF_JS_WORKER_SRC;

    return pdfjs;
  });

  return pdfJsModulePromise;
}

/**
 * Starts the pdf.js worker without waiting for pdf.js itself. Left to
 * itself pdf.js starts the worker only once its own code has arrived, and
 * the worker is the largest download on a page that shows a PDF.
 *
 * Resolves once the worker is running. Resolves to null if it could not be
 * started, and pdf.js then starts one its own way. Aborting `signal` before
 * then stops the worker and also resolves to null.
 */
export function startPdfJsWorker(signal: AbortSignal): Promise<Worker | null> {
  return new Promise((resolve) => {
    let worker: Worker;

    try {
      worker = new Worker(PDF_JS_WORKER_SRC, { type: "module" });
    } catch {
      resolve(null);
      return;
    }

    // The listeners go once one has fired: an error later on, while a
    // document is open, is for pdf.js to deal with as it always has.
    const settled = new AbortController();
    const settle = (started: Worker | null) => {
      settled.abort();
      resolve(started);
    };
    const giveUp = () => {
      worker.terminate();
      settle(null);
    };

    // The worker says "ready" as soon as its script has run.
    worker.addEventListener("message", () => settle(worker), {
      signal: settled.signal,
    });
    worker.addEventListener("error", giveUp, { signal: settled.signal });
    signal.addEventListener("abort", giveUp, { signal: settled.signal });
  });
}

/** Fetches a PDF whole, the way pdf.js does when it is given a URL. */
export async function fetchPdfBytes(
  url: string,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const response = await fetch(url, { signal });

  if (!response.ok) {
    throw new Error(`The PDF could not be fetched (${response.status}).`);
  }

  return new Uint8Array(await response.arrayBuffer());
}

export async function assertPdfPreviewRenderable(
  file: File | Uint8Array,
): Promise<void> {
  const pdfBytes =
    file instanceof Uint8Array ? file.slice() : new Uint8Array(await file.arrayBuffer());
  const pdfjs = await loadPdfJsModule();
  let loadingTask: ReturnType<PdfJsModule["getDocument"]> | null = null;
  let documentProxy: PdfDocumentProxy | null = null;
  let page: PdfPageProxy | null = null;
  let renderTask: PdfRenderTask | null = null;

  try {
    loadingTask = pdfjs.getDocument({
      data: pdfBytes,
      standardFontDataUrl: PDF_JS_STANDARD_FONT_DATA_URL,
    });
    documentProxy = await loadingTask.promise;
    page = await documentProxy.getPage(1);

    const viewport = page.getViewport({ scale: 1 });
    const renderContext = createRenderContext(
      Math.max(1, Math.ceil(viewport.width)),
      Math.max(1, Math.ceil(viewport.height)),
    );

    renderTask = page.render({
      canvasContext: renderContext as CanvasRenderingContext2D,
      viewport,
    });

    await renderTask.promise;
  } finally {
    renderTask?.cancel();
    page?.cleanup();
    loadingTask?.destroy();

    if (documentProxy) {
      await documentProxy.destroy();
    }
  }
}
