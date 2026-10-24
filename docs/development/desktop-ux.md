# Desktop UX quick reference

## Keyboard

| Keys                     | Action                                               |
| ------------------------ | ---------------------------------------------------- |
| `Cmd/Ctrl+K`             | Command palette (commands, sessions, files, actions) |
| `Cmd/Ctrl+N`             | New session                                          |
| `Cmd/Ctrl+T`             | New tab                                              |
| `Cmd/Ctrl+Shift+N`       | New window                                           |
| `Cmd/Ctrl+Shift+F`       | Focus session search                                 |
| `Cmd/Ctrl+F`             | Find inside the current conversation                 |
| `Cmd/Ctrl+,`             | Settings                                             |
| `Cmd/Ctrl+=` / `-` / `0` | Zoom in / out / reset                                |
| `?`                      | Shortcut sheet (not while typing)                    |
| `Esc`                    | Close overlay / find bar                             |
| `Enter` / `Shift+Enter`  | Send / newline                                       |

## Session continuity

- The composer keeps a **separate draft per session**; drafts survive switching
  sessions and restarting the app.
- The app reopens the **last session** on launch.
- Hover the last user message → **编辑并重发** rewrites that turn (files are kept).
- Hover the last assistant message → **重新生成**.
- Messages queued while a turn is running are listed above the composer and can
  be removed individually.

## Sessions

- The tab bar keeps several sessions open in one window. `＋` opens a new tab.
  `⧉` **moves** the current saved session to a new window and closes its tab
  here (blocked while a reply is running, and unavailable for an unsaved tab).
  `Cmd/Ctrl+T` / `Cmd/Ctrl+Shift+N` create a tab / window; closing the active
  tab falls back to the previous tab, and closing the last tab starts a fresh
  session.
- Empty tabs (no message sent yet) can be switched back to before they are
  written to disk.
- Each window has its own runtime, so sessions in different windows run
  independently. A new window opens on a blank session unless a session path is
  passed in the URL.
- A session file is owned by one window at a time. Opening it from another
  window is refused, so two runtimes never write the same transcript.
- If a session fails its transcript integrity check, opening it offers
  **尝试修复**. Readable messages are copied into a new **恢复：…** session with a
  clean transcript; the damaged source file is left untouched.
- Sidebar search also performs **full-text search across transcripts** and shows
  snippets from other sessions.

## Branches and worktrees

- The branch button next to **项目** (also "在新窗口打开分支" in the palette)
  lists the repository's local branches. Choose one to open it in its own
  window.
- The branch picker can create a new branch from the current HEAD and open it in
  a fresh worktree. Remote-tracking branches are listed with a **远端** badge;
  choosing one creates/reuses the matching local branch before opening it.
- A branch that is not checked out anywhere gets a new Git worktree in a sibling
  folder (`<repo>-<branch>`; `/` in branch names becomes `-`). An existing
  worktree is reused, and selecting a workspace that already has a window
  focuses that window instead of opening a duplicate.
- A window opened on an explicit workspace keeps that workspace for its own
  sessions and does not change the workspace used by the next fresh launch.
  Each worktree has its own `.x-code/sessions`, so conversations stay separated
  by branch. Explicitly bound windows are reopened on the next launch (missing
  directories are skipped).
- A worktree with a worktree row can be removed from the branch picker. Dirty
  worktrees require **强制移除** (discarding changes); the main checkout and the
  window's own workspace are protected, and locked worktrees must be unlocked
  with Git first. Removing a worktree never deletes the branch.
  **清理失效 worktree** drops records whose directory was deleted manually.
- Only local branches are listed; create a branch with Git first if you need one
  that exists only on the remote.
- Every session row has pin / archive / rename / delete actions; archived
  sessions are hidden unless "显示归档" is on.
- `/export` (default Markdown) or the palette exports the current session as
  Markdown, JSON or PDF to `~/Downloads`.

## Settings deep links

The command palette opens settings directly on the relevant tab: project
settings, memory, storage, hooks, commands.

Settings that are shared across windows (keys, tools, skills, plugins, hooks,
commands, memory and project overrides) are reloaded in the other windows after
a change; theme and language follow through shared storage.

The model menu has a search box, groups **Local models** (Ollama / LM Studio)
separately from cloud/built-in models, and shows each model's context ceiling.
Switching models updates the ceiling but keeps the last request's usage reading.

Per-project overrides (model, task mode, automatic checks) apply whenever that
workspace is active; clearing them restores the global defaults.

