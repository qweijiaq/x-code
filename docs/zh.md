# X-Code 中文文档

X-Code 是一个本地优先、模型无关的 AI 编程 agent：桌面端和命令行共享同一份会话、记忆、Skills、插件、MCP 与权限规则。代码、文档、凭据默认留在本机，模型和搜索服务由你选择。

## 快速开始

```bash
npm install -g @x-code-cli/cli@latest
xc --version
```

桌面端从 [GitHub Releases](https://github.com/qweijiaq/x-code/releases/latest) 下载。macOS 社区版使用 ad-hoc 签名、未公证，安装步骤见[未签名安装指南](/desktop-install-unsigned)。

## 指南

- [桌面端指南](/desktop)：窗口、Inspector、文档、Git、权限和 worktree。
- [用户手册](/desktop-manual)：应用内完整手册。
- [Skills](/skills) / [子代理](/sub-agents) / [MCP](/mcp) / [插件](/plugins) / [插件开发](/plugin-authoring)。
- [语义代码导航](/lsp)：TypeScript 定义、引用、诊断和重命名预览。
- [Hooks](/hooks) / [Shell 会话](/shell-sessions) / [会话互通](/peer-messaging) / [目标模式](/goal)。

## 设计原则

- **本地优先**：会话、附件、文档、记忆和凭据留在 `~/.x-code`（或 `X_CODE_HOME`）。
- **模型无关**：Claude、GPT、Gemini、DeepSeek、Qwen、Grok、GLM、Kimi、本地 Ollama / LM Studio，或任意 OpenAI 兼容端点。
- **可审阅**：文件编辑、shell 命令和下载都有 diff / 审批卡片；macOS 上 agent shell 运行在 workspace-write 沙箱里。
- **一个运行时，两个界面**：在终端开始的任务可以继续在桌面窗口里做，工具和权限边界不重启。
