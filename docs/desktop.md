# X-Code Desktop

> 完整的分功能说明、截图和排障步骤见[用户手册](./desktop-manual.md)（应用内顶栏
> **?** 也可直接打开）。社区版未签名，首次打开被 macOS 拦截时见
> [未签名版安装指南](./desktop-install-unsigned.md)。

X-Code Desktop 是同一个 agent runtime 的图形界面：模型、工具、会话、记忆、
插件、MCP、技能、Hooks 与 CLI 完全共享 `~/.x-code`（或 `X_CODE_HOME`）。桌面端
不改变 agent 语义，只是把终端里的交互变成窗口、表单和可点击的卡片。

## 运行与安装

```bash
pnpm install
pnpm dev:desktop            # 构建全部包并从 dist 启动
```

本地打包（macOS，未签名）：

```bash
pnpm release:desktop --arch arm64
# 产物：packages/desktop/release/X-Code-<version>-arm64.dmg / .zip
```

`pnpm --filter @x-code-cli/desktop package:dir` 可以只生成目录形式的解包应用，
用于检查 `app.asar.unpacked`。签名、公证和 Windows/Linux 构建见
[`development/desktop-release.md`](./development/desktop-release.md)。

首次启动会显示引导页；API Key 在 **设置 → 模型与密钥** 中填写，密钥通过
macOS Keychain / Electron `safeStorage` 加密保存（不可用时退化为权限为 `0600`
的明文文件，界面会提示存储类型）。

## 会话与窗口

- 每个窗口有自己的 runtime，互不阻塞；`Cmd/Ctrl+T` 新建标签页，
  `Cmd/Ctrl+Shift+N` 新建窗口。
- 侧边栏可以搜索、重命名、置顶、归档会话，并导出 Markdown / JSON / PDF。
- 侧栏顶部的“上手清单”列出 5 个高频能力入口（附加文件、截图、文档面板、
  命令面板、技能市场）；实际使用后自动打勾，也可一键收起，状态只保存在本机。
- 关闭后重新打开会恢复窗口位置、打开的标签页和每个窗口的工作区。
- 会话消息写入 JSONL；异常中断后如果检测到 transcript 完整性问题，加载时会
  提示"恢复损坏会话"，把可解析的消息抢救到一个新会话，原文件不改动。
- 同一会话同一时间只能在一个窗口打开；把会话移动到新窗口会关闭原标签页。

## 分支与 worktree

Git 分支菜单可以：

- 在当前 checkout 上切换分支；
- 为已有分支（含 `origin/*` 远程分支）打开独立窗口，必要时创建本地跟踪分支
  和 `git worktree`；
- 新建分支并选择父目录；
- 删除 worktree（有未提交改动时需要二次确认）、清理失效 worktree。

worktree 窗口有独立的工作区路径和 `.x-code/sessions`，不会覆盖全局最近项目。

## 右侧工作区

文档、Git、项目检查、终端和文件浏览器共用同一个右侧 Inspector：点击顶部标签
切换，拖左边缘可调整宽度，`×` 或 `Esc` 关闭后聊天恢复全宽。它们不再各自弹出
遮罩式抽屉，因此可以一边看文档、diff 或终端，一边继续对话。

## 对话输入

- Markdown 编辑与预览、`@` 文件引用、斜杠命令面板、`Cmd+K` 全局面板。
  输入 `/` 会列出**全部**命令（列表可滚动，方向键选择并自动滚动到可见位置）。
  `Cmd+K` 支持按同义词搜索能力（截图、worktree、技能市场、权限规则等），
  输入框下方的“全部能力”也是同一入口。
- 粘贴或拖入图片、通过截图菜单附加屏幕区域；图片会显示缩略图并保存在
  `~/.x-code/attachments`，重新打开历史会话时恢复。
- 长文档、PDF、Word、Excel 通过 `readDocument` / 文档面板查看；PDF 支持分页
  渲染、OCR 与原文文本切换。输入框左侧的文档图标或 `Cmd/Ctrl+Shift+D` 直接
  打开当前工作区上次的文档；面板顶部常驻最近文档标签，`Esc` 关闭。
- 语音输入使用本地 Whisper，音频不上传；首次使用可能下载模型。
- 每轮工具调用可以单独展开，也可以整轮收起；用户消息和回答都可以复制。
- 输入框在切换会话时保留草稿；支持编辑并重发、重新生成、消息排队。
- 空状态会根据当前工作区推荐下一步：未提交改动、可运行的项目检查、最近文档、
  表格文件、README 等；没有可推断内容时退回任务模式的通用提示。
- 顶栏的工作模式（编程/写作/科研/办公）只调整回答侧重点，不限制可用工具；
  菜单里会显示每种模式的侧重点。

