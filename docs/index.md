---
layout: home

hero:
  name: X-Code
  text: Local-first AI coding agent
  tagline: Bring your own model. Keep sessions, memory, skills, MCP servers and credentials on your machine.
  actions:
    - theme: brand
      text: Desktop guide
      link: /desktop.en
    - theme: alt
      text: 简体中文
      link: /zh
    - theme: alt
      text: GitHub
      link: https://github.com/qweijiaq/x-code

features:
  - title: Desktop and CLI, one runtime
    details: Start in the terminal and continue in a window. Both surfaces share ~/.x-code, tools, memory, skills, plugins, MCP servers and permission rules.
  - title: Any model
    details: Claude, GPT, Gemini, DeepSeek, Qwen, Grok, GLM, Kimi, local Ollama / LM Studio, or any OpenAI-compatible endpoint.
  - title: Reviewable by default
    details: File edits, shell commands and downloads go through diff cards and a three-level permission model. On macOS the agent shell runs in a workspace-write sandbox.
  - title: Work where the context is
    details: PDF, Word, Excel, CSV and source files open in the same inspector as Git, project checks and a full terminal.
---

## Start here

- [Desktop guide](/desktop.en) — windows, inspector, documents, Git, permissions and worktrees.
- [User manual](/desktop-manual.en) — the complete in-app manual.
- [Skills](/skills.en), [sub-agents](/sub-agents.en), [MCP](/mcp.en) and [plugins](/plugins.en).
- [Plugin authoring](/plugin-authoring.en) — manifest contract, `xc plugin validate`, `xc plugin schema`.
- [Semantic code navigation](/lsp.en) — TypeScript definitions, references, diagnostics and rename preview.

## 中文文档

- [桌面端指南](/desktop) · [用户手册](/desktop-manual) · [Skills](/skills) · [子代理](/sub-agents)
- [MCP](/mcp) · [插件](/plugins) · [插件开发](/plugin-authoring) · [语义代码导航](/lsp)
- [完整中文入口](/zh)

## Install

```bash
npm install -g @x-code-cli/cli@latest
xc --version
```

Desktop builds are on [GitHub Releases](https://github.com/qweijiaq/x-code/releases/latest).
The community macOS build is ad-hoc signed, not notarized; see the
[unsigned install guide](/desktop-install-unsigned.en).
