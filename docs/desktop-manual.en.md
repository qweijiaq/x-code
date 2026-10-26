# X-Code Desktop User Manual

A complete guide to daily use: from the first model setup to sessions, documents, Git, the skill marketplace, permissions and backups. If you cannot find an entry point, press `Cmd/Ctrl+K` and search for the capability by name.

## Quick Start

1. Launch X-Code Desktop. The first run shows onboarding; choose a provider and enter an API key, or skip and configure it later in **Settings → Models and keys**.
2. Pick or add a project folder in the sidebar. The desktop app shares `~/.x-code` with the CLI, so existing sessions, skills, plugins and memory appear automatically.
3. Describe the task in the composer and press `Enter`; `Shift+Enter` inserts a newline.
4. Use the composer toolbar or the right-hand Inspector to open files, documents, Git or the terminal.
5. Type `/` for every slash command, or press `Cmd/Ctrl+K` for the command palette.

Without an API key the app uses the demo model, which only exercises the UI and does not call a real model.

## Interface Overview

![Main window](shot:chat)

- **Top bar**: model picker, task mode, sidebar toggle, terminal, settings, more tools.
- **Sidebar**: projects, getting-started checklist and sessions. Search, pin, archive, rename and export sessions.
- **Session tabs**: one window can host several sessions; `Cmd/Ctrl+T` opens a tab, `Cmd/Ctrl+Shift+N` a new window.
- **Right-hand Inspector**: documents, Git, project checks, terminal, file browser and the conversation outline share one resizable pane.
- **Composer**: Markdown toolbar, attach, screenshot, voice, send/stop, context usage and the "All capabilities" link.

## Sessions and Tabs

- **New session**: sidebar `＋`, `Cmd/Ctrl+N` or `Cmd/Ctrl+T`. The first prompt immediately becomes the tab and sidebar title; messages are flushed during the turn, so the sidebar updates even while a long turn is still running.
- **Switch**: click a sidebar row or a tab; the current draft survives the switch.
- **Search**: sidebar search filters by title and first prompt; `Cmd/Ctrl+Shift+F` focuses it.
- **Pin / archive**: session row menu. Archived sessions are available under "Show archived".
- **Rename / delete**: session row menu; deletion cannot be undone.
- **Export**: session menu to Markdown, JSON or PDF.
- **Edit and resend**: edit a user message to rewrite the previous turn. File changes from that turn remain and can be reverted from the diff.
- **Regenerate**: regenerate the last answer; turns with attachments must be edited to text first.
- **Rewind**: `/rewind` or the palette; choose code only, conversation only, or both.
- **Fork**: `/fork` copies the current session into an independent conversation.
- **Recover a damaged session**: when transcript integrity fails, the app offers to salvage parseable messages into a new session without modifying the original file.

## Conversation outline

The **Outline** tab in the right-hand inspector (also the top-bar outline button and the Tools menu) lists every question and answer in the current conversation; click one to jump there. A jump pauses auto-follow; the **↓** button near the composer resumes it.

## Composer, Attachments and Voice

- **Markdown**: bold, italic, code, headings, lists, quotes and preview; `Cmd/Ctrl+B/I/E` format shortcuts.
- **@ references**: type `@` to search workspace files and insert a path reference.
- **Attachments**: use the paperclip, drag files into the window, or paste images.
- **Images**: thumbnails are stored under `~/.x-code/attachments` and restored when a historical session is reopened.
- **Screenshots**: select a region or the entire screen; the image becomes an attachment.
- **Voice**: click the microphone to record, click again to stop and transcribe locally. Audio is never uploaded; the Whisper model may download on first use.
- **Document attachments**: PDF, Word, Excel, PowerPoint, Markdown, images and audio. Text is parsed locally; scanned PDFs can use local OCR.
- **Message actions**: copy user messages; expand each tool call or the whole turn; copy code blocks and toggle wrapping.

## Documents and Library

