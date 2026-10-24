import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { agentLoop, createLoopState, processPdf, toolRegistry } from '@x-code-cli/core'
import type { AgentCallbacks } from '@x-code-cli/core'

import type { SmokeModuleReport, SmokeReport } from '../shared/protocol.js'
import { DEMO_MODEL_ID } from './bootstrap.js'
import { createDemoModel } from './demo-model.js'
import { loadPty, ptyEnv } from './shell.js'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function probeModule(
  name: string,
  test?: (mod: Record<string, unknown>) => Promise<string | undefined> | string | undefined,
): Promise<SmokeModuleReport> {
  try {
    const mod = (await import(name)) as Record<string, unknown>
    const detail = test
      ? await test(mod)
      : `loaded${Object.keys(mod).length > 0 ? ` (${Object.keys(mod).slice(0, 6).join(', ')})` : ''}`
    return { ok: true, detail }
  } catch (error) {
    const detail = error instanceof Error && error.stack ? error.stack.split('\n').slice(0, 4).join('\n') : undefined
    return { ok: false, error: errorMessage(error), detail }
  }
}

/**
 * pdfjs takes its browser code path when `process.type` is set (Electron
 * utility process) and therefore skips the @napi-rs/canvas DOMMatrix polyfill
 * it installs in a plain Node process. Supply the same constructor first.
 */
async function ensureDomMatrix(): Promise<void> {
  const globals = globalThis as { DOMMatrix?: unknown }
  if (typeof globals.DOMMatrix !== 'undefined') return
  const canvas = (await import('@napi-rs/canvas')) as unknown as {
    DOMMatrix?: unknown
    default?: { DOMMatrix?: unknown }
  }
  const DomMatrix = canvas.DOMMatrix ?? canvas.default?.DOMMatrix
  if (DomMatrix) globals.DOMMatrix = DomMatrix
}

async function probePty(): Promise<{ ok: boolean; output: string; error?: string }> {
  try {
    const pty = await loadPty()
    const isWindows = process.platform === 'win32'
    const file = isWindows ? (process.env.COMSPEC ?? 'cmd.exe') : '/bin/sh'
    const args = isWindows ? ['/c', 'echo smoke-pty-ok'] : ['-c', 'printf smoke-pty-ok']

    return await new Promise((resolve) => {
      let output = ''
      let settled = false
      const proc = pty.spawn(file, args, {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: process.cwd(),
        env: ptyEnv(),
      })
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try {
          proc.kill()
        } catch {
          // Already gone.
        }
        resolve({ ok: false, output, error: 'pty timeout' })
      }, 5000)
      proc.onData((data) => {
        output += data
      })
      proc.onExit(({ exitCode }) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({
          ok: exitCode === 0 && output.includes('smoke-pty-ok'),
          output,
          error: exitCode === 0 ? undefined : `exit ${exitCode}`,
        })
      })
    })
  } catch (error) {
    return { ok: false, output: '', error: errorMessage(error) }
  }
}

async function probeAgent(): Promise<{ ok: boolean; text: string; error?: string }> {
  let text = ''
  try {
    const state = createLoopState('default', { projectCwd: process.cwd() })
    const callbacks: AgentCallbacks = {
      onTextDelta: (delta) => {
        text += delta
      },
      onToolCall: () => {},
      onToolProgress: () => {},
      onToolResult: () => {},
      onAskPermission: async () => 'yes',
      onAskUser: async () => '',
      onPlanApprovalRequest: async () => true,
      onPlanModeChange: () => {},
      onTodosUpdate: () => {},
      onShellOutput: () => {},
      onUsageUpdate: () => {},
      onContextCompressed: () => {},
      onError: () => {},
    }
    await agentLoop(
      'phase-0 smoke',
      createDemoModel(),
      { modelId: DEMO_MODEL_ID, trustMode: true, printMode: false, maxTurns: 2 },
      callbacks,
      state,
    )
    return { ok: text.includes('演示模型'), text }
  } catch (error) {
    return { ok: false, text, error: errorMessage(error) }
  }
}

