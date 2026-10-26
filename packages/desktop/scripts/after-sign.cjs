/* eslint-disable @typescript-eslint/no-require-imports -- electron-builder loads this hook as CommonJS */
const { execFileSync, spawnSync } = require('node:child_process')
const path = require('node:path')

/**
 * electron-builder 的 afterSign 钩子。
 *
 * Developer ID 构建保持不动。未签名的社区构建会在整个 bundle 上打一个
 * 正规的 ad-hoc 签名（Electron 只在主可执行文件上带一个链接器签名），
 * 从而避免 Apple Silicon 上几种“应用已损坏”的情况。ad-hoc 签名免费，
 * 但并不能让 Gatekeeper 或公证接受该应用；用户仍需在首次启动时放行。
 */
module.exports = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const info = spawnSync('codesign', ['-dv', '--verbose=4', appPath], { encoding: 'utf-8' })
  const text = `${info.stdout ?? ''}${info.stderr ?? ''}`
  if (/Authority=Developer ID Application/.test(text) && /TeamIdentifier=(?!not set)/.test(text)) {
    console.log('[after-sign] Developer ID signature detected; leaving it unchanged')
    return
  }
  console.log('[after-sign] applying ad-hoc signature to the app bundle')
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', appPath], {
    stdio: 'inherit',
  })
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' })
}