- **Open**: the document icon beside the composer, `Cmd/Ctrl+Shift+D`, the palette, or `/doc`. It reopens the last document for the workspace.
- **Recent tabs**: the Inspector lists recent documents at the top; `Esc` or the close button closes it.
- **Pages and sheets**: PDFs support page rendering, extracted text, OCR and page jumps; Excel files show sheet tabs; Markdown has a rendered view.
- **Ask about a document**: attach it to the conversation, request a summary, or ask per page.
- **Review changes**: if an editable document changes after opening, view the diff and accept hunks, or save the current content as the new baseline.
- **Document library**: Settings → Document library builds a local index with keyword and optional semantic search. Content stays on this machine.
- **Export**: the `documentExport` tool and the document panel can write PDF, DOCX, XLSX, CSV and other local files.

## Git and Worktrees

![Inspector](shot:inspector)

- **Git changes**: the Inspector Git tab shows branch, file states, line stats and diffs.
- **Undo this turn**: when the turn has a checkpoint, revert its file changes; individual edits can be reverted from diff cards.
- **Branch windows**: the Git icon beside a project opens the branch picker. Selecting a local or `origin/*` branch opens an independent worktree in a new window.
- **Create a branch**: enter a new branch name and choose a parent directory; the worktree is created beside the repository by default.
- **Remove / prune**: remove a worktree (extra confirmation when dirty) and prune stale records.
- **Guards**: the main checkout, the worktree in use by a window, and locked worktrees cannot be removed.
- **Old Git**: versions below 2.17 use a fallback path with reduced worktree support.

## Project Checks

- Open from the Inspector "Checks" tab, the palette, or `/checks`.
- Detects Node (`package.json` scripts) and Cargo checks.
- Run manually, enable automatic checks after each turn, or send failures to the agent for a fix.
- Checks run in the project directory; long output is truncated in the UI and included in the fix prompt.

## Models and Context

![Settings](shot:settings)

- **Model picker**: search, local models (Ollama / LM Studio) grouped separately, with each model's ceiling.
- **Providers**: Settings → Models and keys. Anthropic, OpenAI, DeepSeek, Gemini, Qwen, xAI, Zhipu, Moonshot, Kimi and any OpenAI-compatible endpoint.
- **Test connection**: sends a real request and reports latency and model id.
- **Custom model**: custom model id and base URL; keys stay local.
- **Context meter**: used / limit and percentage below the composer; automatic compression starts at 80% and keeps roughly the latest 20k tokens. Resumed sessions are judged by the live context, not the cumulative input tokens of the whole history.
- **Per-model limit**: set a ceiling (at least 32768 tokens) for the active model; it affects only that model.
- **Switching models**: keeps the last usage reading and replaces only the ceiling.
- **ChatGPT sign-in**: shared with the CLI; subscription or API keys per provider.

## Skills, Plugins and MCP

![Skill marketplace](shot:skills)

- **Skills**: Settings → Skills lists installed skills, enables/disables them, imports files or folders, or runs an `npx skills add ...` command. The list hot-reloads after installs; use **Rescan** for an immediate refresh, or **Refresh environment** after installing a CLI dependency outside the app. When a skill ships `requirements.txt`, `pyproject.toml` or `package.json`, **Install dependencies** creates an isolated environment under `~/.x-code/skill-runtime/<skill>` instead of writing into the project. You can clear the runtime, or clean legacy `runtime/` / `venv/` folders left inside the skill directory by older installers.
- **Skill marketplace**: Settings → Skill marketplace embeds SkillHub and SkillsMP.
  - SkillHub: China-first catalog, no login; installs validate zip paths, size and structure.
  - SkillsMP: read-only community catalog with an anonymous hourly allowance; set `SKILLSMP_API_KEY` for account allowance. Skills install from the GitHub repository in each result.
  - The SkillsMP side can register `https://skillsmp.com/mcp` as a user-scope MCP server so the agent can call `search_skills` directly.
- **Plugins**: browse, search, install, enable/disable and uninstall; installs show permissions and user-config previews. Local folders and Git sources are supported.
- **MCP**: Settings → MCP adds stdio or HTTP servers; view connection state, tool count and auth status. Project servers require trust.
- **Sub-agents**: built-in explore, general-purpose, plan, code-reviewer and goal-verifier; `/list-agents` lists them. Custom agents live in user/project directories and require a restart after editing.
- **Custom commands**: Settings → Commands or `~/.x-code/commands/`; invoke with `/name`, arguments are supported.
- **Hooks**: Settings → Hooks manages user and project lifecycle scripts; project hooks do not run before the project is trusted.

