// @x-code-cli/core — transcribe tool
//
// On-device speech-to-text for audio files. The audio never leaves the machine;
// the whisper model is downloaded once and cached under the user directory.
import { tool } from 'ai'

import { z } from 'zod'

import type { WhisperModelName } from '../agent/audio-transcribe-models.js'
import { formatTranscription, isAudioFile, transcribeAudio } from '../agent/audio-transcribe.js'
import { formatToolError } from '../utils/tool-errors.js'
import { reportProgress } from './progress.js'

const DEFAULT_MAX_CHARS = 50_000
const HARD_MAX_CHARS = 200_000

export const transcribe = tool({
  description:
    'Transcribe a local audio file to text with the on-device whisper engine (no network upload). Returns ' +
    'timestamped segments by default, or plain text with format:"text". Supports mp3/wav/m4a/aac/flac/ogg/opus/wma. ' +
    'Use readDocument for documents and images; use this when you specifically want a transcript with timestamps.',
  inputSchema: z.object({
    filePath: z.string().min(1).max(4096).describe('Absolute path to the audio file'),
    model: z
      .string()
      .max(20)
      .optional()
      .describe('Whisper model: tiny, base, small, medium, large-v3 (a .en variant is also available). Default tiny'),
    language: z
      .string()
      .max(10)
      .optional()
      .describe('Force an ISO 639-1 language, e.g. "zh" or "en" (auto-detect if omitted)'),
    format: z.enum(['segments', 'text']).optional().describe('segments (default, timestamped) or text'),
    maxChars: z.number().int().min(1_000).max(HARD_MAX_CHARS).optional().describe('Character budget (default 50000)'),
  }),
  execute: async ({ filePath, model, language, format, maxChars }, { toolCallId, abortSignal }) => {
    try {
      abortSignal?.throwIfAborted()
      if (!isAudioFile(filePath)) {
        return `[Not an audio file: ${filePath}. Supported extensions are mp3, wav, m4a, aac, flac, ogg, opus, wma.]`
      }
      reportProgress(toolCallId, `Transcribing ${filePath}`)
      const result = await transcribeAudio(filePath, {
        model: model as WhisperModelName | undefined,
        language,
        abortSignal,
        onProgress: (pct) => reportProgress(toolCallId, `Transcribing… ${pct}%`),
        onNotice: (message) => reportProgress(toolCallId, message),
      })
      if (typeof result === 'string') return result
      const text = format === 'text' ? result.text : formatTranscription(result, filePath)
      const budget = Math.min(HARD_MAX_CHARS, Math.max(1_000, maxChars ?? DEFAULT_MAX_CHARS))
      return text.length > budget ? `${text.slice(0, budget)}\n... [transcript truncated at ${budget} chars]` : text
    } catch (err) {
      return formatToolError('transcribing audio', err)
    }
  },
})
