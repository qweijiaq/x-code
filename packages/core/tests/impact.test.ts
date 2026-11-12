import { afterEach, describe, expect, it } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { analyzeChangeImpact, extractExportedSymbols, formatImpactReport } from '../src/analysis/impact.js'
import { createImpactAnalysisTool } from '../src/tools/impact-analysis.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function project(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xcode-impact-'))
  directories.push(dir)
  await fs.mkdir(path.join(dir, 'src'), { recursive: true })
  await fs.writeFile(path.join(dir, 'src', 'b.ts'), 'export const value = 1\n', 'utf8')
  await fs.writeFile(
    path.join(dir, 'src', 'a.ts'),
    "import { value } from './b'\nexport const doubled = value * 2\n",
    'utf8',
  )
  await fs.writeFile(
    path.join(dir, 'src', 'a.test.ts'),
    "import { doubled } from './a'\nexport const test = doubled\n",
    'utf8',
  )
  return dir
}

describe('change impact analysis', () => {
  it('finds direct and transitive dependents plus related tests', async () => {
    const dir = await project()
    const report = await analyzeChangeImpact({ cwd: dir, files: ['src/b.ts'], useGit: false })

    expect(report.changed).toEqual(['src/b.ts'])
    expect(report.directDependents).toContain('src/a.ts')
    expect(report.transitiveDependents).toContain('src/a.test.ts')
    expect(report.tests).toContain('src/a.test.ts')
    expect(report.scannedFiles).toBe(3)
  })

  it('resolves tsconfig baseUrl/paths aliases', async () => {
    const dir = await project()
    await fs.writeFile(
      path.join(dir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
      'utf8',
    )
    await fs.writeFile(
      path.join(dir, 'src', 'a.ts'),
      "import { value } from '@/b'\nexport const doubled = value * 2\n",
      'utf8',
    )

    const report = await analyzeChangeImpact({ cwd: dir, files: ['src/b.ts'], useGit: false })
    expect(report.directDependents).toContain('src/a.ts')
  })

  it('resolves monorepo workspace package imports', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xcode-impact-monorepo-'))
    directories.push(dir)
    await fs.mkdir(path.join(dir, 'packages', 'utils', 'src'), { recursive: true })
    await fs.mkdir(path.join(dir, 'packages', 'app', 'src'), { recursive: true })
    await fs.writeFile(
      path.join(dir, 'packages', 'utils', 'package.json'),
      JSON.stringify({ name: '@demo/utils', main: 'src/index.ts' }),
      'utf8',
    )
    await fs.writeFile(path.join(dir, 'packages', 'utils', 'src', 'index.ts'), 'export const value = 1\n', 'utf8')
    await fs.writeFile(
      path.join(dir, 'packages', 'app', 'src', 'a.ts'),
      "import { value } from '@demo/utils'\nexport const doubled = value * 2\n",
      'utf8',
    )

    const report = await analyzeChangeImpact({
      cwd: dir,
      files: ['packages/utils/src/index.ts'],
      useGit: false,
    })
    expect(report.directDependents).toContain('packages/app/src/a.ts')
  })

  it('is callable as a read-only tool', async () => {
    const dir = await project()
    const tool = createImpactAnalysisTool(dir)
    const result = await (
      tool as unknown as {
        execute: (
          input: unknown,
          options: { toolCallId: string },
        ) => Promise<{
          report: { directDependents: string[] }
          summary: string
        }>
      }
    ).execute({ files: ['src/b.ts'] }, { toolCallId: 't' })
    expect(result.report.directDependents).toContain('src/a.ts')
    expect(result.summary).toContain('Direct dependents')
  })

  it('extracts exported symbols with positions for LSP references', () => {
    const symbols = extractExportedSymbols(
      ['export const first = 1', 'export async function second() {}', 'export interface Third {}'].join('\n'),
    )
    expect(symbols.map((symbol) => symbol.name)).toEqual(['first', 'second', 'Third'])
    expect(symbols[1]).toMatchObject({ line: 2 })
  })

  it('returns an empty report when there is nothing to analyze', async () => {
    const dir = await project()
    const report = await analyzeChangeImpact({ cwd: dir, useGit: false })
    expect(report.changed).toEqual([])
    expect(report.notes.join(' ')).toContain('No changed code files')
  })

  it('formats a readable report', async () => {
    const dir = await project()
    const report = await analyzeChangeImpact({ cwd: dir, files: ['src/b.ts'], useGit: false })
    const text = formatImpactReport(report)
    expect(text).toContain('Change impact')
    expect(text).toContain('Direct dependents')
    expect(text).toContain('src/a.ts')
  })
})
