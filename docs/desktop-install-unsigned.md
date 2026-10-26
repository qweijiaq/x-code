# 安装未签名版 X-Code Desktop

社区版没有 Apple Developer ID 签名和公证，所以 macOS 第一次打开会弹出安全提示。这是预期行为，不是安装包损坏。应用已经做了免费的 **ad-hoc 签名**，可以减少“应用已损坏”的情况，但不能绕过 Gatekeeper。

## 1. 下载并校验

从 [发布页](https://github.com/qweijiaq/x-code/releases/latest) 下载：

- `X-Code-<version>-arm64.dmg`
- `SHA256SUMS`

在终端中校验（把文件放在同一个目录）：

```bash
shasum -a 256 -c SHA256SUMS
```

看到 `OK` 再继续。校验和能确认文件没有被篡改或下载损坏。

## 2. 安装

1. 双击 `.dmg`。
2. 把 **X-Code** 拖进 **Applications**。
3. 推出磁盘映像。

## 3. 第一次打开（macOS 15 及以后）

1. 打开 **应用程序**，双击 X-Code。
2. 系统会提示“无法验证开发者”或“Apple 无法检查是否包含恶意软件”，点击 **完成** / **取消** 关闭提示。
3. 打开 **系统设置 → 隐私与安全性**。
4. 向下滚动到 **安全性**，会看到“已阻止使用 X-Code，因为无法验证开发者”。
5. 点击 **仍要打开**，输入管理员密码或使用 Touch ID。
6. 再次双击 X-Code，在确认框中选择 **打开**。

之后正常双击即可，系统会记住这个选择。

## 4. 如果提示“应用已损坏”

这通常是下载隔离标记造成的，不代表文件真的损坏。先确认 SHA256 校验通过，然后执行：

```bash
xattr -dr com.apple.quarantine /Applications/X-Code.app
```

再打开应用。如果仍然失败，删除应用并从 dmg 重新拖入，再执行上面的命令。

## 5. 为什么会有这个提示

- 应用没有 Apple Developer ID 证书，也没有经过 Apple 公证（两者都需要付费开发者账号）。
- 社区版做了 ad-hoc 签名，保证 app bundle 完整，但 Gatekeeper 仍然不认可发布者身份。
- 你需要在第一次打开时明确信任这个应用。

## 6. Windows / Linux

- **Windows**：未签名 exe 会触发 SmartScreen。点击 **更多信息 → 仍要运行**。
- **Linux**：AppImage 一般没有系统级签名提示。首次运行前可能需要：

```bash
chmod +x X-Code-<version>-x64.AppImage
```

## 7. 更安全的替代方式

如果你不想信任下载的二进制文件，可以从源码构建：

```bash
git clone https://github.com/qweijiaq/x-code.git
cd x-code
pnpm install
pnpm dev:desktop
```

或按 [`development/desktop-release.md`](./development/desktop-release.md) 在本地打包。源码构建的版本只在本机生成，不经过网络分发。
