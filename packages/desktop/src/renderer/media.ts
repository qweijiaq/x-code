const IMAGE_ATTACHMENT_RE = /\.(png|jpe?g|gif|webp|bmp)$/i

export function isImageAttachment(filePath: string): boolean {
  return IMAGE_ATTACHMENT_RE.test(filePath)
}

export function base64FromBuffer(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
  }
  return btoa(binary)
}
