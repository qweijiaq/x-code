import { describe, expect, it } from 'vitest'

import { encodeWav, sampleCount } from '../src/renderer/wav.js'

function ascii(buffer: ArrayBuffer, offset: number, length: number): string {
  return String.fromCharCode(...new Uint8Array(buffer, offset, length))
}

describe('WAV encoding for voice input', () => {
  it('writes a mono 16-bit PCM header and samples', () => {
    const chunks = [new Float32Array([0, 0.5, -0.5]), new Float32Array([1])]
    expect(sampleCount(chunks)).toBe(4)
    const buffer = encodeWav(chunks, 48_000)
    const view = new DataView(buffer)

    expect(ascii(buffer, 0, 4)).toBe('RIFF')
    expect(ascii(buffer, 8, 4)).toBe('WAVE')
    expect(ascii(buffer, 12, 4)).toBe('fmt ')
    expect(view.getUint16(20, true)).toBe(1)
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint32(24, true)).toBe(48_000)
    expect(view.getUint32(28, true)).toBe(96_000)
    expect(view.getUint16(34, true)).toBe(16)
    expect(ascii(buffer, 36, 4)).toBe('data')
    expect(view.getUint32(40, true)).toBe(8)
    expect(view.getInt16(44, true)).toBe(0)
    expect(view.getInt16(46, true)).toBe(16_383)
    expect(view.getInt16(48, true)).toBe(-16_384)
    expect(view.getInt16(50, true)).toBe(32_767)
    expect(buffer.byteLength).toBe(52)
  })
})
