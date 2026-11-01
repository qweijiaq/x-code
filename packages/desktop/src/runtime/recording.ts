// @x-code-cli/desktop — 语音录音转写
//
// 把 renderer 传来的 base64 WAV 落到 ~/.x-code/attachments，交给 core 的本地
// whisper 转写，完成后删除临时文件。进度通过注入的 onNotice 回传。
import fs from 'node:fs'
import path from 'node:path'

import { transcribeAudio, userXcodeDir } from '@x-code-cli/core'

export async function transcribeRecording(
  data: string,
  mime: string,
  language: string | undefined,
  onNotice: (message: string) => void,
): Promise<{ text: string }> {
  if (mime !== 'audio/wav' && mime !== 'audio/x-wav') throw new Error('不支持的录音格式')
  const buffer = Buffer.from(data, 'base64')
  if (buffer.length === 0) throw new Error('录音内容为空')
  if (buffer.length > 50_000_000) throw new Error('录音超过 50MB')
  const dir = path.join(userXcodeDir(), 'attachments')
  await fs.promises.mkdir(dir, { recursive: true })
  const file = path.join(dir, `recording-${Date.now()}.wav`)
  await fs.promises.writeFile(file, buffer, { mode: 0o600 })
  try {
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
