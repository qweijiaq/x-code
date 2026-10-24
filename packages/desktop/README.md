# @x-code-cli/desktop

Electron host for X-Code. Phase 1 MVP: `@x-code-cli/core` runs in an Electron `utilityProcess`; a sandboxed
renderer talks to it over typed IPC. Provider resolution, sessions, approvals, tool cards/diffs, and the PTY
terminal are wired end to end.

## Build and run

Build core first (the runtime bundles `packages/core/dist`):

```bash
pnpm --filter @x-code-cli/core build
pnpm --filter @x-code-cli/desktop build
pnpm --filter @x-code-cli/desktop start
```

Packaged-directory build:

```bash
pnpm --filter @x-code-cli/desktop package:dir
```

Headless smoke (runtime modules, PTY, fake-provider agent stream):

```bash
pnpm --filter @x-code-cli/desktop smoke
# packaged:
./release/mac-arm64/X-Code.app/Contents/MacOS/X-Code --smoke-test
```

Smoke prints one `SMOKE_RESULT {json}` line and exits non-zero if any probe fails.

## Phase 1 MVP

- Ink-wash theme: paper and ink as the base, with traditional pigment accents (cinnabar, dai purple, indigo,
  mineral green, ochre, rouge, sky blue, gamboge).
- Real providers come from the core registry (env vars or the nearest `.env`; ChatGPT auth context included).
  The model picker persists the choice through `saveUserConfig`. With no key, a demo model keeps the app usable.
- Demo model: prompts containing `[tool-demo]` emit a `writeFile` call so the write → permission → diff path can
  be exercised without credentials.
- Sessions: list, resume, and new. Sessions use the same `.x-code` layout as the CLI and are written after every
  turn; a session saved here loads in the CLI.
- Approvals: permission (allow once / always / deny), authority, ask-user, and plan approval dialogs. Pending
  approvals resolve to denial when the window closes or the renderer crashes.
- Transcript: tool cards, structured diffs, todos, usage, queued input, and abort.
- Terminal panel backed by `node-pty` in the runtime process. It opens as a right-side drawer and is
  **collapsed by default**; use the `终端` button, then close with `关闭`, the scrim, or Escape.
  `X_CODE_OPEN_TERMINAL=1 pnpm start` opens it at launch for inspection.
- `诊断` runs the same probe set as `--smoke-test` and displays the JSON without exiting the app.

Not in this MVP: live MCP OAuth acceptance, file/image attachments, the slash
command palette, fork/rewind, peers, and Windows/Linux acceptance. See
[`docs/development/desktop-plan.md`](../../docs/development/desktop-plan.md).

`pnpm smoke:ui` runs the renderer end to end against the demo model: streaming, permission approval and denial
(with diff on the approved path), automatic context compaction and retry (`[compact-demo]`), session save/resume,
settings (snapshot, drawer, marketplace tab, tool toggle/restore, per-tool and global always-allow), PTY,
diagnostics, and the terminal toggle.

## Settings

`设置` opens a drawer with seven tabs:

- **模型与密钥**: configure provider API keys. Keys are encrypted with Electron `safeStorage` (OS keychain) and
  stored in `~/.x-code/desktop-secrets.json` with mode `0600`, then injected into the runtime environment before
  provider discovery; the renderer only receives a `••••1234` hint. Where safeStorage is unavailable (e.g. Linux
  without a secret service) values fall back to plaintext `0600` and the tab says so; legacy plaintext entries are
  migrated to ciphertext on the next launch. Clearing a stored key restores any environment value that existed before
  the app started. The always-visible
  `custom` row accepts an OpenAI-compatible **model ID**, Base URL, and API key; saving it activates that model.
  The model menu also has a custom model ID field for any `provider:model` id. `测试连接` sends one minimal streaming
  request through the real provider registry (with an unsaved draft key if present) and reports success/failure plus
  latency.
- **技能**: enable or disable loaded skills (user scope), import a `SKILL.md` file or a skill directory into
  `~/.x-code/skills/`, or paste a marketplace install command: `npx skills add owner/repo [--skill name]`,
  `add-skill`, a GitHub/Git URL, a local path, or `xc`/`claude plugin install <target>`. Only the target is parsed;
  no shell is executed. Imports reload the registry and invalidate the system-prompt cache for the next turn.
  User-scope skills that were not contributed by a plugin can be deleted here.
- **MCP**: list user/project/plugin servers with connection status, add or update a user-level server as JSON
  (validated by the core schema), remove user-level servers, and reconnect. A skipped project-level config can be
  trusted and loaded from this tab. OAuth servers expose their authorization URL and a re-authorize action; the
  browser is opened by the main process when the runtime emits the auth URL.
