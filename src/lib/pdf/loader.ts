import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker

export async function loadPdfFromBytes(data: ArrayBuffer | Uint8Array): Promise<PDFDocumentProxy> {
  const loadingTask = pdfjs.getDocument({
    data: data instanceof Uint8Array ? data : new Uint8Array(data),
    useSystemFonts: true,
  })
  return loadingTask.promise
}

export async function loadPdfFromUrl(url: string): Promise<PDFDocumentProxy> {
  return pdfjs.getDocument({ url, useSystemFonts: true }).promise
}

export { pdfjs }
