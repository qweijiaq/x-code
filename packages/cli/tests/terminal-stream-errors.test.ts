import { EventEmitter } from 'node:events'

import { installTerminalStreamErrorGuards } from '../src/terminal-stream-errors.js'

describe('terminal stream error guards', () => {
  it('isolates EPIPE during terminal disconnect cleanup', () => {
    const stdout = new EventEmitter()
    const stderr = new EventEmitter()
    const report = vi.fn()
    const dispose = installTerminalStreamErrorGuards([stdout, stderr], report)
    const brokenPipe = Object.assign(new Error('broken pipe'), { code: 'EPIPE' })

    expect(() => stdout.emit('error', brokenPipe)).not.toThrow()
    expect(() => stderr.emit('error', brokenPipe)).not.toThrow()
    expect(report).not.toHaveBeenCalled()
    dispose()
    expect(stdout.listenerCount('error')).toBe(0)
    expect(stderr.listenerCount('error')).toBe(0)
  })

  it('reports unrelated stream failures without breaking the listener chain', () => {
    const stream = new EventEmitter()
    const report = vi.fn()
    const businessHandler = vi.fn()
    installTerminalStreamErrorGuards([stream], report)
    // 业务侧后注册的监听器必须仍能收到错误：guard 在索引/启动模块最顶层注册，
    // 一旦它在 emit 循环里抛错，后续所有 error 监听器都会被跳过。
    stream.on('error', businessHandler)

    expect(() => stream.emit('error', Object.assign(new Error('bad descriptor'), { code: 'EBADF' }))).not.toThrow()
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ code: 'EBADF' }))
    expect(businessHandler).toHaveBeenCalledWith(expect.objectContaining({ code: 'EBADF' }))
  })

  it('keeps quiet when the reporter itself throws', () => {
    const stream = new EventEmitter()
    installTerminalStreamErrorGuards([stream], () => {
      throw new Error('reporter exploded')
    })

    expect(() => stream.emit('error', Object.assign(new Error('bad descriptor'), { code: 'EBADF' }))).not.toThrow()
  })
})
