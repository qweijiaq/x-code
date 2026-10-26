import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { downloadUpdateArtifact, parseReleaseInfo, pickUpdateArtifact, resolveArtifactUrl } from '../src/main/update.js'

const payload = Buffer.from('fake installer bytes')
const sha256 = createHash('sha256').update(payload).digest('hex')

function release(overrides: Record<string, unknown> = {}) {
  return parseReleaseInfo({
    version: '1.2.3',
    artifacts: [
      { file: 'X-Code-1.2.3-arm64.zip', size: payload.length, sha256 },
      { file: 'X-Code-1.2.3-arm64.dmg', size: payload.length, sha256 },
      { file: 'X-Code-1.2.3-x64.exe', size: payload.length, sha256 },
      { file: 'X-Code-1.2.3-x64.AppImage', size: payload.length, sha256 },
    ],
    ...overrides,
  })
}

describe('release metadata', () => {
  it('validates version and normalizes artifacts', () => {
    expect(release().version).toBe('1.2.3')
    expect(release().artifacts[0]).toEqual({
      file: 'X-Code-1.2.3-arm64.zip',
      size: payload.length,
      sha256,
    })
    expect(() => parseReleaseInfo({ artifacts: [] })).toThrow('version')
    const parsed = parseReleaseInfo({
      version: '2.0.0',
      url: 'https://example.com/release',
      notes: 'notes',
      artifacts: [{ file: 'C:\\builds\\X-Code.exe', sha256: 'not-a-hash' }],
    })
    expect(parsed).toMatchObject({ url: 'https://example.com/release', notes: 'notes' })
    expect(parsed.artifacts).toEqual([{ file: 'X-Code.exe' }])
  })

  it('picks the installer for the platform and architecture', () => {
    expect(pickUpdateArtifact(release(), 'darwin', 'arm64')?.file).toBe('X-Code-1.2.3-arm64.dmg')
    expect(pickUpdateArtifact(release(), 'win32', 'x64')?.file).toBe('X-Code-1.2.3-x64.exe')
    expect(pickUpdateArtifact(release(), 'linux', 'x64')?.file).toBe('X-Code-1.2.3-x64.AppImage')
    expect(pickUpdateArtifact(parseReleaseInfo({ version: '1.0.0', artifacts: [] }), 'darwin', 'arm64')).toBeNull()
  })

  it('requires an https feed and resolves the file beside it', () => {
    expect(resolveArtifactUrl('https://example.com/x-code/RELEASE.json', 'X-Code.dmg')).toBe(
      'https://example.com/x-code/X-Code.dmg',
    )
    expect(() => resolveArtifactUrl('http://example.com/RELEASE.json', 'X-Code.dmg')).toThrow('https')
  })
})

describe('downloadUpdateArtifact', () => {
  let dir = ''

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xcode-update-'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('writes the installer and verifies its sha256', async () => {
    const result = await downloadUpdateArtifact({
      feed: 'https://example.com/x-code/RELEASE.json',
      release: release(),
      platform: 'darwin',
      arch: 'arm64',
      destDir: dir,
      fetchImpl: async () => new Response(payload),
    })
    expect(result).toMatchObject({
      version: '1.2.3',
      fileName: 'X-Code-1.2.3-arm64.dmg',
      bytes: payload.length,
      sha256,
    })
    expect(fs.readFileSync(result.filePath)).toEqual(payload)
    expect(fs.existsSync(path.join(dir, 'X-Code-1.2.3-arm64.dmg.part'))).toBe(false)
  })

  it('reports download progress including the declared total', async () => {
    const events: Array<{ receivedBytes: number; totalBytes?: number }> = []
    await downloadUpdateArtifact({
      feed: 'https://example.com/x-code/RELEASE.json',
      release: release(),
      platform: 'darwin',
      arch: 'arm64',
      destDir: dir,
      fetchImpl: async () => new Response(payload, { headers: { 'content-length': String(payload.length) } }),
      onProgress: (progress) => events.push(progress),
    })
    expect(events.length).toBeGreaterThan(0)
    expect(events.at(-1)).toMatchObject({ receivedBytes: payload.length, totalBytes: payload.length })
  })

  it('deletes the partial file when the checksum does not match', async () => {
    await expect(
      downloadUpdateArtifact({
        feed: 'https://example.com/x-code/RELEASE.json',
        release: release(),
        platform: 'darwin',
        arch: 'arm64',
        destDir: dir,
        fetchImpl: async () => new Response(Buffer.from('tampered')),
      }),
    ).rejects.toThrow('sha256')
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it('refuses artifacts without a checksum or for another platform', async () => {
    const noHash = parseReleaseInfo({
      version: '1.0.0',
      artifacts: [{ file: 'X-Code-arm64.dmg' }],
    })
    await expect(
      downloadUpdateArtifact({
        feed: 'https://example.com/RELEASE.json',
        release: noHash,
        platform: 'darwin',
        arch: 'arm64',
        destDir: dir,
      }),
    ).rejects.toThrow('sha256')
    await expect(
      downloadUpdateArtifact({
        feed: 'https://example.com/RELEASE.json',
        release: parseReleaseInfo({
          version: '1.0.0',
          artifacts: [{ file: 'X-Code-arm64.dmg', sha256 }],
        }),
        platform: 'win32',
        arch: 'x64',
        destDir: dir,
      }),
    ).rejects.toThrow('当前平台')
  })
})
