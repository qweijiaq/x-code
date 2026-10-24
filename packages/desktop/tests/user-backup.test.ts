import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { exportUserBackup, importUserBackup } from '../src/runtime/user-backup.js'

describe('user backup', () => {
  let root = ''
  let source = ''
  let destination = ''
  let target = ''

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'xcode-backup-'))
    source = path.join(root, 'source')
    destination = path.join(root, 'destination')
    target = path.join(root, 'target')
    fs.mkdirSync(path.join(source, 'sessions'), { recursive: true })
    fs.mkdirSync(path.join(source, 'skills', 'demo'), { recursive: true })
    fs.mkdirSync(path.join(source, 'commands'), { recursive: true })
    fs.mkdirSync(path.join(source, 'memory'), { recursive: true })
    fs.mkdirSync(path.join(source, 'agents'), { recursive: true })
    fs.mkdirSync(destination, { recursive: true })
    fs.writeFileSync(path.join(source, 'sessions', 'a.jsonl'), '{"role":"user"}\n')
    fs.writeFileSync(path.join(source, 'sessions', 'ignore.txt'), 'not a session')
    fs.writeFileSync(path.join(source, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\n---\n')
    fs.writeFileSync(path.join(source, 'commands', 'foo.md'), '# Foo\n')
    fs.writeFileSync(path.join(source, 'memory', 'topic.md'), '# Topic\n')
    fs.writeFileSync(path.join(source, 'agents', 'helper.md'), '# Helper\n')
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('exports known folders and a manifest without secrets', async () => {
    fs.writeFileSync(path.join(source, 'desktop-secrets.json'), '{"secret":true}')
    const result = await exportUserBackup(source, destination, '0.6.1')
    expect(result.manifest.counts).toEqual({ sessions: 1, skills: 1, commands: 1, memory: 1, agents: 1 })
    expect(fs.existsSync(path.join(result.path, 'sessions', 'a.jsonl'))).toBe(true)
    expect(fs.existsSync(path.join(result.path, 'sessions', 'ignore.txt'))).toBe(false)
    expect(fs.existsSync(path.join(result.path, 'skills', 'demo', 'SKILL.md'))).toBe(true)
    expect(fs.existsSync(path.join(result.path, 'desktop-secrets.json'))).toBe(false)
    const manifest = JSON.parse(fs.readFileSync(path.join(result.path, 'manifest.json'), 'utf-8'))
    expect(manifest).toMatchObject({ format: 'x-code-backup', version: 1, appVersion: '0.6.1' })
    expect(manifest.excluded).toContain('desktop-secrets.json')
  })

  it('restores missing files without overwriting existing ones', async () => {
    const exported = await exportUserBackup(source, destination)
    const first = await importUserBackup(exported.path, target)
    expect(first.imported).toEqual({ sessions: 1, skills: 1, commands: 1, memory: 1, agents: 1 })
    expect(first.skipped).toEqual({ sessions: 0, skills: 0, commands: 0, memory: 0, agents: 0 })
    expect(fs.readFileSync(path.join(target, 'sessions', 'a.jsonl'), 'utf-8')).toBe('{"role":"user"}\n')

    fs.writeFileSync(path.join(target, 'sessions', 'a.jsonl'), '{"role":"local"}\n')
    const second = await importUserBackup(exported.path, target)
    expect(second.imported).toEqual({ sessions: 0, skills: 0, commands: 0, memory: 0, agents: 0 })
    expect(second.skipped).toEqual({ sessions: 1, skills: 1, commands: 1, memory: 1, agents: 1 })
    expect(fs.readFileSync(path.join(target, 'sessions', 'a.jsonl'), 'utf-8')).toBe('{"role":"local"}\n')
  })

  it('rejects folders that are not a backup', async () => {
    await expect(importUserBackup(destination, target)).rejects.toThrow('manifest.json')
    fs.writeFileSync(path.join(destination, 'manifest.json'), '{"format":"other","version":1}')
    await expect(importUserBackup(destination, target)).rejects.toThrow('不支持')
  })
})
