import { describe, expect, it } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { readToolAudit, redactAuditInput, writeToolAudit } from '../src/agent/audit.js'

describe('tool audit', () => {
  it('redacts secret-looking fields and truncates long values', () => {
    const redacted = redactAuditInput({
      filePath: '/tmp/example.ts',
      apiKey: 'sk-live-secret',
      nested: { authorization: 'Bearer abc', note: 'x'.repeat(500) },
    })
    expect(redacted.filePath).toBe('/tmp/example.ts')
    expect(redacted.apiKey).toBe('••••')
    expect((redacted.nested as Record<string, unknown>).authorization).toBe('••••')
    expect(String((redacted.nested as Record<string, unknown>).note).length).toBeLessThan(500)
  })

  it('writes JSONL and reads the most recent entries back', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xcode-audit-'))
    try {
      await writeToolAudit(
        {
          ts: '2026-01-01T00:00:00.000Z',
          sessionId: 's1',
          toolCallId: 't1',
          tool: 'writeFile',
          principal: 'user',
          permissionMode: 'default',
          trustMode: false,
          tainted: false,
          decision: 'allow',
          input: { filePath: '/tmp/a.ts' },
        },
        { dir },
      )
      await writeToolAudit(
        {
          ts: '2026-01-01T00:00:01.000Z',
          sessionId: 's1',
          toolCallId: 't2',
          tool: 'shell',
          principal: 'peer',
          permissionMode: 'default',
          trustMode: false,
          tainted: true,
          decision: 'deny',
          reason: 'peer-denied',
          input: { command: 'npm install' },
        },
        { dir },
      )
      const entries = await readToolAudit(10, dir)
      expect(entries).toHaveLength(2)
      expect(entries[1]).toMatchObject({ tool: 'shell', decision: 'deny', principal: 'peer' })
      const raw = await fs.readFile(path.join(dir, 'audit.jsonl'), 'utf8')
      expect(raw.trim().split('\n')).toHaveLength(2)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
