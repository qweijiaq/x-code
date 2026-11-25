import path from 'node:path'

/** 将已知文件扩展名映射到 IANA 媒体类型，不做猜测。 */
export function knownMediaTypeFor(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.png') return 'image/png'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.bmp') return 'image/bmp'
  if (ext === '.tif' || ext === '.tiff') return 'image/tiff'
  // 音频
  if (ext === '.mp3') return 'audio/mpeg'
  if (ext === '.wav') return 'audio/wav'
  if (ext === '.m4a') return 'audio/mp4'
  if (ext === '.ogg' || ext === '.opus') return 'audio/ogg'
  if (ext === '.flac') return 'audio/flac'
  if (ext === '.aac') return 'audio/aac'
  if (ext === '.aiff' || ext === '.aif') return 'audio/aiff'
  if (ext === '.wma') return 'audio/x-ms-wma'
  if (ext === '.webm') return 'audio/webm'
  return null
}

/**
 * @deprecated 请使用 knownMediaTypeFor() 并处理 null。此兼容性回退仅保留
 * 一个发布周期；摄取代码不得使用它。
 *
 * 未知扩展名的回退值必须是中性的：以前回退到 `image/png` 会让音频/视频/文本
 * 文件被下游按图片解析（`{ type: 'file', mediaType: 'image/png' }`），报错
 * 位置离真实原因很远且没有任何日志线索。
 */
export function mediaTypeFor(filePath: string): string {
  return knownMediaTypeFor(filePath) ?? 'application/octet-stream'
}
