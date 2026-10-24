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
- Sidebar search also performs **full-text search across transcripts** and shows
  snippets from other sessions.

## Branches and worktrees

- The branch button next to **项目** (also "在新窗口打开分支" in the palette)
  lists the repository's local branches. Choose one to open it in its own
  window.
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

The model menu has a search box and groups **Local models** (Ollama / LM Studio)
separately from cloud/built-in models.

Per-project overrides (model, task mode, automatic checks) apply whenever that
workspace is active; clearing them restores the global defaults.

Project-level `hooks.json` is **not executed until the workspace is trusted**
in Settings → Hooks; user-level hooks always run.

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

- `Cmd+V` pastes screenshots, drag & drop adds files.
- The camera button offers **框选区域** (native macOS region selection; the app
  window hides while you drag) and **整个屏幕**. macOS asks for Screen
  Recording permission the first time.
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
- The context meter in the composer footer shows current context usage; amber
  at 65%, red at 85%.
- A ↓ button appears when you scroll up, and streaming no longer forces the
  chat back to the bottom.
