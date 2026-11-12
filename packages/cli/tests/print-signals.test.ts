import { afterEach, describe, expect, it, vi } from 'vitest'

import { abortPrintMode, setPrintAbortHandler } from '../src/print-signals.js'

afterEach(() => {
  setPrintAbortHandler(null)
})

describe('print signal coordination', () => {
  it('hands the first SIGINT to the active print run', () => {
    const abort = vi.fn()
    setPrintAbortHandler(abort)

    expect(abortPrintMode()).toBe(true)
    expect(abort).toHaveBeenCalledTimes(1)
    expect(abortPrintMode()).toBe(true)
    expect(abort).toHaveBeenCalledTimes(2)
  })

  it('reports false when no print run is active', () => {
    expect(abortPrintMode()).toBe(false)
  })

  it('clears the handler after print mode finishes', () => {
    setPrintAbortHandler(() => undefined)
    setPrintAbortHandler(null)
    expect(abortPrintMode()).toBe(false)
  })
})
