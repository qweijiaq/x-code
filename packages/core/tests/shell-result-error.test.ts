import { describe, expect, it } from 'vitest'

import { shellTransportError } from '../src/tools/shell-session/manager.js'

describe('shellTransportError', () => {
  it('does not treat a non-zero exit as a tool failure', () => {
    expect(shellTransportError({ spawnOutcome: 'ready', exitCode: 7 })).toBe(false)
    expect(shellTransportError({ spawnOutcome: 'ready', exitCode: 1 })).toBe(false)
  })

  it('flags spawn, timeout, signal and provider failures', () => {
    expect(shellTransportError({ spawnOutcome: 'failed' })).toBe(true)
    expect(shellTransportError({ timedOut: true })).toBe(true)
    expect(shellTransportError({ signal: 'SIGTERM' })).toBe(true)
    expect(shellTransportError({ failure: { message: 'malformed frame' } })).toBe(true)
  })
})
