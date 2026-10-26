# Installing the unsigned X-Code Desktop build

The community build does not have an Apple Developer ID signature or notarization, so macOS shows a security prompt on first launch. This is expected, not a corrupted download. The app does receive a free **ad-hoc signature** to make the bundle complete, which avoids some "app is damaged" cases, but it does not satisfy Gatekeeper.

## 1. Download and verify

Download from the [release page](https://github.com/qweijiaq/x-code/releases/latest):

- `X-Code-<version>-arm64.dmg`
- `SHA256SUMS`

From the download directory:

```bash
shasum -a 256 -c SHA256SUMS
```

Continue only when every line says `OK`. The checksums confirm the file was not corrupted or altered.

## 2. Install

1. Open the `.dmg`.
2. Drag **X-Code** into **Applications**.
3. Eject the disk image.

## 3. First launch (macOS 15 and later)

1. Open **Applications** and double-click X-Code.
2. When macOS says it cannot verify the developer, dismiss the dialog.
3. Open **System Settings → Privacy & Security**.
4. Scroll to **Security**. macOS shows that X-Code was blocked.
5. Click **Open Anyway** and authenticate with Touch ID or the admin password.
6. Double-click X-Code again and choose **Open** in the confirmation.

Later launches work with a normal double-click.

## 4. If macOS says the app is damaged

This is usually the quarantine flag, not a broken archive. First confirm the SHA256 check passed, then run:

```bash
xattr -dr com.apple.quarantine /Applications/X-Code.app
```

Open the app again. If it still fails, remove it, drag it from the dmg again, and repeat the command.

## 5. Why the warning appears

- The build has no Apple Developer ID certificate and has not been notarized; both require a paid Apple Developer Program membership.
- The ad-hoc signature keeps the app bundle intact but Gatekeeper cannot identify a publisher.
- You explicitly trust the app on first launch.

## 6. Windows / Linux

- **Windows**: an unsigned exe triggers SmartScreen. Choose **More info → Run anyway**.
- **Linux**: AppImages usually have no OS-level signature prompt. Make it executable first:

```bash
chmod +x X-Code-<version>-x64.AppImage
```

## 7. Safer alternative

If you would rather not trust a downloaded binary, build from source:

```bash
git clone https://github.com/qweijiaq/x-code.git
cd x-code
pnpm install
pnpm dev:desktop
```

Or package locally following [`development/desktop-release.md`](./development/desktop-release.md). A source build never leaves your machine.
