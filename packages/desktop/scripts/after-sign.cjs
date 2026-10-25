const { execFileSync, spawnSync } = require('node:child_process')
const path = require('node:path')

/**
 * electron-builder afterSign hook.
 *
 * A Developer ID build is left untouched. Unsigned community builds get a
 * proper ad-hoc signature over the whole bundle (Electron only ships a
 * linker signature on the main executable), which avoids several "app is
 * damaged" cases on Apple Silicon. Ad-hoc signing is free but does not make
 * Gatekeeper or notarization accept the app; users still approve the first
 * launch.
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
