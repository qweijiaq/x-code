# X-Code Desktop

> The complete feature-by-feature guide, screenshots and troubleshooting steps
> live in the [user manual](./desktop-manual.en.md). The **?** button in the
> app's top bar opens the same manual. The community build is unsigned; see the
> [unsigned install guide](./desktop-install-unsigned.en.md).

X-Code Desktop is the graphical front end for the same agent runtime: models,
tools, sessions, memory, plugins, MCP servers, skills, and hooks all share
`~/.x-code` (or `X_CODE_HOME`) with the CLI. The desktop app does not change
agent semantics; it turns terminal interactions into windows, forms, and
clickable cards.

## Run and install

```bash
pnpm install
pnpm dev:desktop            # build every package, then start from dist
```

Local macOS package (unsigned):

```bash
pnpm release:desktop --arch arm64
# packages/desktop/release/X-Code-<version>-arm64.dmg / .zip
```

`pnpm --filter @x-code-cli/desktop package:dir` produces an unpacked app for
inspecting `app.asar.unpacked`. Signing, notarization and the Windows/Linux CI
builds are covered in
[`development/desktop-release.md`](./development/desktop-release.md).

The first launch shows onboarding. Enter provider keys in **Settings → Models
& keys**; keys are encrypted with the macOS Keychain / Electron `safeStorage`
when available, otherwise a `0600` plaintext file is used and the UI says so.

## Sessions and windows

- Every window owns its runtime; `Cmd/Ctrl+T` opens a session tab and
  `Cmd/Ctrl+Shift+N` a new window.
- The sidebar searches, renames, pins, archives and exports sessions to
  Markdown / JSON / PDF.
- The sidebar's **Getting started** card surfaces five frequent capabilities
  (attach, screenshot, document panel, command palette, skill marketplace),
  checks them off as you use them, and can be dismissed; its state stays local.
- Window position, open tabs and per-window workspace are restored on launch.
- Transcripts are JSONL. If an interrupted write leaves a chain that fails
  integrity checks, loading offers **salvage**: parseable messages move to a
  clean session and the original file is left untouched.
- A transcript can be open in only one window at a time; moving a session to a
  new window closes the source tab.

## Branches and worktrees

The Git branch menu can:

- switch the current checkout;
- open an existing branch (including `origin/*` remote refs) in its own window,
  creating a local tracking branch and `git worktree` when needed;
- create a new branch with a chosen parent directory;
- remove a worktree (an extra confirmation when it has uncommitted changes) and
  prune stale worktrees.

Worktree windows have their own workspace path and `.x-code/sessions`; they do
not overwrite the global recent-project entry.

## Right-hand inspector

Documents, Git, project checks, the terminal and the file browser share one
right-hand inspector: switch with the tabs, drag its left edge to resize, and
close it with `×` or `Esc` to give the chat the full width. These views no
longer open as scrim-backed drawers, so you can read a document, diff or
terminal while continuing the conversation.

## Composer

- Markdown editing and preview, `@` file references, slash-command palette and
  the `Cmd+K` command palette. Typing `/` lists **every** command in a scrollable
  list; arrow keys select and keep the active row visible. The palette matches synonyms too (screenshot,
  worktree, skill market, permission rules); the "All capabilities" link below
  the composer opens the same palette.
- Paste or drop images, or capture a screen region from the capture menu. Images
  show thumbnails, live under `~/.x-code/attachments`, and are restored when a
  historical session is reopened.
- Large documents, PDFs, Word and Excel files open in the document panel;
  PDFs support page rendering, OCR and the extracted text view. The document
  icon beside the composer or `Cmd/Ctrl+Shift+D` reopens the workspace's last
  document, recent documents stay as tabs at the top, and `Esc` closes it.
- Voice input uses local Whisper and never uploads audio; the model may be
  downloaded on first use.
- Each turn's tool calls collapse individually or as a group; user messages and
  answers can be copied.
- Drafts survive session switches; edit-and-resend, regenerate and queued
  messages are supported.
- The empty state recommends workspace-aware next steps: uncommitted changes,
  runnable project checks, a recent document, spreadsheets, or the README. When
  nothing can be inferred it falls back to the task-mode hint.
- The task mode in the top bar (coding / writing / research / office) only
  changes what the answer emphasizes; it never removes tools. The menu spells
  out each mode's focus.

