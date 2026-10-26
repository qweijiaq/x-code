// 在 Electron utility 进程中，若不显式提供 worker URL，pdfjs 会拒绝解析：
// 它检测到 `process.versions.electron` + `process.type` 后就走浏览器路径。
// 把 GlobalWorkerOptions.workerSrc 指向随 pdf-parse 一起发布的 pdfjs worker，
// 即可恢复文本提取和页面渲染。
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

interface PdfParseWorkerApi {
  /** 不传参时返回当前的 workerSrc（未设置时为 ''）。 */
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
    // 如果确实找不到 worker，就让 pdfjs 自身的错误上浮。
  }
}
