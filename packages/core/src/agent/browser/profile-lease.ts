// @x-code-cli/core — 跨进程持有 Playwright 持久浏览器 profile。
// 固定的 MCP server 会为每个浏览器 channel + 工作区派生一个 profile，但只有在尝试启动
// Chrome 之后才会发现冲突。在该 profile 目录里占一个小租约，可以让第二个 xc 进程尽早
// 失败并给出有用提示，同时保留登录状态。
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { BrowserConfig } from '../../config/index.js'
import { type FileLockLease, acquireFileLock } from '../../utils/file-lock.js'

const PROFILE_LOCK_FILE = '.x-code-profile.lock'

function browserProfileToken(browser: BrowserConfig['browser']): string {
  // @playwright/mcp 在构造持久 profile 目录名之前，会先把 `chromium` 选项映射成
  // chrome-for-testing channel。
  return browser === 'chromium' ? 'chrome-for-testing' : (browser ?? 'chrome')
}

function playwrightProfilesRoot(): string {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright-mcp')
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'ms-playwright-mcp')
  }
  // MCP SDK 的安全 stdio 环境会传 HOME，但不传 XDG_CACHE_HOME，
  // 因此被拉起的 pinned server 在 Linux 上会落到这个确切的回退路径。
  return path.join(os.homedir(), '.cache', 'ms-playwright-mcp')
}

/** 复刻 @playwright/mcp@0.0.79 默认的持久 profile 派生逻辑。
 *  把它放在 PLAYWRIGHT_MCP_PACKAGE 旁边，是为了将来升级版本时能一并复核路径算法和租约。 */
export function managedBrowserProfileDirectory(
  config: BrowserConfig,
  cwd = process.cwd(),
  profilesRoot = playwrightProfilesRoot(),
): string {
  const workspaceHash = createHash('sha256').update(cwd).digest('hex').slice(0, 7)
  return path.join(profilesRoot, `mcp-${browserProfileToken(config.browser)}-${workspaceHash}`)
}

/** 在启动默认持久浏览器之前先取得所有权。自定义 command 自己管理生命周期/profile，
 *  因而有意跳过这里。 */
export async function acquireBrowserProfileLease(
  config: BrowserConfig,
  options: { cwd?: string; profilesRoot?: string } = {},
): Promise<FileLockLease> {
  const profileDirectory = managedBrowserProfileDirectory(config, options.cwd, options.profilesRoot)
  await fs.mkdir(profileDirectory, { recursive: true })
  const lease = await acquireFileLock(path.join(profileDirectory, PROFILE_LOCK_FILE), {
    staleMs: 30_000,
  })
  if (!lease) {
    throw new Error(
      'The managed browser profile for this workspace is already in use by another xc process. ' +
        'Close the other xc session and retry; X-Code will not replace the persistent signed-in profile with a temporary one.',
    )
  }
  return lease
}
