// 测试 glob 工具
import { describe, expect, it } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { glob } from '../src/tools/glob.js'

describe('glob tool', () => {
  it('finds files matching a pattern', async () => {
    // 使用包含已知文件的临时目录
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-glob-test-'))
    await fs.writeFile(path.join(tmpDir, 'a.ts'), 'const a = 1')
    await fs.writeFile(path.join(tmpDir, 'b.ts'), 'const b = 2')
    await fs.writeFile(path.join(tmpDir, 'c.js'), 'const c = 3')

    const result = await glob.execute!({ pattern: '*.ts', cwd: tmpDir }, {
      toolCallId: 'test',
      messages: [],
      abortSignal: undefined,
    } as any)
    expect(result).toContain('a.ts')
    expect(result).toContain('b.ts')
    expect(result).not.toContain('c.js')

    // 清理
    await fs.rm(tmpDir, { recursive: true })
  })

  it('returns message when no files match', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-glob-test-'))

    const result = await glob.execute!({ pattern: '*.xyz', cwd: tmpDir }, {
      toolCallId: 'test',
      messages: [],
      abortSignal: undefined,
    } as any)
    expect(result).toContain('No files found')

    await fs.rm(tmpDir, { recursive: true })
  })

  it('finds files with ** pattern', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-glob-test-'))
    await fs.mkdir(path.join(tmpDir, 'sub'), { recursive: true })
    await fs.writeFile(path.join(tmpDir, 'sub', 'deep.ts'), 'export {}')

    const result = await glob.execute!({ pattern: '**/*.ts', cwd: tmpDir }, {
      toolCallId: 'test',
      messages: [],
      abortSignal: undefined,
    } as any)
    expect(result).toContain('deep.ts')

    await fs.rm(tmpDir, { recursive: true })
  })

  it('truncates results when exceeding the cap (200)', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-glob-cap-'))
    const count = 210
    for (let i = 0; i < count; i++) {
      await fs.writeFile(path.join(tmpDir, `file-${String(i).padStart(4, '0')}.ts`), '')
    }

    const result = (await glob.execute!({ pattern: '*.ts', cwd: tmpDir }, {
      toolCallId: 'test',
      messages: [],
      abortSignal: undefined,
    } as any)) as string
    expect(result).toContain('more files not shown')
    expect(result).toContain('capped at 200')
    const lines = result.split('\n').filter((l) => l.includes('.ts') && !l.includes('...'))
    expect(lines.length).toBeLessThanOrEqual(200)

    await fs.rm(tmpDir, { recursive: true })
  })

  // 回归修复：描述字符串承诺「按修改时间排序，最近的在前」。早期实现使用 globby
  // 且没有显式排序，结果落到字母顺序 —— 描述与行为不一致。现在 glob 委托给
  // `rg --sortr=modified`，因此最近修改的文件必须排在最前。
  it('returns files sorted by modification time, most recent first', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-glob-sort-'))
    // 按字母顺序创建文件，但以相反的顺序写入 mtime，让字母排序不等于 mtime 排序。
    const files = ['a.ts', 'b.ts', 'c.ts']
    for (const f of files) {
      await fs.writeFile(path.join(tmpDir, f), '')
    }
    // a.ts 最旧，c.ts 最新
    const baseTime = Date.now()
    await fs.utimes(path.join(tmpDir, 'a.ts'), new Date(baseTime - 3000), new Date(baseTime - 3000))
    await fs.utimes(path.join(tmpDir, 'b.ts'), new Date(baseTime - 2000), new Date(baseTime - 2000))
    await fs.utimes(path.join(tmpDir, 'c.ts'), new Date(baseTime - 1000), new Date(baseTime - 1000))

    const result = (await glob.execute!({ pattern: '*.ts', cwd: tmpDir }, {
      toolCallId: 'test',
      messages: [],
      abortSignal: undefined,
    } as any)) as string

    const lines = result.split('\n').filter((l) => l.endsWith('.ts'))
    // 最新（c.ts）必须排在结果中较旧文件之前。
    const cIdx = lines.findIndex((l) => l.endsWith('c.ts'))
    const bIdx = lines.findIndex((l) => l.endsWith('b.ts'))
    const aIdx = lines.findIndex((l) => l.endsWith('a.ts'))
    expect(cIdx).toBeGreaterThanOrEqual(0)
    expect(cIdx).toBeLessThan(bIdx)
    expect(bIdx).toBeLessThan(aIdx)

    await fs.rm(tmpDir, { recursive: true })
  })

  // 回归修复：ripgrep 的 `--glob "**/*"` 被视为会覆盖 .gitignore 的白名单，
  // 因此把模型的 catch-all 模式原样传入会返回成千上万个 node_modules / .git 文件。
  // 该工具检测到 catch-all 模式后丢弃 --glob，改由 ripgrep 默认遍历（会遵守 .gitignore）。
  it('catch-all pattern (**/*) honors .gitignore', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-glob-catchall-'))
    // 创建一个排除 "junk/" 的假 .gitignore
    await fs.writeFile(path.join(tmpDir, '.gitignore'), 'junk/\n')
    await fs.writeFile(path.join(tmpDir, 'keep.ts'), '')
    await fs.mkdir(path.join(tmpDir, 'junk'), { recursive: true })
    await fs.writeFile(path.join(tmpDir, 'junk', 'noise.ts'), '')
    // 需要 .git 目录让 ripgrep 把该目录识别为 git 树并采纳本地 .gitignore。
    await fs.mkdir(path.join(tmpDir, '.git'), { recursive: true })

    const result = (await glob.execute!({ pattern: '**/*', cwd: tmpDir }, {
      toolCallId: 'test',
      messages: [],
      abortSignal: undefined,
    } as any)) as string

    expect(result).toContain('keep.ts')
    // junk/ 目录必须被 .gitignore 排除 —— 如果 --glob "**/*" 泄漏了白名单覆盖，
    // junk/noise.ts 就会出现。
    expect(result).not.toContain('noise.ts')

    await fs.rm(tmpDir, { recursive: true })
  })

  // 回归修复：--hidden 会走进 .git/，因为 .gitignore 通常不会列出它（git 自己管理 .git/）。
  // 没有显式的 `--glob '!.git'` 时，结果会包含 .git/objects/<hash> 文件、.git/HEAD、
  // .git/config 等 —— 成千上万个模型根本不该看到的内部状态文件。
  it('excludes .git/ directory contents', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-glob-gitdir-'))
    await fs.writeFile(path.join(tmpDir, 'real.ts'), '')
    await fs.mkdir(path.join(tmpDir, '.git', 'objects'), { recursive: true })
    await fs.writeFile(path.join(tmpDir, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    await fs.writeFile(path.join(tmpDir, '.git', 'config'), '[core]\n')
    await fs.writeFile(path.join(tmpDir, '.git', 'objects', 'abc123'), 'binary')

    const result = (await glob.execute!({ pattern: '**/*', cwd: tmpDir }, {
      toolCallId: 'test',
      messages: [],
      abortSignal: undefined,
    } as any)) as string

    expect(result).toContain('real.ts')
    // .git 的内部文件都不应泄漏出来。
    expect(result).not.toContain('HEAD')
    expect(result).not.toContain('abc123')
    // Config 可能匹配到独立的 config 令牌 —— 断言路径片段而不是裸词。
    expect(result).not.toContain(`.git${path.sep}config`)

    await fs.rm(tmpDir, { recursive: true })
  })
})