- **插件**: list installed plugins with scope/version/marketplace, enable or disable them, reload their skill,
  agent, command, hook, and MCP contributions, import a local plugin directory, and uninstall installed plugins
  (with an inline confirm). Plugins that declare `userConfig` collect it in the install dialog (types, required
  fields and defaults are enforced; sensitive inputs are masked) and get a `配置` button afterwards. Values are
  stored in `~/.x-code/plugins/user-config.json` (0600) and merged into the plugin's MCP server env; re-reading the
  dialog hides sensitive values (`已保存（留空保持不变）`), and uninstalling clears them.
- **插件市场**: search the cached indexes of subscribed marketplaces, refresh them, view descriptions/versions/
  categories, and install entries. Every install first requests the core consent preview (source, contributions,
  hooks, MCP, author/license) and requires an explicit confirmation. Also supports pasting
  `xc plugin install <target>` / `claude plugin install <target>` (the target is parsed; no shell is executed) and
  adding a marketplace by name and source. Installs are user-scope and reload all contributions.
- **工具**: built-in tools with Chinese labels and descriptions. Enable or disable tools, switch the full/standard
  surface, mark write/permission tools as `始终允许`, or enable a global `全部工具始终允许` (equivalent to
  `trustMode`) after a warning. Disabling any tool switches the root agent to the restricted tool surface.

`X_CODE_OPEN_SETTINGS=1 pnpm start` opens the drawer at launch for inspection.

## Documents and media

The runtime registers the core `readDocument` tool for non-code work. It extracts locally and returns bounded text plus
metadata — document bytes are never sent to a model, so parsing does not spend tokens:

- PDF (text extraction, page ranges; pages without a text layer are rendered and OCRed locally — up to 10 pages,
  `ocr:false` opts out), Word `.docx`, Excel `.xlsx`/`.csv`/`.tsv`, PowerPoint `.pptx`,
  OpenDocument `.odt`/`.ods`/`.odp`
- Markdown/plain text, EPUB (spine order), MOBI/AZW (PalmDOC; HUFF/CDIC and DRM are rejected)
- Images (local OCR plus dimensions; large images are downscaled to an 1800px OCR copy, and `readFile` should be
  used when a vision model needs the image itself), audio (local whisper.cpp transcription)
- Video metadata (MP4/MOV duration/resolution); `extractFrames` writes still frames to temp files when `ffmpeg` is
  installed

Options: `maxChars` (default 50k, max 200k), `pages` for PDFs, `ocr:false` to skip scanned-page OCR,
`transcribe:false` for audio, and `extractFrames` for video. The tool is read-only and always allowed. Core workers
for Office, PDF rendering, audio transcription, and image compression are bundled beside the runtime module and
unpacked from asar.

Document workflows also use four local tools (visible under Settings → 工具):

- `batchRename` — dry-run by default, never overwrites, caps at 100 files; literal find/replace, prefix/suffix, or
  sequential numbering.
- `convert` — merge PDFs, extract a page range, or convert images on macOS via `sips`; the output path is refused if
  it already exists.
- `transcribe` — on-device whisper transcription with timestamps; the audio is never uploaded.
- `spreadsheet` — read up to 100×50 cells, filter/group/aggregate, append or set cells in `.xlsx` (writes ask for
  permission), and render simple bar/line SVG charts.
- `documentExport` — render Markdown/HTML to PDF through Electron (the runtime asks the main process to print a
  hidden window) or to DOCX through macOS `textutil`; an existing output is never overwritten.
- `documentLibrary` — index a folder (or one file) into the local document library, show stats, or clear it
  (clearing asks for permission).
- `documentSearch` — hybrid search over the library, returning file, page (PDF), and snippet.

## Document library

`设置 → 文档库` (the 23rd tool pair above) builds a local index under `~/.x-code/library/`:

- Supported documents are parsed with `readDocument`, chunked (~800 chars with overlap), and stored with their text
  in `index.json`. Limits: 200 files / 5M characters by default; files whose mtime and size did not change are
  skipped, deleted files are dropped on reindex, and unchanged chunks keep their vectors by content hash.
- Keyword search indexes latin words and CJK bigrams, with idf weighting and a filename bonus. It works with no
  extra dependencies.
- Semantic search uses BGE-small-zh-v1.5 (512-dim) through transformers.js when the optional package
  `@huggingface/transformers` is installed; vectors are stored in `vectors.f32` and combined with keyword ranks
  (RRF). The first semantic index or search downloads the model (~100 MB). Without the package the library reports
  keyword-only mode and everything else keeps working.
