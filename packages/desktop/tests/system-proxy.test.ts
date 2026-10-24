import { parseMacProxy, systemProxyEnv } from '../src/runtime/system-proxy.js'

const proxyOutput = `<dictionary> {
  ExceptionsList : <array> {
    0 : 127.0.0.1
  }
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7891
  HTTPSProxy : 127.0.0.1
  ProxyAutoConfigEnable : 0
}`

describe('system proxy detection', () => {
  it('reads the enabled HTTPS proxy and falls back to HTTP', () => {
    expect(parseMacProxy(proxyOutput)).toEqual({ proxy: 'http://127.0.0.1:7891' })
    expect(parseMacProxy(proxyOutput.replace('HTTPSEnable : 1', 'HTTPSEnable : 0'))).toEqual({
      proxy: 'http://127.0.0.1:7890',
    })
    expect(
      parseMacProxy(
        proxyOutput.replace('HTTPEnable : 1', 'HTTPEnable : 0').replace('HTTPSEnable : 1', 'HTTPSEnable : 0'),
      ),
    ).toBeNull()
  })

  it('does not override an explicitly configured proxy', () => {
    expect(systemProxyEnv({ HTTPS_PROXY: 'http://example:8080' }, () => proxyOutput)).toEqual({})
    expect(systemProxyEnv({ https_proxy: 'http://example:8080' }, () => proxyOutput)).toEqual({})
  })

  it('returns env vars for git when the system proxy is enabled', () => {
    const env = systemProxyEnv({}, (() => proxyOutput) as never)
    if (process.platform === 'darwin') {
      expect(env).toEqual({
        HTTPS_PROXY: 'http://127.0.0.1:7891',
        HTTP_PROXY: 'http://127.0.0.1:7891',
      })
    } else {
      expect(env).toEqual({})
    }
  })
})
