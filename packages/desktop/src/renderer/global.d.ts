import type { XcodeBridge } from '../shared/protocol.js'

declare global {
  interface Window {
    xcode: XcodeBridge
  }
}

export {}
