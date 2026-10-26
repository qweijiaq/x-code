#!/usr/bin/env node
/**
 * 确保多语言 Whisper "tiny" 模型可用于打包。
 *
 * 顺序：
 *   1. 已有效的 build/whisper/ggml-tiny.bin
 *   2. 本地用户缓存（~/.x-code/whisper-models）
 *   3. 从 huggingface.co 下载，其次 hf-mirror.com
 *
 * 设置 X_CODE_SKIP_BUNDLED_WHISPER=1 可跳过（安装器随后会在首次语音使用时下载，
 * 与之前一致）。
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const FILENAME = 'ggml-tiny.bin'
const BYTES = 77_691_713
const SHA256 = 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21'
const REVISION = '5359861c739e955e79d9a303bcbc70fb988958b1'
const URLS = [
  `https://huggingface.co/ggerganov/whisper.cpp/resolve/${REVISION}/${FILENAME}`,
  `https://hf-mirror.com/ggerganov/whisper.cpp/resolve/${REVISION}/${FILENAME}`,
]

const root = path.resolve(import.meta.dirname, '..')
const targetDir = path.join(root, 'packages/desktop/build/whisper')
const target = path.join(targetDir, FILENAME)

function isValid(file) {
  try {
    const stat = fs.statSync(file)
    if (stat.size !== BYTES) return false
    const hash = createHash('sha256').update(fs.readFileSync(file)).digest('hex')
    return hash === SHA256
  } catch {
    return false
  }
}

function copyIfValid(source) {
  if (!isValid(source)) return false
  fs.mkdirSync(targetDir, { recursive: true })
  fs.copyFileSync(source, `${target}.tmp`)
  fs.renameSync(`${target}.tmp`, target)
  console.log(`[whisper] bundled model copied from ${source}`)
  return true
}

async function download(url) {
  console.log(`[whisper] downloading from ${new URL(url).host}…`)
  const response = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) })
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} ${response.statusText}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length !== BYTES) throw new Error(`got ${buffer.length} bytes, expected ${BYTES}`)
  const hash = createHash('sha256').update(buffer).digest('hex')
  if (hash !== SHA256) throw new Error('checksum mismatch')
  fs.mkdirSync(targetDir, { recursive: true })
  fs.writeFileSync(`${target}.tmp`, buffer)
  fs.renameSync(`${target}.tmp`, target)
  console.log(`[whisper] saved ${target}`)
}

function writeLicense() {
  const license = `Whisper model weights (${FILENAME})

The ggml model is converted from OpenAI Whisper.
OpenAI Whisper: Copyright (c) 2022 OpenAI, released under the MIT License.
whisper.cpp: Copyright (c) 2022 Georgi Gerganov, released under the MIT License.
`
  fs.writeFileSync(path.join(targetDir, 'LICENSE.txt'), license)
}

if (process.env.X_CODE_SKIP_BUNDLED_WHISPER === '1') {
  fs.mkdirSync(targetDir, { recursive: true })
  writeLicense()
  console.log('[whisper] bundling skipped (X_CODE_SKIP_BUNDLED_WHISPER=1)')
  process.exit(0)
}

if (isValid(target)) {
  writeLicense()
  console.log('[whisper] model already present')
  process.exit(0)
}

const home = process.env.X_CODE_HOME?.trim() || path.join(os.homedir(), '.x-code')
if (copyIfValid(path.join(home, 'whisper-models', FILENAME))) {
  writeLicense()
  process.exit(0)
}

let lastError
for (const url of URLS) {
  try {
    await download(url)
    writeLicense()
    process.exit(0)
  } catch (error) {
    lastError = error
    console.warn(`[whisper] ${new URL(url).host} failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

console.error(`[whisper] could not prepare the bundled model: ${lastError?.message ?? 'unknown error'}`)
console.error('[whisper] Set X_CODE_SKIP_BUNDLED_WHISPER=1 to build without it, or place a valid file at:')
console.error(`  ${target}`)
process.exit(1)