- Results show the file, PDF page, score, and a snippet; clicking a result opens the document panel at that page
  (loading further page batches when the citation is past the first 20).
- `索引当前项目`, `选择文件夹并索引…`, `重建上次索引`, and `清空索引` live in the same tab, with live progress from
  `library:progress` events.

## Document panel

`⋯ → 文档面板` (or `/doc`) opens a preview drawer for any local file:

- Markdown/plain text rendered locally; PDF rendered page by page with that page's extracted text underneath and a
  combined full-text section at the end; DOCX/PPTX/EPUB as extracted text; XLSX/CSV as sheet previews (first 60 rows
  × 30 columns, multiple sheets selectable); images inline (large images downscaled to 1800px for preview).
- PDF pages render in batches of 20: a `继续渲染` button at the bottom of the page list loads the next batch, so a
  100-page PDF stays responsive. The combined text covers every page, including pages whose images are not loaded.
- Scanned pages have no text layer: each page offers `识别本页`, and a `识别无文字页` button runs local OCR over all
  pages missing text. OCR stays on the machine, is stored per page in `~/.x-code/desktop-documents.json`, and is
  merged back when the document is reopened until `清除 OCR` is used.
- Closing the panel keeps the current document; `文档` reopens it without asking for a file again.
  `切换文档` lists recent documents (with an OCR marker) and offers `打开其他文件…`.
- Edit review for text documents (md/txt/csv/json/html/…): the first open stores a baseline in
  `~/.x-code/desktop-documents.json`. After the agent (or another program) changes the file, reopening it shows a
  review bar; `查看改动` lists line hunks with per-hunk checkboxes and `应用所选` keeps the selected changes while
  reverting the rest to the baseline. The current file hash is verified before writing, so an edit made during the
  review is never silently overwritten, and the baseline advances to the applied content afterwards.
  `以当前内容为新基线` accepts everything and dismisses the review.
- Buttons: 总结 (ask the agent to summarize the file), 作为附件 (add it to the composer as an attachment), 重新读取,
  and a question box that submits the question with the file attached.
- Tool cards for `readDocument` show a 预览 action next to the path.

PDF previews render at 1600px width through the pdf-render worker (20 pages per worker call) and skip attachment
compression, so previews do not spend tokens or hit model image limits.

## Projects and sessions

The left sidebar has two levels:

- **项目** lists recent workspaces (persisted in `~/.x-code/desktop-settings.json`). `＋` opens a folder picker and
  switches the runtime to that project; sessions, skills, plugins, and MCP are re-bootstrapped for the new workspace.
  The last workspace is restored on the next launch.
- **会话** lists sessions for the current project. `＋` starts a new session; clicking a session resumes it.
  The topbar `侧栏` button collapses or reopens the sidebar.

Switching projects saves the current session first and starts the new project with an empty conversation, ready for
picking an existing session.

## Slash commands

Type `/` in the composer to open the palette. Arrow keys move, Tab completes, Enter runs, Escape closes.

Available: `/help`, `/model`, `/settings`, `/sessions`, `/resume`, `/terminal`, `/diagnostics`, `/compact`,
`/context`, `/usage`, `/usage-history`, `/doctor`, `/ps`, `/list-agents`, `/goal`, `/memory`, `/thinking`, `/plan`,
`/clear`, `/stop`, `/init`, `/review`, `/exit`.

- `/init` and `/review` submit built-in prompts to the agent.
- `/ps` lists core background shell sessions; the terminal drawer's PTY is separate.
- `/memory` shows the user memory Core profile and topic list (read-only).
- `/fork`, `/rewind`, `/theme`, `/browser`, and `/clear-peer-context` are listed in the palette with a "not yet
  available" message.

## Theme and language

`⋯ → 主题` cycles light → dark → follow-system; `⋯ → 语言` switches Chinese/English. Both choices are stored in
the renderer's localStorage and applied before the first paint. Translations use i18next with the Chinese source
strings as keys, so any untranslated string falls back to Chinese instead of showing a raw key.

## Shell sandbox (macOS)

On macOS the desktop runs agent shell commands (foreground and managed background shells) under
`/usr/bin/sandbox-exec` with a workspace-write profile, enabled by default:

- writes are allowed only inside the workspace, `$TMPDIR`, `/private/tmp`, and `/private/var/folders`; reads elsewhere
  stay allowed;
