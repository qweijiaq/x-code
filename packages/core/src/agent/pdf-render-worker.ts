import type { PDFParse } from 'pdf-parse'

import { parentPort } from 'node:worker_threads'

import type { PdfRenderRequest, PdfRenderResponse } from './pdf-render-protocol.js'
import { configurePdfWorker } from './pdf-worker-config.js'

if (!parentPort && !process.send) throw new Error('PDF render worker requires a parent channel')

let parser: PDFParse | null = null
let queue: Promise<void> = Promise.resolve()

async function handleRequest(request: PdfRenderRequest): Promise<PdfRenderResponse> {
  try {
    // destroy 必须先于「parser 未初始化」校验：init 失败或从未 init 时（parser
    // 为 null）返回 ok:false 会让 onRequest 的 shouldClose 为 false，worker 自己
    // 永远不关闭通道——Windows fork 模式下进程一直挂着，只能靠父端 kill。
    if (request.type === 'destroy') {
      await parser?.destroy().catch(() => {})
      parser = null
      return { id: request.id, ok: true, result: { type: 'destroy' } }
    }
    if (request.type === 'init') {
      const { PDFParse } = await import('pdf-parse')
      configurePdfWorker(PDFParse)
      // 复用同一个 worker 重新 init（换一份 PDF）时先释放旧实例：PDFParse 持有
      // 整份 PDF 数据（最大 20MB），在 512MB 受限堆里很容易被放大成 OOM。
      // 先赋值再 getInfo：getInfo 抛错时实例仍可被后续 destroy 释放，
      // 而不是留在半初始化状态。
      await parser?.destroy().catch(() => {})
      parser = null
      const nextParser = new PDFParse({ data: new Uint8Array(request.data) })
      parser = nextParser
      const info = await nextParser.getInfo()
      return { id: request.id, ok: true, result: { type: 'init', totalPages: info.total } }
    }
    if (!parser) throw new Error('PDF parser is not initialized')
    if (request.type === 'get-text') {
      const text = await parser.getText({ partial: request.pageNumbers, pageJoiner: '' })
      return {
        id: request.id,
        ok: true,
        result: { type: 'get-text', pages: text.pages.map((page) => ({ num: page.num, text: page.text })) },
      }
    }
    if (request.type === 'render') {
      const info = await parser.getInfo({ partial: [request.pageNumber], parsePageInfo: true })
      const page = info.pages[0]
      if (!page) throw new Error(`PDF page ${request.pageNumber} has no metadata`)
      const targetHeight = Math.ceil((page.height / page.width) * request.desiredWidth)
      if (!Number.isFinite(targetHeight) || targetHeight <= 0) throw new Error('PDF page has invalid dimensions')
      if (request.desiredWidth * targetHeight > request.maxPixels) {
        throw new Error(
          `PDF page ${request.pageNumber} exceeds render pixel limit (${request.desiredWidth}x${targetHeight})`,
        )
      }
      const screenshots = await parser.getScreenshot({
        partial: [request.pageNumber],
        desiredWidth: request.desiredWidth,
        imageDataUrl: false,
        imageBuffer: true,
      })
      const screenshot = screenshots.pages[0]
      if (!screenshot?.data?.length) throw new Error(`PDF page ${request.pageNumber} produced no image data`)
      const bytes = Uint8Array.from(screenshot.data)
      return {
        id: request.id,
        ok: true,
        result: {
          type: 'render',
          pageNumber: request.pageNumber,
          width: screenshot.width,
          height: screenshot.height,
          data: bytes.buffer,
        },
      }
    }
    // 未知类型（父端把消息断言成 PdfRenderRequest，没有运行时校验）不能落到
    // destroy 分支：那会静默销毁 parser 并关闭通道，让 worker 提前终止，
    // 之后所有请求都表现为 "exited unexpectedly"。
    throw new Error(`Unsupported PDF render request type: ${String((request as { type?: unknown }).type)}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { id: request.id, ok: false, error: message }
  }
}

function send(response: PdfRenderResponse): Promise<boolean> {
  if (parentPort) {
    // 渲染出的图片 buffer 用 transferList 转移所有权（零拷贝）；其余消息按普通结构化克隆发送。
    if (response.ok && response.result.type === 'render') parentPort.postMessage(response, [response.result.data])
    else parentPort.postMessage(response)
    return Promise.resolve(true)
  }
  if (!process.send || !process.connected) return Promise.resolve(false)
  return new Promise<boolean>((resolve) => {
    try {
      process.send!(response, (error) => resolve(!error))
    } catch {
      resolve(false)
    }
  })
}

function closeChannel(): void {
  if (parentPort) parentPort.close()
  else if (process.connected) process.disconnect()
}

function onRequest(request: PdfRenderRequest): void {
  queue = queue.then(async () => {
    // `handleRequest` 自带 try/catch，但 `send()`（端口已关闭时 postMessage 抛
    // ERR_CLOSED_MESSAGE_PORT）与 `closeChannel()`（重复 close/disconnect）仍可能抛。
    // 一旦本回调 reject：queue 变成 rejected promise，后续请求的回调被永久跳过
    // （父端只能等 30s 超时），同时产生 unhandled rejection——在 worker_threads 里
    // 直接触发 'error' 杀掉 worker。因此这里必须保证链路始终 resolve。
    try {
      const response = await handleRequest(request)
      const shouldClose = response.ok && response.result.type === 'destroy'
      const sent = await send(response)
      if (shouldClose || !sent) closeChannel()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await send({ id: request.id, ok: false, error: `PDF render worker internal error: ${message}` }).catch(() => {})
      try {
        closeChannel()
      } catch {
        // 通道已经不可用——没有更多需要清理的东西。
      }
    }
  })
}

if (parentPort) parentPort.on('message', onRequest)
else {
  process.once('disconnect', () => process.exit(0))
  process.on('message', (request) => onRequest(request as PdfRenderRequest))
}