## Context and models

- The composer footer shows used / limit tokens and a percentage. The limit comes
  from the model table, the provider fallback or an override, and compression
  starts at 80%.
- **Settings → Models & keys** sets a per-model context ceiling (at least 32768
  tokens). The override applies to that model only; switch models to configure
  others.
- The model menu searches, groups local models (Ollama / LM Studio) separately,
  and shows each model's ceiling.
- ChatGPT sign-in, API keys, OpenAI-compatible endpoints and custom model IDs
  are supported.

## Permissions and security

- Three-level permissions: always allow / ask / deny. Destructive shell
  commands, path checks and plan mode are evaluated before allow rules.
- **Settings → Permissions** lists the project's persisted "don't ask again"
  rules and lets you delete or add them. Shell supports prefix, exact and
  whole-tool rules; other tools are whole-tool only. Rules load at runtime start
  and survive restarts.
- **Settings → Tools → Shell sandbox** (macOS) runs agent shell commands in a
  workspace-write sandbox: writes are limited to the workspace and temp
  directories, sensitive paths are unreadable, and the network is off by default.
  The built-in terminal is not sandboxed. Hooks and stdio MCP can opt in.
- Project-level hooks do not run until the project is trusted; plugin installs
  show a consent preview.
- The renderer is sandboxed with `contextIsolation`; preload exposes an explicit
  method allowlist and API keys never cross into the renderer.

## Settings and other features

- Light/dark themes and Chinese/English switch instantly and sync across windows.
- The Git panel shows changes, diffs and per-turn undo; the project-check panel
  runs detected checks and offers fixes.
- Built-in terminal, file tree and a light editor; diff cards open VS Code or
  Cursor at the changed line.
- Background shell sessions, system notifications, zoom, tray and global shortcut.
- **Settings → Tools** enables the browser sub-agent (a managed Chrome launched
  through `npx @playwright/mcp`) and the independent automatic visual checks.
- The document library indexes PDF / Word / Excel / Markdown locally with
  keyword and optional semantic search.
- The storage panel reports session, attachment, library and voice-model usage
  and offers cleanup.
- **Settings → Tools → Diagnostics and support** exports a JSON snapshot
  (version, model, MCP status, tool/skill counts, sandbox settings) without
  API keys, MCP env/headers or command contents. A render failure shows a
  recovery screen (reload, copy error, export diagnostics); errors are
  appended to `~/.x-code/logs/desktop-errors.log`.

## Skill marketplace

**Settings → Skill marketplace** embeds two catalogs and installs the same way
as the plugin marketplace: files land in `~/.x-code/skills/<name>` and apply
from the next turn after the skill registry reloads.

- **SkillHub** (China-first): search and download use `api.skillhub.cn` and
  need no login. Installs download a zip, validate paths, file count, extracted
  size and symlinks, require a `SKILL.md`, then copy it into the user skill
  directory. Searches are cached for five minutes.
- **SkillsMP**: a read-only community catalog (3M+ skills sourced from GitHub).
  Anonymous search has a small hourly allowance; set `SKILLSMP_API_KEY` to use
  an account allowance. Installs shallow-clone the `github.com` repository
  linked by the result. On macOS the system proxy is detected and passed to
  `git`; elsewhere set `HTTPS_PROXY` / `HTTP_PROXY`.
- On the SkillsMP side, **Register as MCP server** writes
  `https://skillsmp.com/mcp` into the user MCP config
  (`~/.x-code/config.json`). Registration reloads MCP and invalidates the prompt
  cache immediately, so the agent can call `search_skills`, `get_skill` and
  `list_categories` without a restart. If a different `skillsmp` entry already
  exists, the marketplace reports a conflict instead of overwriting it.

Third-party skills become model context, so check that a source is trustworthy
before installing. The marketplace only searches and copies files; it does not
execute any script from a skill.

## Updates

**Settings → Desktop updates** checks the official GitHub Release
`RELEASE.json` by default; you can also paste the HTTPS URL of your own release
directory. If the release lists an installer for this platform, the app can
download it to a temp directory, verify its `sha256`, and open the installer
for a manual install. Automatic download-and-install is not enabled yet: it
needs a signed app and a stable feed.