Project-level `hooks.json` is **not executed until the workspace is trusted**
in Settings → Hooks; user-level hooks always run.

## Permissions

**Settings → 权限** lists the "don't ask again" rules persisted in
`.x-code/local/permissions.json` for the current project. Each rule shows its
tool and match shape (`shell:git commit:*`, `shell:=rm build.log`,
`writeFile:*`); **删除** removes it from disk and from the running session so
the next call asks again. Rules can also be added manually: shell supports
prefix, exact and whole-tool rules (shell rules are bound to the current
workspace), while other tools are whole-tool only.

Allow rules only skip **ask-level** prompts. Destructive shell commands,
deny-level classifications, path checks and plan mode are evaluated before
rules and cannot be bypassed from this screen. Rules are loaded at runtime
start, so "don't ask again" approvals survive restarts; changes made in one
window reload the other windows' rule sets.

## Editor integration

- Click the **file path on a diff card** (chat, Git panel) to open VS Code or
  Cursor at the first changed line. The CLI is launched with `--goto`, so the
  editor starts if it is not already running.
- The file browser has an "在编辑器打开" action, and the palette can open the
  whole workspace in the editor or reveal it in Finder. Inside the file
  editor, `Cmd/Ctrl+Shift+E` opens the current file in the editor.
- The editor shows line numbers and a status bar with language, `Ln/Col`,
  selection length and total lines.
- Detection order: `X_CODE_EDITOR` → `code` → `cursor` → `windsurf` → the
  macOS app bundles for VS Code / Cursor.

## Input

- The composer has a **MD** toolbar (bold, italic, inline code, code block, link,
  list, quote) with a live Markdown preview. `Cmd/Ctrl+B` / `I` / `E` apply bold /
  italic / inline code in the textarea. Sent user messages render Markdown too.
- Each user turn that used tools shows a compact `工具调用 N 次` row before its
  first tool card. Its **收起 / 展开** button collapses every tool card in that
  turn only; each tool's result still keeps its own details toggle. Failures are
  counted in the row, and individual turns are independent.
- User messages render Markdown after sending and have a **复制** action, alongside
  the existing assistant copy/regenerate actions.
- The agent replies in the language of the latest user message: Chinese input
  (including mixed Chinese/English) gets a Chinese reply instead of switching to
  English because the code or tool output is English.
- `Cmd+V` pastes screenshots, drag & drop adds files. Image attachments show a
  thumbnail in the composer and in the sent user message; click either thumbnail
  to open a full-size preview. Non-image attachments show a file chip. Reopening
  a session restores image/file attachment cards from the stored model message
  (or from the original path when the model used OCR); internal attachment tags,
  paths, and OCR notes stay hidden.
- The camera button offers **框选区域** (native macOS region selection; the app
  window stays visible so you can capture part of the project) and **整个屏幕**.
  macOS asks for Screen Recording permission the first time.
- The microphone button opens a recording bar with elapsed time, an input-level
  meter, **取消** (discard) and **完成并转写**. Audio is recorded as mono 16-bit
  WAV and transcribed locally with Whisper. Released builds bundle the model;
  no audio leaves the machine.
  - Development builds without the bundled asset fall back to a cached copy in
    `~/.x-code/whisper-models/`, then download it (Hugging Face, then
    `hf-mirror.com`).
  - Overrides: `X_CODE_WHISPER_MIRROR`, `X_CODE_WHISPER_MODEL_URL`, and
    `X_CODE_WHISPER_MODEL_PATH` (use a manually downloaded model file).

## Reading

- Web tool results show clickable **source chips**.
- Code blocks can toggle wrapping and copy.
- HTML / SVG / Markdown files opened in the file browser have a live **预览**
  toggle (HTML runs sandboxed without scripts).
- The context meter in the composer footer shows **used / max tokens** and the
  percentage for the active model. The ceiling comes from the model table with
  a provider fallback (128k default) or a config `contextWindow` override;
  automatic compression starts at 80% of that ceiling. Switching models keeps
  the last usage value and replaces only the ceiling.
- Settings → 模型与密钥 → **上下文窗口** sets a per-model ceiling (minimum
  32768 tokens) for the active model. Per-model overrides beat the global
  `contextWindow` setting and are stored in desktop settings as
  `contextWindowOverrides`; **恢复默认** removes the override for that model
  only. This is useful for OpenAI-compatible endpoints whose real limit is
  smaller or larger than the provider fallback.
- A ↓ button appears when you scroll up, and streaming no longer forces the
  chat back to the bottom.
