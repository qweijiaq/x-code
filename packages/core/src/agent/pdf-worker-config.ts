// pdfjs refuses to parse in an Electron utility process without an explicit
// worker URL: it detects `process.versions.electron` + `process.type` and takes
// its browser path. Pointing GlobalWorkerOptions.workerSrc at the pdfjs worker
// that ships with pdf-parse restores both text extraction and page rendering.
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

interface PdfParseWorkerApi {
  /** With no argument it returns the current workerSrc ('' when unset). */
  setWorker?: (workerSrc?: string) => string
}

export function configurePdfWorker(PDFParse: PdfParseWorkerApi): void {
  try {
    if (!PDFParse.setWorker) return
    if (PDFParse.setWorker()) return
    const requireFromCore = createRequire(import.meta.url)
    const pdfParseEntry = requireFromCore.resolve('pdf-parse')
    const requireFromPdfParse = createRequire(pdfParseEntry)
    const workerPath = requireFromPdfParse.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')
    PDFParse.setWorker(pathToFileURL(workerPath).href)
  } catch {
    // Leave pdfjs' own error to surface if the worker truly cannot be found.
  }
}
