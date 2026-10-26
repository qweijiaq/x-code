<div align="center">

# X-Code

**本地优先、模型无关的 AI 编程助手，提供桌面端和命令行两种形态。**

自带模型和 Key。桌面端与 CLI 共用同一套会话、记忆、技能、MCP、插件和 Hooks。

[![license](https://img.shields.io/github/license/qweijiaq/x-code)](./LICENSE)
[![release](https://img.shields.io/github/v/release/qweijiaq/x-code)](https://github.com/qweijiaq/x-code/releases)
![platform](https://img.shields.io/badge/platform-macOS%20arm64-black)

[下载 macOS 版](https://github.com/qweijiaq/x-code/releases/latest) ·
[桌面端指南](./docs/desktop.md) ·
[用户手册](./docs/desktop-manual.md) ·
[English](./README.md)

</div>

## 为什么选 X-Code

- **本地优先。** 会话、文档、附件和凭据都留在本机。Agent 只访问你配置的模型、
  搜索和 MCP 服务。
- **不绑定模型。** Claude、GPT、Gemini、DeepSeek、Qwen、Grok、GLM、Kimi、本地
  Ollama / LM Studio，以及任意 OpenAI 兼容接口。在顶栏切换模型，不用改变工作方式。
- **一套运行时，两种界面。** 桌面端和 CLI 共享 `~/.x-code`：终端里开始的任务可以
  在窗口里继续，工具、权限规则和上下文完全一致。
- **每一步可审查。** 文件修改有 diff，shell 命令和下载有确认卡片；三级权限模型和
  macOS shell 沙箱把 Agent 限制在你设定的边界内。

## 下载与安装

桌面端当前提供 **macOS arm64** 版本：

1. 打开 [GitHub Releases](https://github.com/qweijiaq/x-code/releases/latest)，下载
   `X-Code-<version>-arm64.dmg`。
2. 用 `SHA256SUMS` 校验后，把 **X-Code** 拖进 Applications，首次打开时按提示放行。

社区版是 ad-hoc 签名、未公证，所以 macOS 首次会要求手动批准。完整步骤、以及
遇到“应用已损坏”时的 `xattr` 处理方式见
[未签名版安装指南](./docs/desktop-install-unsigned.md)。

CLI 通过 npm 安装：

```bash
npm install -g @x-code-cli/cli
```

Windows / Linux 桌面版暂不在 1.0 的支持范围内。

## 桌面端能做什么

### 会话与窗口

- 多窗口、多标签会话；`Cmd/Ctrl+T` 新建标签，`Cmd/Ctrl+Shift+N` 新建窗口。
- 分支 **worktree 窗口**：任意本地分支或 `origin/*` 远程分支都可以在独立窗口打开，
  拥有自己的工作区和会话目录。
- 会话搜索、置顶、归档、重命名、草稿保留，以及 Markdown / JSON / PDF 导出。
- 检查点、回退、分叉、编辑重发、重新生成、运行中插入消息。
- 异常中断后的崩溃恢复和 transcript 抢救。

### 一个 Inspector 覆盖整个工作区

文档、Git 改动、项目检查、终端和文件浏览器共用一个可调整宽度的右侧 Inspector，
聊天内容始终可见。

- **文档** — 打开 PDF、Word、Excel、CSV、Markdown 和源码文件；按页阅读、审查
  修改建议，最近文档一键切回。
- **文档库** — 本地索引，支持关键词和可选语义检索。添加目录、重建索引、直接搜索，
  文件不会被上传。
- **Git** — 状态、diff、按检查点撤销、切换分支和 worktree 管理。
- **项目检查** — 自动识别 test / lint / typecheck 命令，运行后让 Agent 修复失败项。
- **终端** — 完整的 PTY 终端，切换标签不中断，和 Agent 的沙箱命令相互独立。

### 面向真实工作的输入方式

Markdown 输入与预览、`@` 引用工作区文件、拖拽附件、粘贴图片、区域/全屏截图、
本地 Whisper 语音输入。PDF、Office 文档、表格、图片和音频都在本地解析，只有提取
出的内容或页面图片会发送给你选择的模型。

### 扩展

- **Skills** — 可复用的 `SKILL.md` 工作流，用 `/<名称>` 触发。
- **SkillHub / SkillsMP 技能市场** — 在设置里浏览、安装，并可注册 MCP 服务器。
- **插件** — 打包 skills、子 Agent、命令、MCP 和 Hooks，安装前显示权限与配置预览。
- **MCP** — 支持 stdio 和 HTTP（含 OAuth），服务器工具自动并入 Agent。
- **Hooks 与自定义命令** — 用户级和项目级生命周期自动化。
- **权限** — 持久化允许规则、按工具始终允许，或为整个会话开启信任模式。

### 搜索由你控制

`webSearch` 默认不可用，配置 Tavily、Brave、Exa、Perplexity 或 Firecrawl 任一
服务后才启用。可以指定首选服务、测试 Key；`webFetch` 不依赖搜索 Key。使用
DeepSeek 模型时，也可以直接用模型 Key 走内置搜索。

### 日常体验

主题、中英文界面、缩放、命令面板（`Cmd/Ctrl+K`）、带深链的桌面通知、安全的
备份/恢复、脱敏诊断导出、本地模型发现，以及带校验的手动更新检查。

## 首次运行

1. **配置模型。** 打开 **设置 → 模型与密钥**，填写任一家厂商的 Key，或者连接
   Ollama / LM Studio。密钥通过 macOS Keychain（`safeStorage`）或 `0600` 文件保存，
   不会回传到渲染进程。
2. **可选：配置搜索。** **设置 → 工具 → 搜索服务** 粘贴 Tavily Key（有免费额度），
   选为首选并点 **测试连接**。
3. **打开手册。** 顶栏 **?** 可以随时打开完整的内置[用户手册](./docs/desktop-manual.md)。

没有配置 Key 时，应用会使用本地演示模型，方便先体验界面，不会消耗真实额度。

## 终端形态

CLI 是同一个 Agent 的命令行界面，适合 SSH、脚本、`--print` 自动化和管道。

```bash
cd your-project
xc                                      # 交互式会话
xc "解释项目的整体架构"                  # 单次提示
xc -p "总结失败的测试"                   # 非交互输出
xc --plan "把构建迁移到 ESM"             # 先只读规划
```

会话、记忆、技能、插件、MCP 和权限规则与桌面端共享。完整参数见 `xc --help`。

## 支持的模型

Anthropic Claude、OpenAI（API Key 或 ChatGPT 登录）、DeepSeek、Google Gemini、
阿里 Qwen、xAI Grok、智谱 GLM、Moonshot Kimi、本地 Ollama / LM Studio，以及通过
`OPENAI_COMPATIBLE_API_KEY` + `OPENAI_COMPATIBLE_BASE_URL` 接入的任意 OpenAI
兼容网关（模型 ID 写成 `custom:<id>`）。

应用内模型选择器会显示每个模型的上下文上限，并支持按模型覆盖。图片附件只会发给
当前视觉模型；纯文本模型改用本地 OCR，不会转发给其他厂商。

## 隐私与安全

- 没有遥测。会话、文档、附件、记忆和密钥都保存在 `~/.x-code`（或 `X_CODE_HOME`）。
- 只有你选择的模型厂商、配置的搜索服务、显式添加的 MCP 服务器、技能市场以及
  更新检查会发生网络请求。
- macOS 上 Agent 的 shell 运行在 workspace-write 沙箱中，敏感路径不可读写，网络
  默认关闭；你自己的终端不受限制。
- API Key 优先使用系统钥匙串，不可用时退化为 `0600` 文件，设置页会明确提示存储类型。

## 快捷键

| 快捷键                      | 操作                  |
| --------------------------- | --------------------- |
| `Cmd/Ctrl+K`                | 命令面板              |
| `Cmd/Ctrl+N` / `Cmd/Ctrl+T` | 新建会话 / 标签       |
| `Cmd/Ctrl+Shift+N`          | 新建窗口              |
| `Cmd/Ctrl+Shift+F`          | 搜索会话              |
| `Cmd/Ctrl+F`                | 当前会话内查找        |
| `Cmd/Ctrl+,`                | 设置                  |
| `Cmd/Ctrl+Shift+D`          | 文档面板              |
| `Esc`                       | 关闭 Inspector / 弹窗 |

## 从源码运行

需要 Node.js 22+ 和 pnpm 10.x。仓库通过 `packageManager` 固定 pnpm 版本
（10.28.2）；如果全局装的是更新版本，先执行 `corepack enable`。

```bash
git clone https://github.com/qweijiaq/x-code.git
cd x-code
pnpm install

pnpm dev:desktop     # 构建并启动桌面端
pnpm dev             # 从源码构建并运行 CLI
```

打包、签名和更新源说明见
[`docs/development/desktop-release.md`](./docs/development/desktop-release.md)。

## 文档

| 文档                                                      | 内容                             |
| --------------------------------------------------------- | -------------------------------- |
| [桌面端指南](./docs/desktop.md)                           | 窗口、Inspector、文档、Git、权限 |
| [用户手册](./docs/desktop-manual.md)                      | 完整的应用内手册                 |
| [未签名安装指南](./docs/desktop-install-unsigned.md)      | Gatekeeper 与校验步骤            |
| [Skills](./docs/skills.md)                                | 可复用工作流模板                 |
| [子 Agent](./docs/sub-agents.md)                          | 内置与自定义 Agent               |
| [MCP](./docs/mcp.md)                                      | 服务器配置                       |
| [知识库与记忆](./docs/knowledge.md)                       | `AGENTS.md` 分层与自动记忆       |
| [插件](./docs/plugins.md) / [市场](./docs/marketplace.md) | 扩展打包与来源                   |
| [Hooks](./docs/hooks.md)                                  | 生命周期自动化                   |
| [后台 Shell](./docs/shell-sessions.md)                    | 后台终端                         |
| [桌面端发布](./docs/development/desktop-release.md)       | 构建、签名、验证、更新源         |

## 反馈

欢迎通过 Issue 和 Pull Request 反馈：
<https://github.com/qweijiaq/x-code/issues>

## License

[MIT](./LICENSE)
