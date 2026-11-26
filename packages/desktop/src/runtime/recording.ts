// @x-code-cli/desktop — 语音录音转写
//
// 把 renderer 传来的 base64 WAV 落到 ~/.x-code/attachments，交给 core 的本地
// whisper 转写，完成后删除临时文件。进度通过注入的 onNotice 回传。
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { transcribeAudio, userXcodeDir } from '@x-code-cli/core'

export async function transcribeRecording(
  data: string,
  mime: string,
  language: string | undefined,
  onNotice: (message: string) => void,
): Promise<{ text: string }> {
  // codec 参数（`audio/wav;codecs=1`）与大小写差异不该被判成不支持的格式，
  // 与 pasted-images 的 savePastedImage 保持同一套归一化。
  const normalizedMime = (mime ?? '').toLowerCase().split(';')[0]?.trim() ?? ''
  if (normalizedMime !== 'audio/wav' && normalizedMime !== 'audio/x-wav') throw new Error('不支持的录音格式')
  if (typeof data !== 'string' || !data.trim()) throw new Error('录音内容为空')
  const buffer = Buffer.from(data, 'base64')
  if (buffer.length === 0) throw new Error('录音内容为空')
  if (buffer.length > 50_000_000) throw new Error('录音超过 50MB')
  // RIFF....WAVE 魔数：data URL 前缀或被截断的 base64 会被容错解码成一个畸形
  // WAV，然后在 whisper 深处报出与真实原因无关的错误。
  if (buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('录音内容不是有效的 WAV 数据')
  }
  const dir = path.join(userXcodeDir(), 'attachments')
  await fs.promises.mkdir(dir, { recursive: true })
  // 时间戳 + 随机后缀：两次录音落在同一毫秒时会互相覆盖，先完成的一方
  // 在 finally 里 unlink 还会删掉另一份仍在转写的文件。
  const file = path.join(dir, `recording-${Date.now()}-${randomUUID().slice(0, 8)}.wav`)
  // 写入放进 try：写盘中途失败（ENOSPC）时 finally 仍会清掉半成品。
  try {
    await fs.promises.writeFile(file, buffer, { mode: 0o600 })
    const result = await transcribeAudio(file, {
      ...(language ? { language } : {}),
      onNotice,
    })
    if (typeof result === 'string') throw new Error(result)
    return { text: result.text.trim() }
  } finally {
    await fs.promises.unlink(file).catch(() => undefined)
  }
}
