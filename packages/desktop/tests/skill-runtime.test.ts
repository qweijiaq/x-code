import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  applySkillRuntimeHints,
  clearLegacySkillRuntime,
  detectSkillManifests,
  skillRuntimeDir,
  skillRuntimeView,
} from '../src/runtime/skill-runtime.js'

let home = ''
let skillDir = ''

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'xcode-skill-runtime-home-'))
  skillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xcode-skill-runtime-skill-'))
  process.env.X_CODE_HOME = home
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: demo\ndescription: demo\n---\nBody\n')
})

afterEach(() => {
  delete process.env.X_CODE_HOME
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(skillDir, { recursive: true, force: true })
})

describe('skill runtime', () => {
  it('derives a stable runtime directory under X_CODE_HOME', () => {
    const dir = skillRuntimeDir({ name: 'demo skill', dir: skillDir })
    expect(dir.startsWith(path.join(home, 'skill-runtime'))).toBe(true)
    expect(dir).toBe(skillRuntimeDir({ name: 'demo skill', dir: skillDir }))
  })

  it('detects Python and Node manifests and reports them as not installed', () => {
    fs.writeFileSync(path.join(skillDir, 'requirements.txt'), '# none\n')
    fs.writeFileSync(path.join(skillDir, 'package.json'), '{}\n')
    expect(detectSkillManifests(skillDir).map((manifest) => manifest.file)).toEqual([
      'requirements.txt',
      'package.json',
    ])
    expect(skillRuntimeView({ name: 'demo', dir: skillDir })).toMatchObject({
      status: 'none',
      manifests: ['requirements.txt', 'package.json'],
      legacy: false,
    })
  })

  it('reports ready and stale from runtime metadata', () => {
    fs.writeFileSync(path.join(skillDir, 'requirements.txt'), '# none\n')
    const dir = skillRuntimeDir({ name: 'demo', dir: skillDir })
    fs.mkdirSync(dir, { recursive: true })
    const mtime = fs.statSync(path.join(skillDir, 'requirements.txt')).mtimeMs
    fs.writeFileSync(
      path.join(dir, 'runtime.json'),
      JSON.stringify({ installedAt: Date.now(), manifests: { 'requirements.txt': mtime + 1000 } }),
    )
    expect(skillRuntimeView({ name: 'demo', dir: skillDir }).status).toBe('ready')

    fs.writeFileSync(
      path.join(dir, 'runtime.json'),
      JSON.stringify({ installedAt: Date.now(), manifests: { 'requirements.txt': mtime - 1000 } }),
    )
    expect(skillRuntimeView({ name: 'demo', dir: skillDir }).status).toBe('stale')
  })

  it('cleans legacy dependency folders but keeps SKILL.md', () => {
    fs.mkdirSync(path.join(skillDir, 'runtime', 'venv'), { recursive: true })
    expect(skillRuntimeView({ name: 'demo', dir: skillDir }).legacy).toBe(true)

    const removed = clearLegacySkillRuntime({ name: 'demo', dir: skillDir })

    expect(removed).toEqual(['runtime'])
    expect(fs.existsSync(path.join(skillDir, 'SKILL.md'))).toBe(true)
    expect(fs.existsSync(path.join(skillDir, 'runtime'))).toBe(false)
  })

  it('attaches the isolated runtime hint to registry entries', () => {
    fs.writeFileSync(path.join(skillDir, 'requirements.txt'), '# none\n')
    const entries: Array<{ name: string; dir: string; runtimeHint?: string }> = [{ name: 'demo', dir: skillDir }]
    applySkillRuntimeHints({ listAll: () => entries })
    expect(entries[0]).toMatchObject({ runtimeHint: expect.stringContaining('skill-runtime') })
    expect(entries[0]?.runtimeHint).toContain('never in the project workspace')
  })
})
