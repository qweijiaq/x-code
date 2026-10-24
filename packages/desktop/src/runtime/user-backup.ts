import fs from 'node:fs'
import path from 'node:path'

export interface BackupCounts {
  sessions: number
  skills: number
  commands: number
  memory: number
  agents: number
}

export interface BackupManifest {
  format: 'x-code-backup'
  version: 1
  createdAt: string
  counts: BackupCounts
  excluded: string[]
}

export interface BackupExportResult {
  path: string
  manifest: BackupManifest
}

export interface BackupImportResult {
  path: string
  imported: BackupCounts
  skipped: BackupCounts
  manifest: BackupManifest
}

const FORMAT = 'x-code-backup'
const EXCLUDED = ['desktop-secrets.json', 'config.json', 'attachments', 'auth', 'plugins', 'logs', 'diagnostics']

function emptyCounts(): BackupCounts {
  return { sessions: 0, skills: 0, commands: 0, memory: 0, agents: 0 }
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function isDirectory(entry: fs.Dirent): boolean {
  return entry.isDirectory() && !entry.isSymbolicLink()
}

function isFile(entry: fs.Dirent): boolean {
  return entry.isFile() && !entry.isSymbolicLink()
}

async function copyMissing(source: string, target: string): Promise<boolean> {
  if (fs.existsSync(target)) return false
  await fs.promises.mkdir(path.dirname(target), { recursive: true })
  await fs.promises.cp(source, target, { recursive: true, errorOnExist: true, force: false })
  return true
}

/** Copy user data into a new timestamped folder. The destination parent must
 *  already exist. Only known top-level folders are copied; secrets, plugins,
 *  attachments and logs are deliberately excluded. */
export async function exportUserBackup(
  sourceRoot: string,
  destinationParent: string,
  appVersion = '',
): Promise<BackupExportResult> {
  const parent = path.resolve(destinationParent)
  const parentStat = await fs.promises.stat(parent).catch(() => null)
  if (!parentStat?.isDirectory()) throw new Error('备份目标文件夹不存在')
  const target = path.join(parent, `x-code-backup-${timestamp()}`)
  await fs.promises.mkdir(target, { recursive: true })
  const counts = emptyCounts()

  const copyFolder = async (
    name: string,
    kind: 'files' | 'entries',
    counter: keyof BackupCounts,
    filter?: (entry: fs.Dirent) => boolean,
  ): Promise<void> => {
    const source = path.join(sourceRoot, name)
    const entries = await fs.promises.readdir(source, { withFileTypes: true }).catch(() => [])
    const selected = entries.filter((entry) => {
      if (kind === 'files') return isFile(entry) && (filter ? filter(entry) : true)
      return (isDirectory(entry) || isFile(entry)) && (filter ? filter(entry) : true)
    })
    if (selected.length === 0) return
    const destination = path.join(target, name)
    await fs.promises.mkdir(destination, { recursive: true })
    for (const entry of selected) {
      await fs.promises.cp(path.join(source, entry.name), path.join(destination, entry.name), {
        recursive: true,
        dereference: false,
      })
      counts[counter] += 1
    }
  }

  await copyFolder('sessions', 'files', 'sessions', (entry) => entry.name.endsWith('.jsonl'))
  await copyFolder('skills', 'entries', 'skills', (entry) => isDirectory(entry))
  await copyFolder('commands', 'entries', 'commands')
  await copyFolder('memory', 'entries', 'memory')
  await copyFolder('agents', 'entries', 'agents')

  const manifest: BackupManifest = {
    format: FORMAT,
    version: 1,
    createdAt: new Date().toISOString(),
    counts,
    excluded: EXCLUDED,
  }
  await fs.promises.writeFile(
    path.join(target, 'manifest.json'),
    `${JSON.stringify({ ...manifest, appVersion }, null, 2)}\n`,
    'utf-8',
  )
  return { path: target, manifest }
}

async function readManifest(backupDir: string): Promise<BackupManifest> {
  const raw = await fs.promises.readFile(path.join(backupDir, 'manifest.json'), 'utf-8').catch(() => '')
  if (!raw.trim()) throw new Error('所选文件夹不是 X-Code 备份（缺少 manifest.json）')
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error('备份的 manifest.json 无法解析')
  }
  const record = data && typeof data === 'object' ? (data as Record<string, unknown>) : {}
  if (record.format !== FORMAT || record.version !== 1) throw new Error('不支持的备份格式或版本')
  return record as unknown as BackupManifest
}

/** Restore missing entries from a backup. Existing sessions, skills and
 *  commands are never overwritten, so importing into a live home is safe. */
export async function importUserBackup(backupDir: string, targetRoot: string): Promise<BackupImportResult> {
  const source = path.resolve(backupDir)
  const manifest = await readManifest(source)
  const imported = emptyCounts()
  const skipped = emptyCounts()

  const restore = async (name: string, counter: keyof BackupCounts, filesOnly = false): Promise<void> => {
    const from = path.join(source, name)
    const entries = await fs.promises.readdir(from, { withFileTypes: true }).catch(() => [])
    const target = path.join(targetRoot, name)
    for (const entry of entries) {
      if (filesOnly ? !isFile(entry) : !(isFile(entry) || isDirectory(entry))) continue
      const destination = path.join(target, entry.name)
      if (await copyMissing(path.join(from, entry.name), destination)) imported[counter] += 1
      else skipped[counter] += 1
    }
  }

  await restore('sessions', 'sessions', true)
  await restore('skills', 'skills')
  await restore('commands', 'commands')
  await restore('memory', 'memory')
  await restore('agents', 'agents')
  return { path: source, imported, skipped, manifest }
}
