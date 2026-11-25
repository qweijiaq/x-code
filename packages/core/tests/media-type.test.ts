import { describe, expect, it } from 'vitest'

import { knownMediaTypeFor, mediaTypeFor } from '../src/utils/media-type.js'

describe('mediaTypeFor', () => {
  it('maps .jpg to image/jpeg', () => {
    expect(mediaTypeFor('photo.jpg')).toBe('image/jpeg')
  })

  it('maps .jpeg to image/jpeg', () => {
    expect(mediaTypeFor('photo.jpeg')).toBe('image/jpeg')
  })

  it('maps .png to image/png', () => {
    expect(mediaTypeFor('screenshot.png')).toBe('image/png')
  })

  it('maps .webp to image/webp', () => {
    expect(mediaTypeFor('hero.webp')).toBe('image/webp')
  })

  it('maps .gif to image/gif', () => {
    expect(mediaTypeFor('animation.gif')).toBe('image/gif')
  })

  it('maps .bmp to image/bmp', () => {
    expect(mediaTypeFor('bitmap.bmp')).toBe('image/bmp')
  })

  it('maps TIFF explicitly and safely rejects unknown extensions', () => {
    expect(mediaTypeFor('file.tiff')).toBe('image/tiff')
    expect(knownMediaTypeFor('file.svg')).toBeNull()
    expect(knownMediaTypeFor('noext')).toBeNull()
  })

  it('falls back to a neutral media type for unknown extensions', () => {
    // 回退到 image/png 会让音频/视频/文本被按图片解析；回退值必须中性。
    expect(mediaTypeFor('file.svg')).toBe('application/octet-stream')
    expect(mediaTypeFor('noext')).toBe('application/octet-stream')
  })

  it('handles case-insensitive extensions', () => {
    expect(mediaTypeFor('photo.JPG')).toBe('image/jpeg')
    expect(mediaTypeFor('photo.PNG')).toBe('image/png')
    expect(mediaTypeFor('photo.WebP')).toBe('image/webp')
  })
})
