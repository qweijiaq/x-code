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

/** 凭据位置。`xcodeRoot` 必须与 {@link userXcodeDir} 一致
 *  （`${X_CODE_HOME ?? ~/.x-code}`）：硬编码 `home/.x-code` 会让设置了
 *  `X_CODE_HOME` 的部署把**真正的**凭据目录（`desktop-secrets.json`、
 *  `plugins/user-config.json`、`.env`、`config.json`、`settings.json`、
 *  `auth/`、`mcp.json`）留在沙箱内命令可读的位置上，与“除凭据位置外处处
 *  允许读取”的设计意图相反。整根拒绝，再单独放行不含凭据的 skill-runtime。 */
interface SensitivePath {
  path: string
  /** 目录用 `subpath`（整棵子树），单文件用 `literal`（只匹配该路径本身）。 */
  kind: 'dir' | 'file'
}

function sensitivePaths(xcodeRoot: string): SensitivePath[] {
  const home = os.homedir()
  const entries: SensitivePath[] = [
    { path: path.join(home, '.ssh'), kind: 'dir' },
    { path: path.join(home, '.aws'), kind: 'dir' },
    { path: path.join(home, '.gnupg'), kind: 'dir' },
    { path: path.join(home, '.kube'), kind: 'dir' },
    { path: path.join(home, '.config', 'gcloud'), kind: 'dir' },
    // 单文件：`subpath` 会按路径前缀连带否定 `~/.npmrc.bak`、`~/.netrc.d/…`
    // 之类无关位置，匹配范围与预期不符。
    { path: path.join(home, '.netrc'), kind: 'file' },
    { path: path.join(home, '.npmrc'), kind: 'file' },
    { path: path.join(home, '.pypirc'), kind: 'file' },
    { path: path.join(home, 'Library', 'Keychains'), kind: 'dir' },
    { path: xcodeRoot, kind: 'dir' },
  ]
  return entries
}

/** macOS 把 `/var` 软链到 `/private/var`，而 sandbox-exec 按真实路径匹配，因此
 *  临时目录的两种写法都要放行。 */
const USER_TEMP_DIR_RE = /^(?:\/private)?\/var\/folders\/[^/]+\/[^/]+$/

/** 临时目录的写入白名单。 */
function tempWriteScopes(temp: string): string[] {
  const scopes = new Set<string>([temp])
  const realTemp = temp.startsWith('/private/') ? temp : `/private${temp}`
  scopes.add(realTemp)
  // 收窄到当前用户那一层（`/var/folders/<xx>/<hash>`）：放行整棵
  // `/private/var/folders` 会让沙箱内的命令能改写其他用户的临时文件。
  for (const base of [temp, realTemp]) {
    const userDir = path.dirname(base)
    if (USER_TEMP_DIR_RE.test(userDir)) scopes.add(userDir)
  }
  return [...scopes]
}

/** 构建 SBPL 配置。后面的规则覆盖前面的，因此敏感路径的拒绝块放在工作区
 *  写入允许之后。 */
export function sandboxProfileText(config: ShellSandboxConfig = current): string {
  const workspace = path.resolve(config.workspace || process.cwd())
  // 全盘 / 家目录可写会让"写入只允许在工作区内"这条核心保证（只剩凭据清单
  // 被拒）形同虚设，且不会有任何报错提示。宁可直接拒绝，也不要给出虚假保证。
  if (workspace === path.parse(workspace).root || workspace === os.homedir()) {
    throw new Error(`shell sandbox: refusing to treat ${workspace} as the writable workspace`)
  }
  const temp = os.tmpdir()
  // 与 userXcodeDir() 一致：凭据实际落在 ${X_CODE_HOME ?? ~/.x-code} 下。
  const xcodeRoot = process.env.X_CODE_HOME?.trim() || path.join(os.homedir(), '.x-code')
  const skillRuntime = path.join(xcodeRoot, 'skill-runtime')
  const lines = ['(version 1)', '(allow default)']
  if (!config.allowNetwork) lines.push('(deny network*)')
  lines.push(
    '(deny file-write*)',
    '(allow file-write*',
    `  (subpath ${sbplString(workspace)})`,
    ...tempWriteScopes(temp).map((scope) => `  (subpath ${sbplString(scope)})`),
    // 技能脚本可能把模型/依赖下载到其隔离运行时；该目录由应用管理且不含
    // 凭据。
    `  (subpath ${sbplString(skillRuntime)})`,
    '  (subpath "/private/tmp")',
    '  (literal "/dev/null")',
    '  (literal "/dev/zero")',
    '  (literal "/dev/tty")',
    '  (literal "/dev/stdout")',
    '  (literal "/dev/stderr")',
    '  (literal "/dev/dtracehelper"))',
    '(deny file-read* file-write*',
    ...sensitivePaths(xcodeRoot).map(
      (entry) => `  (${entry.kind === 'dir' ? 'subpath' : 'literal'} ${sbplString(entry.path)})`,
    ),
    ')',
    // 凭据整根拒绝之后，重新放行 skill-runtime（沙箱写入白名单在上方，会被
    // 上面的 deny 覆盖）。技能脚本需要在这里读写依赖，而它不含任何凭据。
    '(allow file-read* file-write*',
    `  (subpath ${sbplString(skillRuntime)}))`,
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

/** `ACCESS[_-]?KEY` 覆盖 `AWS_ACCESS_KEY_ID` / `ALIBABA_CLOUD_ACCESS_KEY_ID` /
 *  `*_ACCESS_KEY` 这类 access key id（它们不含 SECRET，否则会被下面的模式漏掉）。
 *  TOKEN 分支难以精确，因此用白名单保留名字里带 token 但无害的变量。 */
const SECRET_ENV_PATTERN = /(API[_-]?KEY|ACCESS[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE[_-]?KEY)/i
/** 命中上面模式、但实际只是配置开关的变量，保留以免破坏常见工具链。 */
const SECRET_ENV_ALLOWLIST = new Set(['TOKENIZERS_PARALLELISM'])

/** Electron utilityProcess 用来让内部 worker 以 Node 运行，但它会继承给所有
 *  子进程。agent shell 如果带着它启动 Electron，Electron 会退化成纯 Node：
 *  `app` 是 undefined，窗口不会出现。用户命令绝不能拿到这些运行时开关。 */
const ELECTRON_RUNTIME_ENV_KEYS = ['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE'] as const

/** 从子进程环境中移除形似凭据的变量和 Electron 运行时开关。PATH、HOME、
 *  locale 和显示相关变量会被保留。 */
export function sanitizeShellEnv(env: NodeJS.ProcessEnv, config: ShellSandboxConfig = current): NodeJS.ProcessEnv {
  const sandboxed = process.platform === 'darwin' && config.enabled
  const carriesElectronFlags = ELECTRON_RUNTIME_ENV_KEYS.some((key) => env[key] !== undefined)
  if (!sandboxed && !carriesElectronFlags) return env
  const sanitized: NodeJS.ProcessEnv = { ...env }
  for (const key of ELECTRON_RUNTIME_ENV_KEYS) delete sanitized[key]
  if (!sandboxed) return sanitized
  for (const key of Object.keys(sanitized)) {
    if (SECRET_ENV_ALLOWLIST.has(key)) continue
    if (SECRET_ENV_PATTERN.test(key)) delete sanitized[key]
  }
  return sanitized
}
