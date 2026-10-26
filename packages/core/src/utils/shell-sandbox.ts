// @x-code-cli/core — macOS 工作区写入 shell 沙箱
//
// 启用后（桌面设置，仅 macOS），agent 的 shell 命令会在生成的 SBPL 配置下
// 通过 `/usr/bin/sandbox-exec` 运行：
//   - 除了一组凭据位置之外，读取处处允许，
//   - 写入只允许在工作区和临时目录内，
//   - 除非用户显式允许，否则拒绝网络访问，
//   - API 密钥 / 令牌 / 机密会从子进程环境中剔除。
//
// 桌面应用中的交互式终端是用户自己的 shell，不受沙箱约束。开启
// `includeExtensions` 后，hook 命令和 stdio MCP 服务器也会被包裹：hook 使用
// 配置的网络策略，MCP 服务器始终保留网络访问（其 API 在沙箱之外），但写入
// 仍被限制在工作区/临时目录。
import os from 'node:os'
import path from 'node:path'

export interface ShellSandboxConfig {
  enabled: boolean
  workspace: string
  allowNetwork: boolean
  /** 可选加入：同时沙箱化 hook 命令和 stdio MCP 服务器。 */
  includeExtensions: boolean
}

const DEFAULT_CONFIG: ShellSandboxConfig = {
  enabled: false,
  workspace: process.cwd(),
  allowNetwork: false,
  includeExtensions: false,
}

let current: ShellSandboxConfig = { ...DEFAULT_CONFIG }

export function setShellSandbox(config: Partial<ShellSandboxConfig>): void {
  current = { ...current, ...config }
}

export function getShellSandbox(): ShellSandboxConfig {
  return current
}

/** 当命令必须用 sandbox-exec 包裹时为 true。 */
export function isShellSandboxActive(): boolean {
  return process.platform === 'darwin' && current.enabled
}

/** 当 hook / stdio MCP 服务器也必须被包裹时为 true。 */
export function isExtensionSandboxActive(): boolean {
  return isShellSandboxActive() && current.includeExtensions
}

function sbplString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function sensitivePaths(): string[] {
  const home = os.homedir()
  return [
    path.join(home, '.ssh'),
    path.join(home, '.aws'),
    path.join(home, '.gnupg'),
    path.join(home, '.kube'),
    path.join(home, '.config', 'gcloud'),
    path.join(home, '.netrc'),
    path.join(home, '.npmrc'),
    path.join(home, '.pypirc'),
    path.join(home, 'Library', 'Keychains'),
    path.join(home, '.x-code', 'desktop-secrets.json'),
    path.join(home, '.x-code', 'plugins', 'user-config.json'),
  ]
}

/** 构建 SBPL 配置。后面的规则覆盖前面的，因此敏感路径的拒绝块放在工作区
 *  写入允许之后。 */
export function sandboxProfileText(config: ShellSandboxConfig = current): string {
  const workspace = path.resolve(config.workspace)
  const temp = os.tmpdir()
  const xcodeRoot = process.env.X_CODE_HOME?.trim() || path.join(os.homedir(), '.x-code')
  const skillRuntime = path.join(xcodeRoot, 'skill-runtime')
  const lines = ['(version 1)', '(allow default)']
  if (!config.allowNetwork) lines.push('(deny network*)')
  lines.push(
    '(deny file-write*)',
    '(allow file-write*',
    `  (subpath ${sbplString(workspace)})`,
    `  (subpath ${sbplString(temp)})`,
    // 技能脚本可能把模型/依赖下载到其隔离运行时；该目录由应用管理且不含
    // 凭据。
    `  (subpath ${sbplString(skillRuntime)})`,
    '  (subpath "/private/tmp")',
    '  (subpath "/private/var/folders")',
    '  (literal "/dev/null")',
    '  (literal "/dev/zero")',
    '  (literal "/dev/tty")',
    '  (literal "/dev/stdout")',
    '  (literal "/dev/stderr")',
    '  (literal "/dev/dtracehelper"))',
    '(deny file-read* file-write*',
    ...sensitivePaths().map((entry) => `  (subpath ${sbplString(entry)})`),
    ')',
  )
  return lines.join('\n')
}

/** 包裹可执行文件及其参数，使其在启用时于 sandbox-exec 内运行。 */
export function wrapShellSpawn(
  executable: string,
  args: string[],
  config: ShellSandboxConfig = current,
): { executable: string; args: string[] } {
  if (process.platform !== 'darwin' || !config.enabled) return { executable, args }
  return { executable: '/usr/bin/sandbox-exec', args: ['-p', sandboxProfileText(config), executable, ...args] }
}

const SECRET_ENV_PATTERN = /(API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE[_-]?KEY)/i

/** 从子进程环境中移除形似凭据的变量。PATH、HOME、locale 和显示相关变量会被
 *  保留。 */
export function sanitizeShellEnv(env: NodeJS.ProcessEnv, config: ShellSandboxConfig = current): NodeJS.ProcessEnv {
  if (process.platform !== 'darwin' || !config.enabled) return env
  const sanitized: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    if (SECRET_ENV_PATTERN.test(key)) continue
    sanitized[key] = value
  }
  return sanitized
}
