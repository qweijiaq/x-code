// @x-code-cli/core — readDocument tool
//
// Deterministic, local extraction for documents and media. Unlike readFile,
// which is optimized for source code, this tool understands document formats
// and returns bounded text plus lightweight metadata. No document bytes are
// sent to a model; OCR, transcription, and parsing happen locally.
import { tool } from 'ai'

import { z } from 'zod'

import { formatDocumentResult, readDocument } from '../agent/document-extract.js'
import { formatToolError } from '../utils/tool-errors.js'
import { reportProgress } from './progress.js'

export const readDocumentTool = tool({
  description:
    'Read and extract text/metadata from a local document. Supports PDF, Word (.docx), Excel (.xlsx/.csv/.tsv), ' +
    'PowerPoint (.pptx), OpenDocument (.odt/.ods/.odp), Markdown/text, EPUB, MOBI/AZW, images (local OCR), ' +
    'audio (local transcription), and video metadata/frames. Extraction is local and deterministic; output is ' +
    'truncated to a character budget. Use this instead of readFile for documents and media. Images are OCR-only ' +
    'here; use readFile when you need visual understanding (vision-capable models receive the image itself). For ' +
    'PDFs, pass pages like "1-5,8"; pages without a text layer (scanned pages) are rendered and OCRed locally, ' +
    'up to 10 pages, which costs seconds of local time but no tokens — set ocr=false to skip that; for audio, set ' +
    'transcribe=false to skip local transcription; for video, extractFrames writes still frames to temp files ' +
    '(requires ffmpeg) and returns their paths.',
  inputSchema: z.object({
    filePath: z.string().describe('Absolute path to the document, image, audio, or video file'),
    maxChars: z
      .number()
      .int()
      .min(1_000)
      .max(200_000)
      .optional()
      .describe('Maximum characters of extracted text (default 50000)'),
    pages: z.string().optional().describe('PDF page range, e.g. "1-5,8". Defaults to the first 200 pages'),
    ocr: z
      .boolean()
      .optional()
      .describe('For PDFs: run local OCR on pages without a text layer (default true, up to 10 such pages)'),
    transcribe: z.boolean().optional().describe('For audio: run local whisper.cpp transcription (default true)'),
    extractFrames: z
      .number()
      .int()
      .min(0)
      .max(10)
      .optional()
      .describe('For video: extract this many still frames to temp files (requires ffmpeg)'),
  }),
  execute: async ({ filePath, maxChars, pages, ocr, transcribe, extractFrames }, { toolCallId, abortSignal }) => {
    try {
      abortSignal?.throwIfAborted()
      reportProgress(toolCallId, `Reading document ${filePath}`)
      const result = await readDocument(filePath, {
        maxChars,
        pages,
        ocr,
        transcribe,
        extractFrames,
        abortSignal,
        onProgress: (message) => reportProgress(toolCallId, message),
      })
      return formatDocumentResult(result)
    } catch (error) {
      return formatToolError('reading document', error)
    }
  },
})
