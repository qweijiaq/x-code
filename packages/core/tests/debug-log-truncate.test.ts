// src/utils.ts:truncateForLog 的回归测试
//
// 背景：早期实现在计算 `sliceLen = maxBytes - 64` 之后用 `s.slice(0, sliceLen)` 截断字符串。
// 这统计的是 UTF-16 code unit 而不是 UTF-8 字节 —— 对 CJK / emoji 输入，返回的字符串
// 通常会超出 maxBytes 约 3-4 倍，使 MAX_LINE_BYTES 失效，并让单个 debug 条目突破预算。
// sub-agent `code-reviewer` 在一次 §3d 测试通过期间标记了该问题；这个锁存测试覆盖按字节精确的实现。
import { describe, expect, it } from 'vitest'

import { truncateForLog } from '../src/utils.js'

describe('truncateForLog', () => {
  it('returns ASCII input unchanged when under maxBytes', () => {
    const s = 'hello world'
    expect(truncateForLog(s, 1024)).toBe(s)
  })

  it('returns CJK input unchanged when its byte size fits', () => {
    // 10 个字符 * 3 字节 = 30 字节 < 1024
    const s = '中文测试一二三四五六'
    expect(truncateForLog(s, 1024)).toBe(s)
  })

  it('truncates ASCII to within maxBytes', () => {
    const s = 'a'.repeat(2000)
    const out = truncateForLog(s, 1024)
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(1024)
    expect(out).toMatch(/<\+\d+b truncated>$/)
  })

  it('truncates CJK by BYTES not by JS char index (regression)', () => {
    // 1000 个「龙」× 3 字节/字 = 总计 3000 UTF-8 字节。
    // 旧实现：sliceLen = 1024 - 64 = 960，s.slice(0, 960) 返回 960 个字符 = 2880 字节 ——
    // 几乎是 maxBytes 预算的 3 倍。正确实现改为切分 UTF-8 buffer。
    const s = '龙'.repeat(1000)
    const out = truncateForLog(s, 1024)
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(1024)
    expect(out).toContain('truncated')
  })

  it('truncates emoji input without exceeding maxBytes', () => {
    // 🐉 在 UTF-8 中是 4 字节（在 UTF-16 中是 2 个 code unit / 代理对）。
    // 旧的按字符切分逻辑把两个维度都算错了。
    const s = '🐉'.repeat(500) // 约 2000 UTF-8 字节
    const out = truncateForLog(s, 512)
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(512)
  })

  it('reports dropped bytes in the marker (not char count)', () => {
    // 1000 个「龙」= 3000 字节；sliceLen = 960；丢弃 = 3000 - 960 = 2040。
    // 标记应反映字节数（'b' 后缀），而不是过去打印的字符数（'c'），
    // 因为该函数的契约是基于字节的。
    const s = '龙'.repeat(1000)
    const out = truncateForLog(s, 1024)
    const match = out.match(/<\+(\d+)b truncated>$/)
    expect(match).not.toBeNull()
    const droppedBytes = Number(match![1])
    // 应约为 3000 - 960 = 2040。留出一些余量，因为
    // TextDecoder 可能在边界处丢弃不完整的码点。
    expect(droppedBytes).toBeGreaterThan(2000)
    expect(droppedBytes).toBeLessThan(2100)
  })
})
