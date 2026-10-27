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
- **Pin / archive / rename / delete**: the **⋯** menu on each session row (fewer misclicks); delete asks for confirmation. Archived sessions are available under "Show archived".
- **Session titles**: after the first completed turn the active model generates a very short title (one small request); tabs and the sidebar prefer it. A manual rename always wins, and a failed generation falls back to the first prompt.
- **Export**: session menu to Markdown, JSON or PDF.
- **Edit and resend**: edit a user message to rewrite the previous turn. File changes from that turn remain and can be reverted from the diff.
- **Regenerate**: regenerate the last answer; turns with attachments must be edited to text first.
- **Rewind**: `/rewind` or the palette; choose code only, conversation only, or both.
- **Fork**: `/fork` copies the current session into an independent conversation.
- **Keep working while busy**: pressing Enter during a reply queues the prompt. A text-only queued item offers **Open in new window**, which forks the last saved session, prepends a hidden fork-time status snapshot of the parent (current turn, partial reply, background shells/sub-agents, changed files), and submits the question there while the original reply keeps running. The new window can answer "where was it at fork time", and it also sees live background shell/sub-agent status from all windows through the shared view; it cannot see the parent's in-flight model reasoning. Prompts with attachments do not offer this action yet.
- **Recover a damaged session**: when transcript integrity fails, the app offers to salvage parseable messages into a new session without modifying the original file.

## Conversation outline

The **Outline** tab in the right-hand inspector (also the top-bar outline button and the Tools menu) lists every question and answer in the current conversation; click one to jump there. A jump pauses auto-follow; the **↓** button near the composer resumes it.

## Composer, Attachments and Voice

- **Markdown**: bold, italic, code, headings, lists, quotes and preview; `Cmd/Ctrl+B/I/E` format shortcuts.
- **@ references**: type `@` to search workspace files and insert a path reference.
- **Attachments**: use the paperclip, drag files into the window, or paste images.
- **Images**: thumbnails are stored under `~/.x-code/attachments` and restored when a historical session is reopened.
- **Screenshots**: select a region or the entire screen; the image becomes an attachment.
- **Workspace check**: when a message references an absolute path outside the current workspace (`/Users/...`, `~/...`, `/Volumes/...`, or a Windows drive), X-Code asks before sending. You can continue, cancel and switch projects from the sidebar, or disable the warning for this session. Paths inside the workspace, URLs, and system paths such as `/usr` or `/tmp` are ignored.
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

## Files and temporary output

