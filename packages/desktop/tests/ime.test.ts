import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ime.ts 在模块加载阶段注册 window 监听器，且组词状态是模块级单例。
// 因此每个用例都用一个新的假 window 重新加载模块，避免状态串场。
type Handler = (event: { target?: unknown }) => void

class FakeWindow {
  private handlers = new Map<string, Handler[]>()

  addEventListener(type: string, handler: Handler): void {
    const list = this.handlers.get(type) ?? []
    list.push(handler)
    this.handlers.set(type, list)
  }

  removeEventListener(type: string, handler: Handler): void {
    const list = this.handlers.get(type) ?? []
    this.handlers.set(
      type,
      list.filter((item) => item !== handler),
    )
  }

  dispatch(type: string, event: { target?: unknown } = {}): void {
    for (const handler of this.handlers.get(type) ?? []) handler(event)
  }
}

/** 模拟一个可以 contains 的输入元素；`inner` 代表落在它内部的节点。 */
function makeElement(inner?: object): { contains: (node: unknown) => boolean } {
  return { contains: (node: unknown) => inner !== undefined && node === inner }
}

let fakeWindow: FakeWindow

async function loadIme(): Promise<typeof import('../src/renderer/ime.js')> {
  fakeWindow = new FakeWindow()
  vi.stubGlobal('window', fakeWindow)
  vi.resetModules()
  return import('../src/renderer/ime.js')
}

beforeEach(() => {
  vi.unstubAllGlobals()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('isImeEvent', () => {
  it('resets a stuck composing flag when the element is blurred without compositionend', async () => {
    const { isImeEvent } = await loadIme()
    fakeWindow.dispatch('compositionstart', { target: makeElement() })
    expect(isImeEvent({})).toBe(true)

    // 输入框在组词中被卸载/失焦：compositionend 不会派发。
    fakeWindow.dispatch('focusout', { target: undefined })
    expect(isImeEvent({})).toBe(false)
  })

  it('resets a stuck composing flag on window blur', async () => {
    const { isImeEvent } = await loadIme()
    fakeWindow.dispatch('compositionstart', { target: makeElement() })
    fakeWindow.dispatch('blur', {})
    expect(isImeEvent({})).toBe(false)
  })

  it('resets a stuck composing flag when the pointer lands outside the composing element', async () => {
    const { isImeEvent } = await loadIme()
    const inner = {}
    const input = makeElement(inner)
    fakeWindow.dispatch('compositionstart', { target: input })
    // 点在组词元素内部不算结束。
    fakeWindow.dispatch('pointerdown', { target: inner })
    expect(isImeEvent({})).toBe(true)
    // 点在别处（元素已经被移除时既没有 compositionend 也没有 focusout）。
    fakeWindow.dispatch('pointerdown', { target: {} })
    expect(isImeEvent({})).toBe(false)
  })
})

describe('isImeEnter', () => {
  it('consumes the grace window once so the next real Enter still submits', async () => {
    const { isImeEnter } = await loadIme()
    const input = makeElement()
    fakeWindow.dispatch('compositionstart', { target: input })
    fakeWindow.dispatch('compositionend', { target: input })

    // 确认候选词的这次 Enter。
    expect(isImeEnter({ target: input })).toBe(true)
    // 紧接着的真实提交（快速输入时两次按键可能 < 120ms）。
    expect(isImeEnter({ target: input })).toBe(false)
  })

  it('does not swallow Enter pressed on another element after composing', async () => {
    const { isImeEnter } = await loadIme()
    const input = makeElement()
    fakeWindow.dispatch('compositionstart', { target: input })
    fakeWindow.dispatch('compositionend', { target: input })

    expect(isImeEnter({ target: {} })).toBe(false)
  })

  it('expires the grace window', async () => {
    const { isImeEnter } = await loadIme()
    const input = makeElement()
    fakeWindow.dispatch('compositionstart', { target: input })
    fakeWindow.dispatch('compositionend', { target: input })

    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(isImeEnter({ target: input })).toBe(false)
  })

  it('still honours the event-level composition flags', async () => {
    const { isImeEnter } = await loadIme()
    expect(isImeEnter({ isComposing: true })).toBe(true)
    expect(isImeEnter({ nativeEvent: { isComposing: true } })).toBe(true)
    expect(isImeEnter({ keyCode: 229 })).toBe(true)
  })
})