## Permissions and Security

- **Three levels**: always allow / ask / deny. Destructive shell commands, path checks and plan mode are evaluated before allow rules.
- **Permission rules**: Settings → Permissions lists persisted "don't ask again" rules; add or remove them. Shell supports prefix, exact and whole-tool rules; other tools are whole-tool only.
- **Always allow**: Settings → Tools enables it per tool or globally. Global always-allow is equivalent to trust mode; use only when fully trusted.
- **Shell sandbox (macOS)**: agent shell commands run in a workspace-write sandbox; writes are limited to the workspace, temp dirs and `~/.x-code/skill-runtime`, sensitive paths are unreadable, and the network is off by default. The built-in terminal is not sandboxed; Hooks and stdio MCP can opt in. Terminal tabs start as login shells, and the agent refreshes PATH from your login shell before each turn (cached for 30s), so tools installed in another terminal usually need no app restart. A non-zero exit (no `grep` match, `command -v` miss) is shown as a normal result; only spawn failures, timeouts, signals or sandbox denials are tool failures. Adjust sandbox options in Settings → Tools if a command needs network or writes outside the workspace.
- **Project trust**: project hooks and project MCP servers do not run before trust; plugin installs have their own consent preview.
- **Secrets**: provider API keys use OS secure storage or a `0600` file and never cross into the renderer. ChatGPT tokens are a plaintext file; protect `~/.x-code/auth/`.
- **Web search**: `webSearch` needs a search-service key (Tavily's free tier is recommended). Configure it in Settings → Tools → Search service. Without a key the model cannot search the web and is told how to configure one; `webFetch` still fetches pages directly. Search keys are stored separately from model keys and stay on this device. With several services configured, pick one under "Preferred search service"; "Test connection" verifies a key before you rely on it.
- **Third-party skills**: skill content becomes model context. Verify the source before installing; the marketplace copies files but does not execute skill scripts.

## Automation and Extensions

- **Task modes**: coding / writing / research / office adjust what answers emphasize, not the available tools. Empty-state suggestions come from the current workspace.
- **Plan mode**: `/plan` enters read-only exploration; the agent proposes a plan and writes after approval.
- **Goal loops**: `/goal` runs execute → verify → repair until passing or a stop condition is reached.
- **Background tasks**: long shell commands can be inspected and stopped in the background task panel. The panel shows elapsed time, output size and a progress bar (a real percentage when the command prints one, an activity animation otherwise); the Tools menu shows the running count. Press Enter while a turn is running to queue a prompt; Stop ends the current reply but leaves backgrounded tasks running.
- **Browser sub-agent**: enable in Settings → Tools; `task` can then delegate clicking, typing and sign-in. First use launches a managed Chrome through `npx @playwright/mcp`.
- **Automatic visual checks**: the root agent can take one localhost screenshot after a significant visual change; independent from the browser sub-agent.
- **Memory**: manage user memory in Settings → Memory; project knowledge comes from layered `AGENTS.md` / `AGENTS.local.md` files.

## Settings Reference

- **Models and keys**: providers, keys, base URLs, custom models, connection tests, context limits.
- **Project**: model / task mode / automatic-check overrides for the current workspace.
- **Skills**: import, install command, enablement, rescan and environment refresh.
- **Skill marketplace**: SkillHub / SkillsMP search and install, MCP registration.
- **Commands**: user and project slash commands.
- **Hooks**: lifecycle scripts and project trust.
- **Memory**: view, edit and delete memory topics.
- **MCP**: add, authenticate, enable and remove servers.
- **Plugins / Plugin marketplace**: install, configure and uninstall.
- **Tools**: enablement, always-allow, tool profile, shell sandbox, browser sub-agent, search service (Tavily / Brave / Exa web-search keys, preferred provider and connection test), diagnostics.
- **Permissions**: persisted allow rules.
- **Document library**: local index, semantic search toggle, rebuild and clear.
- **Storage**: usage, cleanup, backup and restore.

## Shortcuts and Command Palette

![Command palette](shot:palette)

- `Cmd/Ctrl+K`: command palette for actions, sessions, files and slash commands, with synonyms (screenshot, worktree, skill market, etc.).
- `Cmd/Ctrl+N` / `Cmd/Ctrl+T`: new session / tab.
- `Cmd/Ctrl+Shift+N`: new window.
- `Cmd/Ctrl+Shift+F`: search sessions.
- `Cmd/Ctrl+F`: find in the current session.
- `Cmd/Ctrl+,`: open settings.
- `Cmd/Ctrl+Shift+D`: document panel.
- `Cmd/Ctrl+=` / `-` / `0`: zoom in / out / reset.
- `?`: shortcut sheet (not while typing in an input).
- `Esc`: close overlays, the Inspector and menus.

Typing `/` lists every command; `/help` shows the full list. Common commands include `/model`, `/settings`, `/doc`, `/git`, `/checks`, `/terminal`, `/rewind`, `/fork`, `/export`, `/compact`, `/context`, `/usage`, `/doctor`, `/init`, `/review`, `/plan`, `/goal` and `/manual`.

## Data, Backup and Updates

- **Location**: sessions, skills, plugins, memory, MCP and settings live in `~/.x-code` (override with `X_CODE_HOME`), shared with the CLI.
- **Storage panel**: usage for sessions, attachments, library and voice models; cleanup keeps the current and pinned sessions.
- **Backup**: Settings → Storage → Export backup. Sessions, skills, commands, memory and sub-agents; secrets, plugins, attachments and logs are excluded.
- **Restore**: adds missing files only and never overwrites; skills/commands/sub-agents reload immediately and the session list refreshes.
- **Diagnostics**: Settings → Tools → Diagnostics and support, or the palette. The JSON snapshot excludes keys, MCP env/headers and command contents.
- **Error log**: renderer errors append to `~/.x-code/logs/desktop-errors.log`; a render crash shows a recovery screen with reload and diagnostics export.
- **Updates**: Settings → Desktop updates. Checks the official GitHub Release `RELEASE.json` by default; you can also paste the HTTPS URL of your own release directory, then download and verify the installer (sha256) before installing manually. Automatic install still requires a signed app.

## Troubleshooting

- **Still on the demo model**: no API key was detected. Configure and test one in Settings → Models and keys, or check `X_CODE_HOME/.env`.
- **Maximum context error**: lower the per-model context limit or run `/compact`.
- **MCP connection failure**: check the command/URL, network and auth state; stdio servers need a local command. Project servers require trust.
- **Skill install failure**: check network/proxy; SkillsMP needs GitHub access. macOS reuses the system proxy; elsewhere set `HTTPS_PROXY`.
- **Constant permission prompts**: add a rule in Settings → Permissions or enable always-allow for that tool; destructive commands still prompt.
- **Blank document or no text**: scanned PDFs need OCR; click OCR in the document panel or ask the agent to use `readDocument`.
- **Terminal will not start**: confirm the runtime is connected; the terminal uses a PTY and reports failures at the top.
- **Blank window**: use the crash recovery screen to reload and export diagnostics; the log is `~/.x-code/logs/desktop-errors.log`.
- **Gatekeeper blocks the app**: the unsigned community build shows "cannot verify
  the developer" on first launch. On macOS 15+, dismiss the prompt, open
  **System Settings → Privacy & Security → Security → Open Anyway**, authenticate,
  then launch again. If macOS says the app is damaged, verify `SHA256SUMS` first,
  then run `xattr -dr com.apple.quarantine /Applications/X-Code.app`. Full steps:
  `docs/desktop-install-unsigned.en.md`.

## Known Limitations

- Windows/Linux installers are configured in CI but have not been accepted on real devices.
- macOS signing, notarization and automatic install updates require Apple credentials.
- The real-LLM E2E suite needs provider credentials and is not in the default release gate.
- Desktop peer messaging is not enabled.
- Task modes only affect answer emphasis; they do not change the tool set.
- Closing a window does not automatically delete its worktree, to avoid losing uncommitted work.

## Data and Privacy

- No telemetry by default; document parsing, OCR, voice transcription and the library run locally.
- Only the conversation, selected attachments and tool output are sent to the active model provider.
- API keys never enter the renderer; logs and diagnostics exclude keys, MCP env/headers and command contents.
- Third-party skills, plugins and MCP servers are user-selected and trusted by the user; review the source and consent previews before installing.
