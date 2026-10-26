<div align="center">

# X-Code

**A local-first, model-agnostic AI coding agent for the desktop and the terminal.**

Bring your own model and key. Sessions, memory, skills, MCP servers, plugins and
hooks are shared between the desktop app and the CLI.

[![license](https://img.shields.io/github/license/qweijiaq/x-code)](./LICENSE)
[![release](https://img.shields.io/github/v/release/qweijiaq/x-code)](https://github.com/qweijiaq/x-code/releases)
![platform](https://img.shields.io/badge/platform-macOS%20arm64-black)

[Download for macOS](https://github.com/qweijiaq/x-code/releases/latest) ·
[Desktop guide](./docs/desktop.en.md) ·
[User manual](./docs/desktop-manual.en.md) ·
[简体中文](./README.zh-CN.md)

</div>

## Why X-Code

- **Local first.** Sessions, documents, attachments and credentials stay on your
  machine. The agent talks only to the model, search and MCP services you
  configure.
- **Any model.** Claude, GPT, Gemini, DeepSeek, Qwen, Grok, GLM, Kimi, local
  Ollama / LM Studio models, or any OpenAI-compatible endpoint. Switch models
  from the top bar without changing your workflow.
- **One runtime, two surfaces.** The desktop app and the CLI share `~/.x-code`:
  start a task in the terminal, continue it in a window, with the same tools,
  permission rules and context.
- **Reviewable actions.** Every file edit, shell command and download is shown
  with a diff or an approval card. A three-level permission model and a macOS
  shell sandbox keep the agent inside the boundaries you set.

## Download and install

The desktop app is available for **macOS arm64**:

1. Open [GitHub Releases](https://github.com/qweijiaq/x-code/releases/latest) and
   download `X-Code-<version>-arm64.dmg`.
2. Verify it against `SHA256SUMS`, drag **X-Code** into Applications, and approve
   the first launch.

The community build is ad-hoc signed, not notarized, so macOS asks for approval
once. Full steps — including the `xattr` fallback for "app is damaged" — are in
the [unsigned install guide](./docs/desktop-install-unsigned.en.md).

The CLI is built from this repository — see [Terminal companion](#terminal-companion).

Windows and Linux desktop builds are not part of the 1.0 support statement yet.

## What the desktop app gives you

### Sessions and windows

- Multi-window and multi-tab sessions; `Cmd/Ctrl+T` for a tab, `Cmd/Ctrl+Shift+N`
  for a window.
- Branch **worktree windows**: open any local or `origin/*` branch in its own
  window with its own workspace and sessions.
- Session search, pin, archive, rename, drafts, Markdown / JSON / PDF export.
- Checkpoints, rewind, fork, edit-and-resend, regenerate, queue steering.
- Crash recovery and transcript salvage when a session is interrupted.

### One inspector for the workspace

Documents, Git changes, project checks, terminal and the file browser share a
single resizable inspector, so the conversation stays visible while you work.

- **Documents** — open PDF, Word, Excel, CSV, Markdown and source files; read
  pages, review proposed edits, and keep recent documents one click away.
- **Document library** — a local index with keyword and optional semantic
  search. Add folders, rebuild, and search without uploading files.
- **Git** — status, diffs, checkpoint revert, branch switching and worktree
  management.
- **Project checks** — detect test / lint / typecheck commands, run them and let
  the agent fix failures.
- **Terminal** — a full PTY that survives tab switches, separate from the
  sandboxed commands the agent runs.

### Input that fits real work

Markdown composer with preview, `@` file references, drag-and-drop attachments,
clipboard images, region or full-screen capture, and local Whisper voice input.
PDFs, Office documents, spreadsheets, images and audio are read locally; only
the extracted content or a page image is sent to the model you chose.

### Extensions

- **Skills** — reusable `SKILL.md` workflows, triggered with `/<name>`.
- **SkillHub / SkillsMP marketplace** — browse, install and register MCP servers
  from inside Settings.
- **Plugins** — bundle skills, sub-agents, commands, MCP servers and hooks, with
  a consent preview before installation.
- **MCP** — stdio and HTTP servers with OAuth; tools merge into the agent.
- **Hooks and commands** — user- and project-scoped lifecycle automation.
- **Permissions** — persisted allow rules, per-tool always-allow, or a global
  trust mode for a session.

### Search you control

`webSearch` is off until you configure a provider: Tavily, Brave, Exa,
Perplexity or Firecrawl. Pick a preferred service, test the key, and the agent
can search; `webFetch` keeps working without a key. DeepSeek models can use
DeepSeek's built-in search with the model key.

### Built for daily use

Themes, English/Chinese UI, zoom, a command palette (`Cmd/Ctrl+K`), desktop
notifications with deep links, safe backup/restore, redacted diagnostics
export, local model discovery, and a verified manual update check.

## First run

1. **Choose a model.** Open **Settings → Models & keys**, add a provider key, or
   point X-Code at Ollama / LM Studio. Keys are stored with the macOS Keychain
   (`safeStorage`) or a `0600` file and never returned to the renderer.
2. **Optional: add a search key.** **Settings → Tools → Search service** — paste
   a Tavily key (free tier), choose it as preferred and press **Test
   connection**.
3. **Open the manual.** The **?** button in the top bar opens the complete
   in-app [user manual](./docs/desktop-manual.en.md).

No key? The app starts with a local demo model so you can explore the interface
without spending tokens.

## Terminal companion

The CLI is the same agent without the window — useful for SSH, scripts,
`--print` automation and piping. It is built from this repository:

```bash
pnpm build
pnpm --filter @x-code-cli/cli link --global   # exposes xc / x-code

cd your-project
xc                                      # interactive session
xc "Explain the overall architecture"   # run one prompt
xc -p "summarize the failing test"      # non-interactive output
xc --plan "migrate the build to ESM"    # read-only planning first
```

Sessions, memory, skills, plugins, MCP and permission rules are shared with the
desktop app. Run `xc --help` for all flags.

## Supported models

Anthropic Claude, OpenAI (API key or ChatGPT sign-in), DeepSeek, Google Gemini,
Alibaba Qwen, xAI Grok, Zhipu GLM, Moonshot Kimi, local Ollama / LM Studio, and
any OpenAI-compatible gateway via `OPENAI_COMPATIBLE_API_KEY` +
`OPENAI_COMPATIBLE_BASE_URL` (model ids as `custom:<id>`).

The in-app model picker shows each model's context window and supports per-model
overrides. Vision attachments go only to the active vision model; text-only
models get local OCR instead.

## Privacy and security

- No telemetry. Conversations, documents, attachments, memory and keys stay
  under `~/.x-code` (or `X_CODE_HOME`).
- Network access happens only for the model provider you select, the search
  service you configure, explicitly added MCP servers, marketplaces, and update
  checks.
- On macOS the agent's shell runs in a workspace-write sandbox; sensitive paths
  are blocked and network access is opt-in. Your own terminal is unrestricted.
- API keys use the OS keychain when available, otherwise a `0600` file shown as
  plaintext storage in Settings.

## Shortcuts

| Shortcut                    | Action                   |
| --------------------------- | ------------------------ |
| `Cmd/Ctrl+K`                | Command palette          |
| `Cmd/Ctrl+N` / `Cmd/Ctrl+T` | New session / tab        |
| `Cmd/Ctrl+Shift+N`          | New window               |
| `Cmd/Ctrl+Shift+F`          | Search sessions          |
| `Cmd/Ctrl+F`                | Find in conversation     |
| `Cmd/Ctrl+,`                | Settings                 |
| `Cmd/Ctrl+Shift+D`          | Document panel           |
| `Esc`                       | Close inspector / dialog |

## Build from source

Requires Node.js 22+ and pnpm 10.x. The repository pins pnpm through
`packageManager` (10.28.2); use `corepack enable` if a newer pnpm is installed
globally.

```bash
git clone https://github.com/qweijiaq/x-code.git
cd x-code
pnpm install

pnpm dev:desktop     # build and launch the desktop app
pnpm dev             # build and run the CLI from source
```

Packaging and signing notes live in
[`docs/development/desktop-release.md`](./docs/development/desktop-release.md).

## Documentation

| Document                                                                  | Contents                                        |
| ------------------------------------------------------------------------- | ----------------------------------------------- |
| [Desktop guide](./docs/desktop.en.md)                                     | Windows, inspector, documents, Git, permissions |
| [User manual](./docs/desktop-manual.en.md)                                | Complete in-app manual                          |
| [Unsigned install guide](./docs/desktop-install-unsigned.en.md)           | Gatekeeper and verification steps               |
| [Skills](./docs/skills.en.md)                                             | Reusable workflow templates                     |
| [Sub-agents](./docs/sub-agents.en.md)                                     | Built-in and custom agents                      |
| [MCP](./docs/mcp.en.md)                                                   | Server configuration                            |
| [Knowledge and memory](./docs/knowledge.en.md)                            | `AGENTS.md` layers and auto-memory              |
| [Plugins](./docs/plugins.en.md) / [marketplace](./docs/marketplace.en.md) | Extension packaging and sources                 |
| [Hooks](./docs/hooks.en.md)                                               | Lifecycle automation                            |
| [Shell sessions](./docs/shell-sessions.en.md)                             | Background terminals                            |
| [Desktop release](./docs/development/desktop-release.md)                  | Build, sign, verify, update feed                |

## Feedback

Issues and pull requests are welcome:
<https://github.com/qweijiaq/x-code/issues>

## License

[MIT](./LICENSE)