- Files the agent creates for you to keep — reports, transcripts, exported documents, generated images/audio/video — go into the **current workspace**; relative paths resolve from the workspace root.
- `/tmp` is for disposable intermediates only (audio chunks, conversion staging) and should be cleaned up when the task ends. If a tool writes into the system temp directory, its result includes an `[Output location]` reminder so the agent moves the deliverable into the workspace.
- The tool card also shows **Deliverables were written to the system temp directory** with a **Move to workspace** button. Once the current reply finishes, click it to copy the file into the workspace and remove the temp source. Existing files are never overwritten; a `(1)` suffix is added when the name is taken.
- Skill dependencies and managed runtimes live in `~/.x-code/skill-runtime`; marketplace skills live in `~/.x-code/skills`. Neither is written into the workspace. Legacy `runtime/` or `venv/` folders inside a project skill can be cleared from Settings → Skills.
- To deliberately put an output outside the workspace (for example `~/Documents`), give the target path in your prompt; the agent writes exactly there.

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
- **Shell sandbox (macOS)**: agent shell commands run in a workspace-write sandbox; writes are limited to the workspace, temp dirs and `~/.x-code/skill-runtime`, sensitive paths are unreadable, and the network is off by default. Secret-looking environment variables are stripped. The built-in terminal is not sandboxed; Hooks and stdio MCP can opt in. Terminal tabs start as login shells with a forced UTF-8 locale (`LANG`/`LC_CTYPE` are set to `en_US.UTF-8` when missing or `C`), so Chinese input and filenames render correctly. The agent refreshes PATH from your login shell before each turn (cached for 30s), so tools installed in another terminal usually need no app restart. A non-zero exit (no `grep` match, `command -v` miss) is shown as a normal result; only spawn failures, timeouts, signals or sandbox denials are tool failures.
- **Sandbox status is always visible**: when the sandbox is on and network is off, the composer footer shows a **Sandbox · network off** chip that opens Settings. A failed network command adds an explanation with **Allow network** and **Sandbox settings** actions under the tool card; Settings → Tools also shows a banner with a one-click allow. Commands that need credentials or network can be run in the right-hand terminal instead. A blocked write explains that the sandbox only permits the workspace and temp directories. If a command reports `command not found` right after you installed it in another terminal, use **Refresh environment** on the tool card instead of restarting the app.
- **Project trust**: project hooks and project MCP servers do not run before trust; plugin installs have their own consent preview.
- **Secrets**: provider API keys use OS secure storage or a `0600` file and never cross into the renderer. ChatGPT tokens are a plaintext file; protect `~/.x-code/auth/`.
- **Web search**: `webSearch` needs a search-service key (Tavily's free tier is recommended). Configure it in Settings → Tools → Search service. Without a key the model cannot search the web and is told how to configure one; `webFetch` still fetches pages directly. Search keys are stored separately from model keys and stay on this device. With several services configured, pick one under "Preferred search service"; "Test connection" verifies a key before you rely on it.
- **Third-party skills**: skill content becomes model context. Verify the source before installing; the marketplace copies files but does not execute skill scripts.

## Automation and Extensions

- **Task modes**: coding / writing / research / office adjust what answers emphasize, not the available tools. Empty-state suggestions come from the current workspace.
- **Plan mode**: `/plan` enters read-only exploration; the agent proposes a plan and writes after approval.
- **Goal loops**: `/goal` runs execute → verify → repair until passing or a stop condition is reached.
- **Background shells**: a command that outlives its initial wait moves to the background task panel. If the model makes one default passive status check and it is still running, the current reply ends automatically and the composer becomes usable. The composer shows the running count and a **View** entry; the panel shows elapsed time, output size, a progress bar and a stop action (a real percentage when the command prints one, an activity animation otherwise).
- **Background sub-agents**: for long independent investigation, review or organizing, the agent can dispatch `task` with `background: true`; the call returns a task id immediately. The sub-agent runs in its own context, and the panel shows status, duration, tool-call count, result and a stop action, with a system notification on completion. Ask "where is it now" and the model can call `backgroundList`, `backgroundGet` or `backgroundOutput` to read status and the output tail; `backgroundOutput` returns immediately by default and waits only with `block: true`. A summary of running background tasks is also injected into the model context at the start of each turn. The full result is not merged automatically; open the panel or let the model query it.
- **Open in a new window**: pressing Enter while a reply is running queues the prompt. A text-only queued item offers **Open in new window**, which forks the last saved session, prepends a hidden fork-time snapshot of the parent (current turn, partial reply, background tasks, changed files) and submits the prompt in a new window while the original reply keeps running. The snapshot is a point-in-time view; the new window also sees all windows' background shells/sub-agent tasks through the shared main-process view (about 2 seconds refresh), so you can ask the model "where are the background tasks now". It still cannot see the parent's in-flight model reasoning. If the reply is still waiting on a background task, a banner offers **Stop waiting** (or **Stop waiting and run queued**); it ends only the current reply and leaves the background task running.
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
- **Background task state**: background shell/sub-agent progress is process-local, and the cross-window shared view exists only while the app runs; neither is included in backups. Output already written to the session transcript is saved with the session.
- **Updates**: Settings → Desktop updates. Checks the official GitHub Release `RELEASE.json` by default (using the system proxy); you can also paste the HTTPS URL of your own release directory. Downloads show bytes, speed, percentage and a progress bar, and can be cancelled. The installer goes to the system Downloads folder by default; **Choose location** opens a save dialog, and the final path plus **Show in Finder** appear after the SHA-256 check. Automatic installation still requires a signed app.

## Troubleshooting

- **Still on the demo model**: no API key was detected. Configure and test one in Settings → Models and keys, or check `X_CODE_HOME/.env`.
- **Maximum context error**: lower the per-model context limit or run `/compact`.
- **MCP connection failure**: check the command/URL, network and auth state; stdio servers need a local command. Project servers require trust.
- **Skill install failure**: check network/proxy; SkillsMP needs GitHub access. macOS reuses the system proxy; elsewhere set `HTTPS_PROXY`.
- **Constant permission prompts**: add a rule in Settings → Permissions or enable always-allow for that tool; destructive commands still prompt.
- **Blank document or no text**: scanned PDFs need OCR; click OCR in the document panel or ask the agent to use `readDocument`.
- **A background task seems to have no result**: ask the agent "where are the background tasks now"; it can call `backgroundList` / `backgroundGet` / `backgroundOutput`, or open the Background tasks panel directly. Cross-window status refreshes about every 2 seconds, but the parent's in-flight model reasoning is not shared. Unfinished background tasks are lost when the app quits, while output already written to the transcript remains.
- **Open in new window is missing or fails**: the action only appears for text-only queued prompts. It needs a saved session, and a failed transcript-integrity check blocks the fork. For a prompt with attachments, remove it from the queue and send it normally.
- **Terminal shows garbled Chinese**: the built-in terminal forces a UTF-8 locale; if your environment sets `LANG`/`LC_CTYPE` to `C` or empty, the app switches it to `en_US.UTF-8`. If it still looks wrong, confirm the command itself emits UTF-8 (`file`, `locale`) and reopen the terminal tab.
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
- The real-LLM E2E suite needs provider credentials; its 26 scenarios now pass on `deepseek-flash`, but it is still not part of the default CI/release gate.
- Background sub-agent results appear in the panel and tool card; they are not merged into the main conversation's model context automatically.
- **Open in new window** includes a fork-time status snapshot and a shared view of background shells/sub-agents from every window (about 2 seconds refresh); it still cannot see the parent's in-flight model reasoning. Queued prompts with attachments are not supported yet.
- The new and original windows share the same workspace. This is not two parallel turns in one session; editing the same files in both can still conflict, so use a worktree when coding work overlaps.
- Background shell/sub-agent state lives in the current app process. It is not restored after quitting; output already written to the transcript remains.
- Desktop peer messaging is not enabled.
- Task modes only affect answer emphasis; they do not change the tool set.
- Closing a window does not automatically delete its worktree, to avoid losing uncommitted work.

## Data and Privacy

- No telemetry by default; document parsing, OCR, voice transcription and the library run locally.
- Only the conversation, selected attachments and tool output are sent to the active model provider.
- API keys never enter the renderer; logs and diagnostics exclude keys, MCP env/headers and command contents.
- Third-party skills, plugins and MCP servers are user-selected and trusted by the user; review the source and consent previews before installing.
