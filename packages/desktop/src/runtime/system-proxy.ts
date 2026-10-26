import { execFileSync } from 'node:child_process'

export interface SystemProxy {
  proxy: string
}

/** 解析 macOS `scutil --proxy` 输出。为测试导出；未启用 HTTP(S)
 *  代理时返回 null。 */
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

/** Git（以及其他 CLI 子进程）不会继承 Chromium 的系统代理设置。
 *  在 macOS 上读取一次系统代理并返回给子进程的环境变量，
 *  除非用户已显式配置了代理。 */
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
