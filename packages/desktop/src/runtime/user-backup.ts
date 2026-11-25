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
  const exists = await fs.promises.stat(target).then(
    () => true,
    () => false,
  )
  if (exists) return false
  await fs.promises.mkdir(path.dirname(target), { recursive: true })
  // force:false 已保证不覆盖已有文件；不再使用 errorOnExist，否则一个已存在的
  // 嵌套条目（并发导入、上次中断残留）会让整次导入中途失败且无法回滚。
  await fs.promises.cp(source, target, { recursive: true, force: false, errorOnExist: false, dereference: false })
  return true
}

/** 把用户数据复制到一个新的带时间戳的文件夹。目标父目录必须
 *  已存在。只复制已知的顶层文件夹；secret、插件、
 *  附件和日志被刻意排除。 */
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
    // 只把“目录不存在”当作空目录；EACCES/ENOTDIR/ELOOP 等读取失败必须抛出，
    // 否则拼错路径/权限不足时会导出一个 counts 全 0 的“成功”备份。
    const entries = await fs.promises.readdir(source, { withFileTypes: true }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return []
      throw new Error(`无法读取备份源目录 ${name}：${(error as Error).message}`)
    })
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

/** 从备份恢复缺失的条目。已有的会话、技能和命令绝不会被覆盖，
 *  因此导入到正在使用的 home 是安全的。 */
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