- credential locations are blocked for both read and write (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`,
  `~/.config/gcloud`, `~/Library/Keychains`, `~/.netrc`, `~/.npmrc`, `~/.pypirc`,
  `~/.x-code/desktop-secrets.json`, and the plugin `user-config.json`);
- network access is denied by default;
- variables matching API key / token / secret / password / credential / private key are stripped from the child
  environment.

`设置 → 工具 → Shell 沙箱（macOS）` toggles the sandbox and can allow network access. Commands that install packages or
fetch over the network need `允许网络` enabled (they may also need writes outside the workspace, e.g. package caches,
in which case turn the sandbox off). The interactive terminal drawer is the user's own shell and is not sandboxed;
MCP servers and plugin subprocesses are not covered by this sandbox yet.

## Project checks

`⋯ → 项目检查` (or `/checks`) detects and runs the workspace's own checks:

- Node: package scripts named `typecheck`, `lint`, `test`, `build` in that order (using the detected package manager
  — pnpm / yarn / bun / npm), or `tsc --noEmit` when a `tsconfig.json` exists without a typecheck script.
- Rust: `cargo check` then `cargo test` when `Cargo.toml` exists.
- Runs use `CI=1` so watch modes stay one-shot, cap each check at 10 minutes, stop at the first failure by default
  (later checks are marked skipped), and return the last 8 KB of output.
- The panel shows status, duration, and collapsible output. Failures expose `交给 Agent 修复`, which submits the
  failing output to the agent as a repair request.
- `自动检查` runs the checks after every completed turn and reports failures as a system line plus a notice; the
  toggle persists in `~/.x-code/desktop-settings.json` (`autoChecks`).

## Task modes

The chip next to the model picker switches between **Coding / Writing / Research / Office**. Each mode appends a short
instruction block to the system prompt (`systemPromptExtra`): implementation focus, prose structure/tone,
source-grounded research with citations, or office documents/spreadsheets/slides. The choice is persisted in
`~/.x-code/desktop-settings.json` (`taskMode`) and survives restarts; switching invalidates the cached system prompt
so the next turn uses the new block. Empty sessions show a mode-specific hint plus three suggestion chips that fill
the composer. Modes are guidance only — every tool stays available in every mode.

## Git panel and per-turn checkpoints

`⋯ → Git` (or `/git`) opens a drawer with the current branch, ahead/behind counts, +/− line stats, and the
changed-file list. Selecting a file shows its diff (unstaged or staged; untracked files render as fully added,
bounded to 300 KB). The panel refreshes on demand.

Before every agent turn the runtime captures a checkpoint in the workspace repository:

- `git stash create` snapshots the tracked working tree and index without modifying anything, and the list of
  untracked files is recorded.
- `撤销本轮` restores tracked files and the index to that snapshot and deletes only untracked files created during
  the turn. Pre-existing user edits and untracked files are preserved by design, and HEAD/history is never moved.
- Checkpoints are kept in memory for the last 20 turns and cleared when switching sessions or projects. With a clean
  tree the checkpoint falls back to HEAD; repositories without commits only get the untracked-file cleanup.

## Context limit and long requests

Long turns are not cut off by the IPC layer: `agent:submit` has no timeout, installs/marketplace/MCP/workspace
switches/extension reloads get 15 minutes, and `/compact` gets 10. If the provider reports `maximum context
length` (or an equivalent overflow), the core loop compacts the conversation automatically and retries the same
turn; a summary request that is itself too large is split at a clean message boundary and chained. The transcript
shows `上下文已压缩` when this happens. Manual recovery remains `/compact` or `/clear`.

## CI

`.github/workflows/pr-check.yml` includes a `Desktop Smoke` job on Ubuntu: it builds core and desktop, runs the
desktop vitest project, and runs both Electron smokes under `xvfb` with `--no-sandbox`. The normal macOS smoke
commands (`pnpm --filter @x-code-cli/desktop smoke` / `smoke:ui`) remain the local path.

## Constraints discovered in Phase 0

- Electron is pinned to **44.9.3** because `fs-ext-extra-prebuilt@2.2.16` ships an `electron-abi149` prebuild for
  Electron 44 and none for Electron 45 (ABI 150).
- `scripts/postinstall.mjs` restores the executable bit on node-pty's `spawn-helper`; pnpm 10 does not run
  dependency install scripts configured only through the root `pnpm` field.
- The runtime installs `@napi-rs/canvas`'s `DOMMatrix` before importing `pdf-parse`; pdfjs mistakes Electron's
  utility process for a browser and skips its own polyfill.
- Build platform artifacts on their native OS. Cross-packaged Linux/Windows directories from macOS contain
  macOS native binaries.
