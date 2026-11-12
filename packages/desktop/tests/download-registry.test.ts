import { describe, expect, it } from 'vitest'

import { DownloadControllerRegistry } from '../src/main/download-registry.js'

describe('DownloadControllerRegistry', () => {
  it('keeps downloads from different windows independent', () => {
    const registry = new DownloadControllerRegistry()
    const first = registry.start(1)
    const second = registry.start(2)
    expect(first.signal.aborted).toBe(false)
    expect(second.signal.aborted).toBe(false)
    expect(registry.activeCount).toBe(2)
  })

  it('replaces only the same window download', () => {
    const registry = new DownloadControllerRegistry()
    const first = registry.start(1)
    const other = registry.start(2)
    const replacement = registry.start(1)
    expect(first.signal.aborted).toBe(true)
    expect(other.signal.aborted).toBe(false)
    expect(replacement.signal.aborted).toBe(false)
    expect(registry.activeCount).toBe(2)
  })

  it('cancels only the requested window', () => {
    const registry = new DownloadControllerRegistry()
    const first = registry.start(1)
    const second = registry.start(2)
    expect(registry.cancel(1)).toBe(true)
    expect(first.signal.aborted).toBe(true)
    expect(second.signal.aborted).toBe(false)
    expect(registry.cancel(1)).toBe(false)
  })

  it('ignores a stale finish for a replaced controller', () => {
    const registry = new DownloadControllerRegistry()
    const stale = registry.start(1)
    registry.start(1)
    registry.finish(1, stale)
    expect(registry.isActive(1)).toBe(true)
  })

  it('finishes the active controller', () => {
    const registry = new DownloadControllerRegistry()
    const controller = registry.start(7)
    registry.finish(7, controller)
    expect(registry.isActive(7)).toBe(false)
    expect(registry.activeCount).toBe(0)
  })
})