## 上下文与模型

- 输入框下方显示 `已用 / 上限` 和百分比；上限来自模型表、provider 兜底或
  配置覆盖，达到 80% 时自动压缩。
- **设置 → 模型与密钥** 可以为当前模型单独设置上下文上限（≥ 32768 tokens），
  覆盖只影响该模型；切换模型后可分别配置。
- 模型菜单支持搜索、本地模型（Ollama / LM Studio）分组，并显示每个模型的上限。
- 支持 ChatGPT 登录、API Key、OpenAI-compatible 自定义端点和自定义模型 ID。

## 权限与安全

- 三级权限模型：始终允许 / 询问 / 拒绝。破坏性 shell 命令、路径校验和计划模式
  在规则之前生效。
- **设置 → 权限** 列出当前项目已持久化的"不再询问"规则，可删除或手动添加。
  shell 支持前缀、精确、整个工具三种规则；其他工具只支持整个工具。规则在
  runtime 启动时加载，重启后仍然生效。
- **设置 → 工具 → Shell 沙箱** 在 macOS 上把 agent 的 shell 限制在 workspace-write
  沙箱：只能写工作区和临时目录，敏感目录不可读写，网络默认关闭；内置终端不受
  此限制。Hooks / stdio MCP 可以选择一并纳入沙箱。
- 项目级 Hooks 在信任项目之前不会执行；插件安装前显示权限预览。
- 渲染进程启用 `sandbox`、`contextIsolation`，只通过 preload 暴露白名单方法；
  API Key 不会回传给渲染进程。

## 设置与其他功能

- 主题（浅色/深色）与语言（中文/英文）即时切换，并同步到其他窗口。
- Git 面板查看变更、diff、撤销本轮修改；项目检查面板运行检测与自动修复。
- 内置终端、文件树和轻量编辑器；diff 卡片可直接在 VS Code / Cursor 打开对应行。
- 后台 shell 会话、系统通知、窗口缩放、托盘与全局快捷键。
- **设置 → 工具** 可开启浏览器子代理（通过 `npx @playwright/mcp` 复用受管
  Chrome）和独立的自动视觉检查。
- 文档库把 PDF / Word / Excel / Markdown 索引到本机，支持关键词与可选语义检索。
- 存储面板统计会话、附件、文档库、语音模型占用，并提供清理。
- **设置 → 工具 → 诊断与支持** 可导出不含 API Key、MCP env/header 或命令内容的
  JSON 快照（版本、模型、MCP 状态、工具/技能数量、沙箱设置等），便于排查问题。
  界面渲染失败时会显示恢复页，可重新加载、复制错误或导出诊断；渲染错误会追加到
  `~/.x-code/logs/desktop-errors.log`。

## 技能市场

**设置 → 技能市场** 内置两个来源，安装方式与插件市场一致：写入
`~/.x-code/skills/<name>`，重载技能注册表后下一轮对话生效。

- **SkillHub**（国内优先）：搜索与下载走 `api.skillhub.cn`，无需登录。安装时
  下载 zip，校验路径、文件数、解压大小和符号链接，确认包含 `SKILL.md` 后复制
  到用户技能目录。每次搜索会缓存 5 分钟。
- **SkillsMP**：只读社区目录（300 万+ 来自 GitHub 的技能）。匿名搜索有较小的
  每小时额度；设置环境变量 `SKILLSMP_API_KEY` 后使用账号额度。安装时从结果
  指向的 `github.com` 仓库执行浅克隆；在 macOS 上会自动读取系统代理并传给
  `git`，受限网络无需额外配置。macOS 之外或自定义代理仍可通过
  `HTTPS_PROXY` / `HTTP_PROXY` 环境变量控制。
- SkillsMP 一侧提供 **注册为 MCP 服务器**：把 `https://skillsmp.com/mcp` 写入
  用户级 MCP 配置（`~/.x-code/config.json`）。注册会立即重载 MCP 并刷新提示缓存，
  agent 可直接调用 `search_skills`、`get_skill`、`list_categories`，无需重启。
  如果已有同名但配置不同的 `skillsmp` 服务器，市场不会覆盖，只提示冲突。

第三方技能的内容会进入模型上下文，安装前请自行确认来源可信。市场只负责
搜索与复制文件，不会执行技能中的脚本。

## 更新

**设置 → 桌面端更新** 默认使用官方 GitHub Release 的 `RELEASE.json` 检查新版本，
也可以填写自建发布目录的 HTTPS 地址。如果发布信息包含当前平台的安装包，可以
下载到临时目录并校验 `sha256`，然后打开安装包手动安装。自动下载并安装尚未启用：
它需要签名后的应用和稳定的更新源。
