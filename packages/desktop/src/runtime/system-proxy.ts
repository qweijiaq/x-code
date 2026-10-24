import { execFileSync } from 'node:child_process'

export interface SystemProxy {
  proxy: string
}

/** Parse the macOS `scutil --proxy` output. Exported for tests; returns null
 *  when no HTTP(S) proxy is enabled. */
export function parseMacProxy(output: string): SystemProxy | null {
  const enabled = (key: string): boolean => {
    const match = output.match(new RegExp(`^\\s*${key}\\s*:\\s*1\\s*$`, 'm'))
    return match !== null
  }
  const value = (key: string): string | undefined =>
    output.match(new RegExp(`^\\s*${key}\\s*:\\s*(\\S+)\\s*$`, 'm'))?.[1]
  if (enabled('HTTPSEnable')) {
    const host = value('HTTPSProxy')
    const port = value('HTTPSPort')
    if (host && port) return { proxy: `http://${host}:${port}` }
  }
  if (enabled('HTTPEnable')) {
    const host = value('HTTPProxy')
    const port = value('HTTPPort')
    if (host && port) return { proxy: `http://${host}:${port}` }
  }
  return null
}

/** Git (and other CLI children) do not inherit Chromium's system-proxy
 *  settings. On macOS, read the system proxy once and return env vars for
 *  child processes, unless the user already configured one explicitly. */
export function systemProxyEnv(
  env: NodeJS.ProcessEnv = process.env,
  run: typeof execFileSync = execFileSync,
): Record<string, string> {
  if (env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy) return {}
  if (process.platform !== 'darwin') return {}
  let output: string
  try {
    output = run('scutil', ['--proxy'], { encoding: 'utf-8', timeout: 2_000 }).toString()
  } catch {
    return {}
  }
  const proxy = parseMacProxy(output)
  return proxy ? { HTTPS_PROXY: proxy.proxy, HTTP_PROXY: proxy.proxy } : {}
}
