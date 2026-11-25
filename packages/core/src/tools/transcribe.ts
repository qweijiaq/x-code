// @x-code-cli/core — transcribe 工具
//
// 音频文件的设备端语音转文字。音频从不出本机；whisper 模型下载一次后缓存
// 在用户目录下。
import { tool } from 'ai'

import { z } from 'zod'

import { SUPPORTED_AUDIO_EXTENSIONS } from '../agent/audio-formats.js'
import type { WhisperModelName } from '../agent/audio-transcribe-models.js'
import { WHISPER_MODELS } from '../agent/audio-transcribe-models.js'
import { formatTranscription, isAudioFile, transcribeAudio } from '../agent/audio-transcribe.js'
import { formatToolError } from '../utils/tool-errors.js'
import { reportProgress } from './progress.js'

const DEFAULT_MAX_CHARS = 50_000
const HARD_MAX_CHARS = 200_000

/** 描述与报错文案都从能力的唯一来源派生，避免声明与实际支持再次漂移。 */
const SUPPORTED_EXTENSION_LIST = [...SUPPORTED_AUDIO_EXTENSIONS].map((ext) => ext.slice(1)).join('/')

const WHISPER_MODEL_NAMES = Object.keys(WHISPER_MODELS) as [WhisperModelName, ...WhisperModelName[]]

export const transcribe = tool({
  description:
    'Transcribe a local audio file to text with the on-device whisper engine (no network upload). Returns ' +
    `timestamped segments by default, or plain text with format:"text". Supports ${SUPPORTED_EXTENSION_LIST}. ` +
    'Use readDocument for documents and images; use this when you specifically want a transcript with timestamps.',
  inputSchema: z.object({
    filePath: z.string().min(1).max(4096).describe('Absolute path to the audio file'),
    model: z
      .enum(WHISPER_MODEL_NAMES)
      .optional()
      .describe(
        `Whisper model, one of: ${WHISPER_MODEL_NAMES.join(', ')}. Larger models are more accurate but need a bigger download. Default tiny`,
      ),
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
        return `[Not an audio file: ${filePath}. Supported extensions are ${SUPPORTED_EXTENSION_LIST}.]`
      }
      reportProgress(toolCallId, `Transcribing ${filePath}`)
      const result = await transcribeAudio(filePath, {
        model,
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
