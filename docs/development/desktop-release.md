# Desktop release

The desktop app ships as a macOS `.dmg` + `.zip` locally; CI also builds
Windows NSIS and Linux AppImage/deb artifacts. The release script writes
`SHA256SUMS` and `RELEASE.json`, which the app's **Settings → 桌面端更新**
panel can read to check for a newer version.

## Local unsigned build

```bash
pnpm release:desktop --arch arm64
```

Artifacts land in `packages/desktop/release/`:

- `X-Code-<version>-arm64.dmg`
- `X-Code-<version>-arm64.zip` (+ `.blockmap` files)
- `SHA256SUMS`
- `RELEASE.json`

`RELEASE.json` looks like:

```json
{
  "version": "0.6.1",
  "builtAt": "2026-10-24T03:00:00.000Z",
  "commit": "…",
  "platform": "darwin",
  "arch": "arm64",
  "signed": false,
  "notarized": false,
  "artifacts": [{ "file": "X-Code-0.6.1-arm64.dmg", "size": 0, "sha256": "…" }]
}
```

Unsigned builds are blocked by Gatekeeper on other machines. For local
testing, right-click the app → Open, or `xattr -dr com.apple.quarantine`.

## Signing & notarization

Signing is automatic when the standard electron-builder variables are set:

| Variable                      | Purpose                                   |
| ----------------------------- | ----------------------------------------- |
| `CSC_LINK`                    | base64 `.p12` certificate or path         |
| `CSC_KEY_PASSWORD`            | certificate password                      |
| `CSC_NAME`                    | identity name (alternative to `CSC_LINK`) |
| `APPLE_ID`                    | Apple ID for notarization                 |
| `APPLE_APP_SPECIFIC_PASSWORD` | app-specific password                     |
| `APPLE_TEAM_ID`               | Apple developer team id                   |

When all three Apple variables are present, `release-desktop.mjs` passes
`-c.mac.notarize=true`; otherwise the build is intentionally unsigned.

The entitlements file is `packages/desktop/build/entitlements.mac.plist`
(JIT + unsigned executable memory for V8, network client/server, user-selected
files).

## Update feed

Host `RELEASE.json` at an HTTPS URL and paste it into
**Settings → 桌面端更新 → 保存并检查**. The main process compares `version`
with the running app version and shows the result; `url` (if present) gets an
"打开发布页" action.

Automatic download-and-install is not enabled yet: it requires a signed app,
a stable feed, and `electron-updater` wiring. The manual check is deliberately
dependency-free and works with unsigned local builds.

## CI

`.github/workflows/desktop-release.yml` builds on tag pushes and manual
dispatch:

- **macOS arm64** — typecheck, build, UI smoke, then dmg + zip, signing and
  notarization when the secrets are present.
- **Linux x64** — typecheck, build, then AppImage + deb.
- **Windows x64** — build, then an NSIS installer.

All three jobs upload their artifacts. Signing secrets are optional; without
them the artifacts are unsigned. The Windows and Linux jobs have **not been
accepted on those platforms yet** — run the installers on real machines and
record the result before calling them supported. Linux builds need
`libfuse2` at runtime for the AppImage; the deb installs a desktop entry.

## Size

The dmg is currently ~244 MB. Electron itself is ~100 MB compressed; the rest
is the bundled multilingual Whisper model (~74 MB), OCR (Tesseract cores), PDF
rendering (pdfjs), and optional local Whisper audio binaries.

`scripts/fetch-whisper-model.mjs` prepares `packages/desktop/build/whisper/`
before packaging (from the local cache, Hugging Face, or hf-mirror). Set
`X_CODE_SKIP_BUNDLED_WHISPER=1` to build a smaller installer that downloads the
model on first voice use instead. The model's license notice ships alongside
it as `whisper/LICENSE.txt`.