export async function runSmoke(): Promise<SmokeReport> {
  const modules: Record<string, SmokeModuleReport> = {}

  modules['node-pty'] = await probeModule('node-pty', (mod) => `spawn=${typeof mod.spawn}`)
  modules['fs-ext-extra-prebuilt'] = await probeModule('fs-ext-extra-prebuilt', (mod) => {
    const keys = Object.keys(mod).slice(0, 8)
    const fallback = Object.keys((mod.default as Record<string, unknown> | undefined) ?? {}).slice(0, 8)
    return (keys.length > 0 ? keys : fallback).join(', ')
  })
  modules['@napi-rs/canvas'] = await probeModule('@napi-rs/canvas', (mod) => {
    const createCanvas = (mod.createCanvas ?? (mod.default as Record<string, unknown> | undefined)?.createCanvas) as
      | ((
          w: number,
          h: number,
        ) => {
          getContext: (kind: string) => { fillRect: (x: number, y: number, w: number, h: number) => void }
        })
      | undefined
    if (typeof createCanvas !== 'function') return 'loaded, createCanvas missing'
    const canvas = createCanvas(8, 8)
    canvas.getContext('2d').fillRect(0, 0, 8, 8)
    return 'canvas render ok'
  })
  modules['@vscode/ripgrep'] = await probeModule('@vscode/ripgrep', (mod) => {
    const rgPath = (mod.rgPath ?? (mod.default as Record<string, unknown> | undefined)?.rgPath) as string | undefined
    if (!rgPath) return 'loaded, rgPath missing'
    return `rgPath exists=${fs.existsSync(rgPath)}`
  })
  modules['tesseract.js'] = await probeModule('tesseract.js')
  modules['pdf-parse'] = await (async () => {
    try {
      await ensureDomMatrix()
      const mod = (await import('pdf-parse')) as Record<string, unknown>
      return { ok: true, detail: `loaded (${Object.keys(mod).slice(0, 6).join(', ')})` } satisfies SmokeModuleReport
    } catch (error) {
      const detail = error instanceof Error && error.stack ? error.stack.split('\n').slice(0, 4).join('\n') : undefined
      return { ok: false, error: errorMessage(error), detail } satisfies SmokeModuleReport
    }
  })()

  try {
    const { secretRoundTripProbe } = await import('./secrets.js')
    const secret = await secretRoundTripProbe()
    modules['safeStorage'] = {
      ok: secret.roundTrip && (secret.encrypted || !secret.available),
      detail: `available=${secret.available} encrypted=${secret.encrypted} roundTrip=${secret.roundTrip}`,
    }
  } catch (error) {
    modules['safeStorage'] = { ok: false, error: errorMessage(error) }
  }

  const pty = await probePty()
  const agent = await probeAgent()

  const runtimeDir = path.dirname(fileURLToPath(import.meta.url))
  for (const worker of [
    'office-xlsx-worker.js',
    'audio-transcribe-worker.js',
    'pdf-render-worker.js',
    'image-compress-worker.js',
  ]) {
    const workerPath = path.join(runtimeDir, worker)
    modules[`worker:${worker}`] = { ok: fs.existsSync(workerPath), detail: workerPath }
  }

  try {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'xcode-doc-smoke-'))
    const file = path.join(dir, 'smoke.md')
    await fs.promises.writeFile(file, '# Smoke\n\nDocument tool body.\n')
    const readDocument = toolRegistry.readDocument as unknown as {
      execute?: (
        input: { filePath: string },
        options: { toolCallId: string; abortSignal?: AbortSignal },
      ) => Promise<unknown>
    }
    const output = await readDocument.execute?.({ filePath: file }, { toolCallId: 'smoke-doc' })
    modules['readDocument'] = {
      ok: typeof output === 'string' && output.includes('Document:') && output.includes('Document tool body.'),
      detail: typeof output === 'string' ? output.slice(0, 160) : 'no output',
    }
    await fs.promises.rm(dir, { recursive: true, force: true })
  } catch (error) {
    modules['readDocument'] = { ok: false, error: errorMessage(error) }
  }

  try {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'xcode-tools-smoke-'))
    type Executor = {
      execute?: (input: unknown, options: { toolCallId: string }) => Promise<unknown>
    }
    const execute = (tool: unknown, input: unknown, toolCallId: string): Promise<unknown> =>
      (tool as Executor).execute!(input, { toolCallId })

    interface SmokeSheet {
      addRow(values: unknown[]): void
    }
    interface SmokeWorkbook {
      addWorksheet(name: string): SmokeSheet
      xlsx: { writeFile(path: string): Promise<void> }
    }
    const xlsxPath = path.join(dir, 'smoke.xlsx')
    const excelModule = (await import('exceljs')) as unknown as {
      default?: { Workbook: new () => SmokeWorkbook }
      Workbook?: new () => SmokeWorkbook
    }
    const WorkbookClass = excelModule.default?.Workbook ?? excelModule.Workbook
    if (!WorkbookClass) throw new Error('exceljs Workbook missing')
    const workbook = new WorkbookClass()
    const sheet = workbook.addWorksheet('Data')
    sheet.addRow(['name', 'amount'])
    sheet.addRow(['a', 2])
    sheet.addRow(['b', 3])
    await workbook.xlsx.writeFile(xlsxPath)
    const queryOutput = await execute(
      toolRegistry.spreadsheet,
      {
        action: 'query',
        filePath: xlsxPath,
        groupBy: 'name',
        aggregates: [{ column: 'amount', op: 'sum' }],
      },
      'smoke-sheet',
    )
    const parsed = JSON.parse(String(queryOutput)) as { matched?: number; rows?: Array<Record<string, number>> }
    const total = (parsed.rows ?? []).reduce((sum, row) => sum + Number(row['sum(amount)'] ?? 0), 0)
    const sheetOk = parsed.matched === 2 && Math.abs(total - 5) < 1e-9

    const { PDFDocument, StandardFonts } = await import('pdf-lib')
    const first = path.join(dir, 'a.pdf')
    const second = path.join(dir, 'b.pdf')
    for (const [file, pages] of [
      [first, 2],
      [second, 1],
    ] as const) {
      const document = await PDFDocument.create()
      for (let index = 0; index < pages; index++) document.addPage([200, 300])
      await fs.promises.writeFile(file, await document.save())
    }
    const merged = path.join(dir, 'merged.pdf')
    const convertOutput = await execute(
      toolRegistry.convert,
      { action: 'pdf-merge', inputs: [first, second], output: merged },
      'smoke-convert',
    )
    const convertOk = String(convertOutput).includes('Merged 2 PDFs (3 pages)') && fs.existsSync(merged)

    // documentExport's PDF path goes through the main process (printToPDF),
    // which also exercises the reverse main-request channel.
    const exportedPdf = path.join(dir, 'export-smoke.pdf')
    const exportOutput = await execute(
      toolRegistry.documentExport,
      { content: '# Smoke\n\nExport body.', format: 'pdf', output: exportedPdf, title: 'Smoke' },
      'smoke-export',
    )
    const exportOk =
      String(exportOutput).includes('Exported PDF') &&
      fs.existsSync(exportedPdf) &&
      fs.readFileSync(exportedPdf).subarray(0, 4).toString('latin1') === '%PDF'

    const rawRender = await processPdf(first, {
      mode: 'visual',
      vision: true,
      pageRange: { first: 1, last: 2 },
      maxRenderedPages: 2,
      rawImages: true,
    })
    modules['pdf render'] = {
      ok: rawRender.type === 'content' && rawRender.parts.some((part) => part.type === 'image'),
      detail:
        rawRender.type === 'content'
          ? JSON.stringify(rawRender.parts.map((part) => (part.type === 'text' ? part.text.slice(0, 160) : part.type)))
          : JSON.stringify(rawRender).slice(0, 400),
    }

    const { loadDocumentPages, ocrDocumentPage, openDocumentView } = await import('./document-view.js')
    const many = path.join(dir, 'many-pages.pdf')
    const manyDocument = await PDFDocument.create()
    const font = await manyDocument.embedFont(StandardFonts.Helvetica)
    for (let index = 1; index <= 22; index++) {
      const page = manyDocument.addPage([300, 400])
      page.drawText(`Page ${index}`, { x: 40, y: 340, size: 18, font })
    }
    await fs.promises.writeFile(many, await manyDocument.save())
    const pdfView = await openDocumentView(many)
    const firstBatchOk =
      (pdfView.pages?.length ?? 0) === 20 &&
      pdfView.hasMore === true &&
      (pdfView.pages?.[0]?.dataUrl.startsWith('data:image/') ?? false) &&
      (pdfView.pages?.[0]?.text.includes('Page 1') ?? false)
    const nextBatch = await loadDocumentPages(many, 21, 20)
    const secondBatchOk =
      nextBatch.pages.length === 2 &&
      nextBatch.hasMore === false &&
      nextBatch.pages[1]?.page === 22 &&
      nextBatch.pages[1]?.text.includes('Page 22')
    const pdfPagesOk = firstBatchOk && secondBatchOk

    const ocrText = await ocrDocumentPage(many, 3)
    const ocrOk = ocrText.length > 0

    modules['document tools'] = {
      ok: sheetOk && convertOk && exportOk && pdfPagesOk && ocrOk,
      detail: `spreadsheet=${sheetOk} convert=${convertOk} export=${exportOk} pdfPreview=${pdfPagesOk} pages=${
        pdfView.pages?.length ?? 0
      } ocr=${ocrOk}`,
    }

    const libraryIndexOutput = await execute(
      toolRegistry.documentLibrary,
      { action: 'index', path: dir, recursive: true, semantic: false },
      'smoke-library-index',
    )
    const librarySearchOutput = await execute(
      toolRegistry.documentSearch,
      { query: 'Page 1', limit: 3 },
      'smoke-library-search',
    )
    const libraryOk =
      String(libraryIndexOutput).includes('Indexed') && String(librarySearchOutput).includes('Document search')
    modules['library tools'] = {
      ok: libraryOk,
      detail: `index=${String(libraryIndexOutput).slice(0, 80)} search=${String(librarySearchOutput).slice(0, 60)}`,
    }
    await fs.promises.rm(dir, { recursive: true, force: true })
  } catch (error) {
    modules['document tools'] = { ok: false, error: errorMessage(error) }
  }

  const ok = agent.ok && pty.ok && Object.values(modules).every((report) => report.ok)

  return {
    ok,
    modules,
    pty,
    agent,
    versions: {
      node: process.versions.node,
      electron: process.versions.electron ?? '',
      chrome: process.versions.chrome ?? '',
      platform: process.platform,
      arch: process.arch,
    },
  }
}
