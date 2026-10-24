// 16-bit PCM WAV encoding for the voice-input recorder.
//
// Chromium's MediaRecorder only emits WebM/Opus, which the bundled whisper
// decoder does not accept. Recording raw Float32 samples from the Web Audio
// graph and wrapping them in a WAV container keeps the transcription path
// identical to normal audio files.

export function encodeWav(chunks: readonly Float32Array[], sampleRate: number): ArrayBuffer {
  const sampleCount = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const bytesPerSample = 2
  const buffer = new ArrayBuffer(44 + sampleCount * bytesPerSample)
  const view = new DataView(buffer)

  const writeString = (offset: number, value: string): void => {
    for (let index = 0; index < value.length; index++) view.setUint8(offset + index, value.charCodeAt(index))
  }

  writeString(0, 'RIFF')
  view.setUint32(4, 36 + sampleCount * bytesPerSample, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * bytesPerSample, true)
  view.setUint16(32, bytesPerSample, true)
  view.setUint16(34, 16, true)
  writeString(36, 'data')
  view.setUint32(40, sampleCount * bytesPerSample, true)

  let offset = 44
  for (const chunk of chunks) {
    for (let index = 0; index < chunk.length; index++) {
      const sample = Math.max(-1, Math.min(1, chunk[index]))
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
      offset += 2
    }
  }
  return buffer
}

export function sampleCount(chunks: readonly Float32Array[]): number {
  return chunks.reduce((sum, chunk) => sum + chunk.length, 0)
}
