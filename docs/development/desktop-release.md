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
| `APPLE_API_KEY`               | App Store Connect API key (`.p8`)         |
| `APPLE_API_KEY_ID`            | API key id                                |
| `APPLE_API_ISSUER`            | API key issuer id                         |

Use either the `APPLE_ID` trio or the `APPLE_API_KEY` trio. When all three
variables of one trio are present, `release-desktop.mjs` passes
`-c.mac.notarize=true`; otherwise the build is intentionally unsigned.

The entitlements file is `packages/desktop/build/entitlements.mac.plist`
(JIT + unsigned executable memory for V8, network client/server, user-selected
files).

## Verification

```bash
pnpm verify:desktop-release                    # unsigned local build
pnpm verify:desktop-release -- --ui            # also run packaged UI smoke
pnpm verify:desktop-release -- --require-signed # release gate: unsigned is a failure
```

The verifier checks package/`RELEASE.json` version and commit, a clean working
tree, every artifact's size and SHA-256, `SHA256SUMS`, the generated
`latest-mac.yml` (version, file, size, SHA-512), dmg/zip integrity, code
signing, Gatekeeper, notarization ticket, and launches the packaged app with
`--smoke-test` (add `--ui` for `--ui-smoke`). It prints
`PASSED` / `FAILED` / `NOT EXECUTED` for each item. `--allow-dirty` permits
uncommitted files during local testing; `--e2e` runs the real-LLM suite and
therefore spends provider tokens.

Unsigned builds report signing, Gatekeeper and notarization as
`NOT EXECUTED`, with a final `Production signed/notarized release: NOT READY`.
A production sign-off needs `--require-signed`, a completed notarization
ticket, and a real-LLM E2E run. The Windows/Linux installers still require
manual acceptance on those platforms.

## Update feed

Host `RELEASE.json` at an HTTPS URL and paste it into
**Settings → 桌面端更新 → 保存并检查**. The main process compares `version`
with the running app version and shows the result; `url` (if present) gets an
"打开发布页" action.

When the release lists an artifact for the current platform/arch, **下载更新**
downloads it into the OS temp directory and verifies the `sha256` from
`RELEASE.json` before offering **打开安装包** (which opens the dmg/exe/AppImage
through the OS). Downloads are capped at 2 GB, must be HTTPS, and the renderer
can only ask the main process to open paths that were downloaded and verified
in this process.

Automatic download-and-install is still not enabled: it requires a signed app,
a stable feed, and `electron-updater` wiring. The release script now generates
`latest-mac.yml` (zip URL, size, SHA-512) next to the artifacts so a future
`electron-updater` feed can use the same directory. The manual check and
verified download are dependency-free and work with unsigned local builds.

## CI

`.github/workflows/desktop-release.yml` builds on tag pushes and manual
dispatch:

- **macOS arm64** — typecheck, build, UI smoke, dmg + zip, signing and
  notarization when the secrets are present, then
  `verify:desktop-release` (hashes, feed, package integrity and packaged-app
  headless smoke).
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
