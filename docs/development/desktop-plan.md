# X-Code Desktop — Implementation Plan

Status: Implemented (original plan; kept for architecture rationale)
Last updated: 2026-10-24

> This is the original design document. Current behavior is documented in
> [`desktop-ux.md`](./desktop-ux.md); release steps live in
> [`desktop-release.md`](./desktop-release.md). The Phase 0–3 scope below is
> complete, including multi-window runtimes, worktree windows, session
> recovery, image attachments and permission-rule management. Still open:
> signed automatic updates, and acceptance of the Windows/Linux installers on
> real devices.

## 1. Goal

Ship a desktop application (`packages/desktop`, Electron) that provides functional parity with the interactive
`xc` CLI: the same agent loop, tools, providers, MCP servers, plugins, skills, sub-agents, hooks, knowledge,
memory, sessions, permissions, authentication, peer messaging, and shell sessions — against the same on-disk
`~/.x-code` data.

### Non-goals

- Pixel-level parity with the terminal UI. The CLI's cell-grid renderer, mouse handling, DEC 2026 synchronized
  updates, raw-mode stdin, bracketed paste, and pipe semantics are terminal-specific and are not reproduced.
- Changing `packages/core`'s agent semantics, public behavior, or prompt-cache invariants.
- Replacing the CLI. `xc`, `--print`, `xc plugin`, `xc login`, and shell pipelines remain first-class.
- Windows peer messaging. This release stays fail-closed as unsupported until an audited native transport exists.

## 2. Feasibility basis

The split already supports a second UI:

- `packages/core/src` has **zero** `process.stdout` / `process.stdin` references. All terminal writes live in
  `packages/cli/src`.
- `AgentCallbacks` (`packages/core/src/types/index.ts:270`) is a UI-facing event/callback contract, including
  Promise-based `onAskPermission`, `onAskUser`, and `onPlanApprovalRequest` — directly serializable over IPC.
- `--print` mode (`packages/cli/src/print.ts`) already consumes `agentLoop` without Ink, proving the engine is
  UI-independent.
- The CLI's startup assembly (providers → memory → marketplaces → plugins → sub-agents → skills → commands →
  MCP config/trust → options → SessionStart hooks → resume) uses only public `@x-code-cli/core` exports.

The work is therefore a UI-layer rewrite plus a process/packaging integration, not an engine rewrite.

## 3. Architecture

### 3.1 Process model

```
┌──────────────────────────── Electron main ────────────────────────────┐
│ Window lifecycle · menus · single-instance lock · auto-update         │
│ IPC broker · approval bridge · external links · OS integration        │
└───────────▲──────────────────────────────────────▲────────────────────┘
            │ MessagePort / ipcRenderer            │
┌───────────┴────────────────┐         ┌───────────┴────────────────────┐
│ Renderer (React + Vite)    │         │ Runtime utilityProcess         │
│ Chat, tool cards, diffs,   │         │ @x-code-cli/core               │
│ modals, xterm.js, settings │         │ agentLoop · tools · MCP        │
│ No Node integration        │         │ plugins · sessions · PTY       │
└────────────────────────────┘         │ peers · auth · memory          │
                                       └────────────────────────────────┘
```

- **Runtime runs in `utilityProcess`, not `main`.** Core performs synchronous work (file ingest, parsing) and owns
  child processes; blocking Electron's main process freezes every window. `utilityProcess` gives Node APIs,
  crash isolation, and a restart path. The message protocol is transport-agnostic so the runtime can move back
  into `main` for a Phase 0 spike if needed.
- **Renderer is sandboxed**: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`. It receives only
  serializable view models and never credentials or raw filesystem handles.
- **Approvals** (permission, authority, ask-user, plan approval) originate in the runtime, are routed through main
  to the renderer, and return as requests keyed by `requestId`. If the renderer or window disappears while an
  approval is pending, the runtime resolves it as **denial** (fail closed), matching CLI behavior.

### 3.2 Package layout

```
packages/desktop/
  package.json
  electron-builder.yml
  vite.config.ts
  tsconfig.json                 # main/preload/shared (node) + renderer (DOM) projects
  src/
    shared/
      protocol.ts               # channel names, request/event types, error codes
      view-models.ts            # serializable UI models (no core class instances)
    main/
      index.ts                  # app lifecycle, single instance, window
      runtime-host.ts           # utilityProcess spawn/restart, message relay
      approval-bridge.ts        # runtime <-> renderer request routing, fail-closed
      menu.ts
      updater.ts
      smoke.ts                  # --smoke-test headless boot for packaging CI
    preload/
      index.ts                  # contextBridge allowlist
    runtime/
      index.ts                  # utilityProcess entry
      bootstrap.ts              # core assembly (see 4.1)
      agent-host.ts             # per-session LoopState, turn coordinator, callbacks
      services/                 # sessions, models, mcp, plugins, skills, auth, peers, shell, usage
    renderer/
      index.html
      main.tsx
      app/                      # routes/panes
      components/               # transcript, tool cards, composer, modals, terminal
      stores/                   # app/session/turn state
      styles/
  tests/
    unit/                       # protocol + runtime assembly (vitest)
    e2e/                        # Playwright _electron against fake provider
```

Dependency direction remains acyclic: `desktop → core`. Desktop must not import `packages/cli`.

## 4. Reuse and rewrite inventory

### 4.1 Runtime assembly

Reuse public core exports directly. Desktop owns a `bootstrap.ts` that mirrors the CLI ordering:

1. `loadEnvFile`-equivalent (desktop-specific env loading; see 7.2).
2. `initializeOpenAIAuthContext`, `getAvailableProviders`, `resolveModelId`, `createModelRegistry`.
3. `MemoryService.initialize(cwd)`.
4. `ensureDefaultMarketplaces()`, `loadAllPlugins()`, `buildPluginIntegration()`.
5. `createSubAgentRegistry({ extraDirs })`, `createSkillRegistry`, `createCommandRegistry`.
6. `loadMcpConfigsFromDisk()` with injected `askUser`, `oauthProviderFor`, `onExitRequested`.
7. Build `AgentOptions` from `loadUserConfig()` + desktop settings.
8. Fire `SessionStart` hooks (fire-and-forget).
9. Resume/continue session selection is driven by the renderer instead of argv.

Keep this assembly **desktop-local for Phase 1**. Extracting `createRuntime()` into core would be cleaner but
would touch the CLI and its tests for no user-visible gain; revisit only if CLI/desktop bootstrap drift becomes a
recurring defect. A parity test asserts that desktop and CLI assemble the same registry contents for the same
fixture workspace.

CLI-side plumbing that must be ported (small, currently UI-adjacent):

| Module                                                | Lines | Disposition                                      |
| ----------------------------------------------------- | ----- | ------------------------------------------------ |
| `packages/cli/src/peer-lifecycle.ts`                  | 51    | Copy/adapt into `runtime/services/peers.ts`      |
| `packages/cli/src/shutdown-coordinator.ts`            | 88    | Adapt to app quit / utilityProcess teardown      |
| `packages/cli/src/cleanup-controller.ts`              | 17    | Replace with runtime host lifecycle              |
| `packages/cli/src/ui/agent/turn-coordinator.ts`       | 155   | Copy as-is (pure state machine)                  |
| `packages/cli/src/ui/agent/use-session-controller.ts` | 357   | Extract pure session logic; rewrite React hook   |
| `packages/cli/src/ui/app/usage-report.ts`             | 141   | Extract formatting logic; rewrite UI             |
| `packages/cli/src/launch-cwd.ts`                      | 17    | Adapt (desktop passes workspace path explicitly) |

### 4.2 Rewrite

All rendering in `packages/cli/src/ui/**` is terminal-specific and is rewritten:

- `chat-input/` (3.7k-line `ChatInput.tsx`, cell grid, IME handling, palette) → React composer + command palette.
- `render/` (stdout writer, markdown, shiki TUI, diffs) → web markdown/shiki, DOM diff view.
- `app/App.tsx` (2k lines) → React app shell and panes.
- 28 slash commands → renderer actions/panels backed by runtime RPC (see 5.2).

### 4.3 Keep unchanged

`packages/cli` in its entirety (including `--print`, plugin CLI, auth CLI), `packages/core` public API, on-disk
formats, provider catalog, permission engine, knowledge chain.

## 5. IPC protocol

`shared/protocol.ts` defines three unions: `RuntimeToMain`, `MainToRendererEvent`, and
`RendererToMainRequest` (method → params/result). Every request has `id`; every response is
`{ id, ok: true, result }` or `{ id, ok: false, error: { code, message } }`. Event payloads are plain JSON.

### 5.1 Events (runtime → renderer)

| Channel                      | Payload                                                                             |
| ---------------------------- | ----------------------------------------------------------------------------------- |
| `agent:text-delta`           | `{ turnId, delta }`                                                                 |
| `agent:tool-call`            | `{ turnId, toolCallId, toolName, input }`                                           |
| `agent:tool-progress`        | `{ turnId, toolCallId, message }`                                                   |
| `agent:tool-result`          | `{ turnId, toolCallId, result, isError }`                                           |
| `agent:file-edit`            | `{ turnId, toolCallId, diff }`                                                      |
| `agent:shell-output`         | `{ turnId, chunk }`                                                                 |
| `agent:usage`                | `TokenUsage`                                                                        |
| `agent:todos`                | `TodoItem[]`                                                                        |
| `agent:context-compressed`   | `{ summary }`                                                                       |
| `agent:compression-progress` | `{ description }`                                                                   |
| `agent:stream-retry`         | `StreamRetryEvent \| null`                                                          |
| `agent:subagent-event`       | `SubAgentEvent`                                                                     |
| `agent:error`                | `{ code, message }`                                                                 |
| `agent:turn-end`             | `{ turnId, reason, state }`                                                         |
| `approval:request`           | `{ requestId, kind: 'permission' \| 'authority' \| 'question' \| 'plan', payload }` |
| `shell:session-event`        | `ShellSessionEvent`                                                                 |
| `peer:inbox`                 | `{ entries, digest }`                                                               |
| `mcp:status`                 | `{ server, state, error? }`                                                         |
| `auth:changed`               | `OpenAIAuthSnapshot`                                                                |
| `update:available`           | `{ version }`                                                                       |

### 5.2 Requests (renderer → runtime)

| Group      | Methods                                                                                                                                                                                                                                |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Turn       | `agent:submit`, `agent:abort`, `agent:queue-input`, `agent:set-thinking`, `agent:set-permission-mode`, `agent:set-model`, `agent:set-tool-profile`                                                                                     |
| Approval   | `approval:respond` (permission/authority/question/plan)                                                                                                                                                                                |
| Sessions   | `session:list`, `session:load`, `session:save-as`, `session:fork`, `session:rewind`, `session:delete`, `session:export`                                                                                                                |
| Context    | `context:stats`, `context:compact`, `context:clear`, `memory:list`, `memory:search`                                                                                                                                                    |
| Models     | `models:list`, `models:refresh`                                                                                                                                                                                                        |
| Extensions | `mcp:list`, `mcp:reload`, `mcp:doctor`, `mcp:set-enabled`, `plugin:list`, `plugin:install`, `plugin:uninstall`, `plugin:set-enabled`, `plugin:doctor`, `skill:list`, `skill:set-enabled`, `agent:list`, `agent:reload`, `command:list` |
| Auth       | `auth:login` (browser/device), `auth:status`, `auth:logout`                                                                                                                                                                            |
| Shell      | `shell:create`, `shell:write`, `shell:resize`, `shell:kill`, `shell:list`, `shell:background`                                                                                                                                          |
| Peers      | `peer:list`, `peer:send`, `peer:clear-context`                                                                                                                                                                                         |
| Ops        | `usage:summary`, `usage:history`, `doctor:run`, `goal:get`, `goal:set`, `browser:*`, `app:open-external`, `app:pick-workspace`                                                                                                         |

Rules:

- One active turn per session. The runtime's turn coordinator mirrors the CLI's `TurnOwner` lease model;
  `agent:submit` while a turn is active returns a typed `turn-busy` error (renderer queues instead).
- Streaming deltas are batched in the runtime (e.g. 16–33 ms) before crossing IPC to avoid per-token overhead.
- Request payloads are validated with zod at the runtime boundary (zod is already a core dependency).
- The renderer never receives API keys, OAuth tokens, raw `LanguageModel` objects, or class instances.

## 6. Feature parity scope

All interactive CLI surfaces map to a desktop surface:

| Area                                                                                             | Desktop surface                                       |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| Chat, streaming, reasoning, tool calls/results, errors                                           | Transcript with tool cards, expandable results        |
| Permissions (3-level), peer authority, ask-user, plan approval                                   | Modals with full canonical tool input and preview     |
| Todos, goal mode, plan mode, step stats, usage/context                                           | Status bar + side panels                              |
| Sessions: resume, continue, fork, rewind, export                                                 | Session sidebar and picker                            |
| Models, thinking, theme, tool profile                                                            | Settings + model picker                               |
| MCP list/reload/doctor/OAuth, plugins/marketplace/consent, skills, sub-agents, hooks diagnostics | Extensions panes                                      |
| Memory and knowledge                                                                             | Memory pane (`/memory`); knowledge remains file-based |
| Shell sessions, background terminals (`/ps`)                                                     | xterm.js terminal pane + process list                 |
| Auth: browser/device login, status, logout                                                       | Settings + first-run flow                             |
| Peers: inbox, send, clear context                                                                | Peer pane                                             |
| Media ingest (PDF/Office/image/audio), @file references, image paste                             | Composer attachments + file picker                    |
| `/init`, `/review`                                                                               | Command palette actions (agent-driven)                |
| `/help`, `/doctor`, `/usage`, `/usage-history`, `/context`                                       | Help/Diagnostics/Usage panes                          |

Slash commands remain available in the composer palette with the same names and semantics; command _handlers_
become renderer actions or runtime RPCs. The parity checklist in Phase 2 is the source of truth.

## 7. Platform, native modules, packaging

### 7.1 Native modules

| Module                                        | Used by                                                           | Packaging concern                                                      |
| --------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `node-pty`                                    | Shell sessions, embedded terminals                                | Electron ABI; rebuild or N-API prebuild; `asarUnpack`                  |
| `fs-ext-extra-prebuilt`                       | File locks                                                        | Electron ABI; `asarUnpack`                                             |
| `@napi-rs/canvas`                             | Image/vision fallback                                             | N-API prebuilt per platform; `asarUnpack`                              |
| `@vscode/ripgrep`                             | `grep` tool                                                       | Binary must be unpacked; path resolution                               |
| `tesseract.js`                                | OCR                                                               | Worker + wasm assets outside asar                                      |
| `@fugood/whisper.node`, `@napi-audio/decoder` | Audio transcription (optional)                                    | Optional deps; `asarUnpack`                                            |
| Core workers                                  | `audio-transcribe`, `pdf-render`, `image-compress`, `office-xlsx` | Bundled separately like `packages/cli/esbuild.config.js`; `asarUnpack` |

Build the runtime entry and workers with esbuild, mirroring `packages/cli/esbuild.config.js` (ESM, node22 target,
externalized natives and `pdf-parse`/`tesseract.js`). Run `@electron/rebuild` in `postinstall` for non-N-API
addons.

**Fallback if a native module cannot load under Electron's ABI:** ship a Node 22 runtime and run the runtime
process with it via `child_process` instead of `utilityProcess`. This restores the stock Node ABI at the cost of
installer size and one more IPC boundary. Decide in Phase 0 based on a per-module probe.

### 7.2 Data and environment

- All file I/O continues through `userXcodeDir()` / `X_CODE_HOME`, so desktop and CLI share config, sessions,
  memory, plugins, MCP, skills, and auth. Desktop must not redirect this to Electron's `app.getPath` directories.
- Environment: GUI launches on macOS/Windows do not inherit a shell profile. Provide a settings surface for
  provider keys and `.env` loading consistent with the CLI (document precedence: process env → project `.env` →
  stored config, matching existing behavior). Never expose stored keys back to the renderer.
- Workspace selection is explicit (folder picker); `process.cwd()` is set per session/workspace rather than
  inherited from the launcher.
- Single-instance lock: `app.requestSingleInstanceLock()`. A second launch focuses the existing window.
- CLI and desktop may run concurrently against the same `~/.x-code`. Do not resume the same session in both at
  once; document this and keep the runtime's existing lock behavior. Add an advisory session lock if a core
  mechanism is available; otherwise defer.

### 7.3 Packaging and release

- `electron-builder` targets: macOS `dmg`/`zip` (x64 + arm64, hardened runtime, notarized), Windows `nsis`
  (x64 + arm64), Linux `AppImage` + `deb`.
- `asarUnpack` for the native modules, worker bundles, ripgrep binary, and tesseract assets.
- Auto-update via `electron-updater` with signature verification (Phase 3).
- Installer size expectation: 150–250 MB because of optional OCR/whisper assets. Consider deferring
  OCR/whisper to optional downloads later; out of scope for parity.
- Update check in desktop replaces the CLI's npm-registry hint.

## 8. Security

- Renderer sandboxed; preload exposes an explicit method allowlist; no raw `ipcRenderer` exposure.
- Navigation and window-open handlers deny everything except allowlisted external URLs (`shell.openExternal`).
- CSP restricts scripts to the bundled app; no remote content in the renderer.
- Approval payloads are canonical objects produced by the runtime; the renderer cannot reshape them.
- Pending approvals resolve to denial on renderer crash, window close, or utility-process restart.
- Credentials and OAuth tokens remain in the runtime/main; only auth status snapshots cross to the renderer.
- Project trust (MCP project servers, plugin consent) uses the same core policies; desktop must not add a
  bypass. Plugin consent UI shows the same preview data the CLI does.
- Debug logging stays opt-in (`DEBUG_STDOUT=1`) and writes to the existing log file.
- No telemetry by default.

## 9. Testing and CI

| Level         | Scope                                                                                                                             | Command                                                                 |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Unit          | Protocol codec, approval bridge (fail-closed), turn coordinator, session/model services, runtime assembly parity                  | `pnpm --filter @x-code-cli/desktop test` (new vitest project `desktop`) |
| Integration   | Runtime host + fake provider: submit → stream → tool → approval → save/resume, no GUI                                             | vitest in `packages/desktop/tests/unit`                                 |
| E2E           | Playwright `_electron`: launch packaged/dev app against the fake provider, assert transcript, approve a write, resume the session | `pnpm test:desktop-e2e` (not in default `pnpm test`)                    |
| Package       | `electron-builder --dir`, assert `app.asar.unpacked` contents, run `--smoke-test`                                                 | `pnpm check:desktop-package`                                            |
| Compatibility | CLI→desktop→CLI session round-trip; same config/registry contents                                                                 | vitest fixture test                                                     |

CI additions:

- Extend `pnpm typecheck` to include desktop tsconfigs.
- Add a `desktop` job (ubuntu): build, unit, Playwright under `xvfb-run`, package `--dir` smoke.
- Release workflow: add a desktop build matrix (macOS/Windows/Linux). Signing/notarization secrets are a
  Phase 3 prerequisite owned by maintainers.
- Follow `docs/development/agent-workflow.md` evidence vocabulary; do not claim E2E or packaged acceptance
  without the recorded evidence.

## 10. Phases and acceptance criteria

Estimates assume one full-time engineer; they are planning ranges, not commitments.

### Phase 0 — Feasibility spike (3–5 days)

Deliverables: Electron + Vite + React + TS skeleton; runtime utilityProcess boots core with a fake provider and
streams a reply to the renderer; node-pty runs a command and renders in xterm.js; `electron-builder --dir`
produces a launchable app with natives unpacked.

Exit criteria (record exact OS/arch/node/electron versions and commands):

- Dev mode and packaged macOS app both stream a fake-provider reply.
- PTY output renders and accepts input in both.
- Per-module report for `node-pty`, `fs-ext-extra-prebuilt`, `@napi-rs/canvas`, `@vscode/ripgrep`, and core
  workers: loaded / rebuilt / fallback needed.
- Windows and Linux packaging attempted; failures documented with the blocker.

### Phase 1 — MVP (2–3 weeks)

Deliverables: protocol + approval bridge; runtime bootstrap (plugins → skills → agents → MCP → options);
chat with streaming, tool cards, diffs, todos; permission/ask-user/plan modals; session list/resume; model
picker; abort and queued input; file/image ingest; light/dark theme.

Acceptance:

- E2E: launch → choose model → prompt that triggers a read and a write → approve one / deny one → reply
  completes → session saved → resume shows the identical transcript.
- The saved session resumes in the CLI with the same messages and a continuing conversation.
- Denying a write produces the same model-visible error path as the CLI.
- Registry contents (MCP servers, skills, agents, commands) match a CLI run against the same fixture.
- No `packages/core` public API change; `packages/core/tests/api-exports.test.ts` unchanged.

### Phase 2 — Feature parity (4–6 weeks)

Deliverables: every item in section 6; command-by-command parity checklist; extensions management UI; shell
terminal pane and background process list; auth flows; peers; goal/plan/context/usage/doctor; fork/rewind;
MCP OAuth and trust; plugin consent and marketplace; memory pane; browser sub-agent surfaces.

Acceptance:

- Parity checklist: every CLI slash command and listed surface marked PASSED with evidence, or explicitly
  NOT APPLICABLE with reason.
- Cross-platform manual acceptance (macOS + Windows + Linux) recorded per `agent-workflow.md`.
- Peer messaging works between desktop and CLI on macOS/Linux; Windows remains documented as unsupported.
- Approval/denial semantics verified for shell, write, edit, MCP, and peer-influenced calls.

### Phase 3 — Packaging and release (2–3 weeks)

Deliverables: signed/notarized installers for three OS families; auto-update; first-run flow; user docs
(`docs/desktop.md` + zh-CN); README update; release workflow; packaged smoke tests in CI.

Acceptance:

- Signed installers install, launch, update, and uninstall cleanly on all three platforms.
- `--smoke-test` passes in CI on a packaged build.
- Privacy/security notes published (creds location, no telemetry, debug logging).

### Phase 0 findings (executed 2026-10-23)

Environment: macOS 15.3, arm64, Node 22.14.0, pnpm 10.28.2, Electron 44.9.3.

Observed:

- `utilityProcess` boots the core runtime from an ESM bundle. Renderer → preload → main → utility process → `agentLoop`
  with a mock `LanguageModelV3` streams correctly.
- PTY works in the runtime, and xterm.js renders it in the renderer.
- All probed natives load under Electron 44: `node-pty`, `fs-ext-extra-prebuilt`, `@napi-rs/canvas`,
  `@vscode/ripgrep`, `tesseract.js`, `pdf-parse`.
- The unsigned `electron-builder --dir` app (macOS arm64) passes both `--smoke-test` and `--ui-smoke`;
  `asarUnpack` contains the native binaries with executable bits.
- App size after excluding source maps: 462 MB (Electron frameworks 288 MB, `app.asar` 115 MB, unpacked
  natives/assets 59 MB). Set `X_CODE_SOURCEMAP=1` to build with maps for local debugging.

Problems found and resolved:

1. Electron 45 (ABI 150) has no `fs-ext-extra-prebuilt` binary, and the package does not compile against Electron
   45's V8. Electron is pinned to 44.9.3 (ABI 149) with `fs-ext-extra-prebuilt@2.2.16`, which ships ABI-named
   prebuilds for macOS, Linux, and Windows. Revisit when upstream ships ABI 150.
2. pnpm 10 does not run `node-pty`'s install script (the root `pnpm.onlyBuiltDependencies` field in `package.json`
   is ignored by pnpm 10.28). `spawn-helper` therefore lacks the executable bit and `pty.spawn()` fails with
   `posix_spawnp failed`. `packages/desktop/scripts/postinstall.mjs` fixes the mode. Moving the pnpm settings to
   `pnpm-workspace.yaml` is a separate repo-wide task.
3. pdfjs's Electron detection treats the utility process (`process.type === 'utility'`) as a browser and skips its
   Node `DOMMatrix` polyfill. The runtime installs `@napi-rs/canvas`'s `DOMMatrix` before importing `pdf-parse`.
   The PDF worker (a `worker_threads` child, which inherits `process.type`) needs the same polyfill when desktop
   bundles it.
4. Cross-built Linux/Windows `--dir` artifacts from macOS are not valid: pnpm installs only host-platform optional
   binaries, so they contain darwin canvas/ripgrep. Platform packaging must run on native CI runners.
5. In normal mode, a diagnostics (`smoke:run`) result was routed into the `--smoke-test` exit path, so the Run
   diagnostics button quit the app. `finishSmoke` is now gated on `--smoke-test`, and the UI smoke asserts that
   diagnostics completes without exiting.

Verification evidence (macOS 15.3 arm64, Node 22.14.0, Electron 44.9.3):

| Check                                        | Result                        | Notes                                                                                                                                                                                                                           |
| -------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck` (includes desktop)          | PASSED                        | Root script extended to both desktop tsconfigs                                                                                                                                                                                  |
| `pnpm lint:check`                            | PASSED                        |                                                                                                                                                                                                                                 |
| `pnpm format:check`                          | PASSED                        |                                                                                                                                                                                                                                 |
| `pnpm --filter @x-code-cli/desktop smoke`    | PASSED                        | Modules, PTY, agent stream                                                                                                                                                                                                      |
| `pnpm --filter @x-code-cli/desktop smoke:ui` | PASSED                        | Renderer → preload → main → runtime → agent + PTY                                                                                                                                                                               |
| `electron-builder --dir` + packaged smokes   | PASSED                        | Unsigned `X-Code.app`, 462 MB                                                                                                                                                                                                   |
| `pnpm test`                                  | PASSED with environment fixes | Full suite requires `git >= 2.23` (`git init -b`) and a writable npm cache; the default shell here has git 2.15 and a root-owned `~/.npm` cache. Both failing suites pass with `PATH=/usr/bin:$PATH npm_config_cache=/tmp/...`. |

Not executed in Phase 0: Windows and Linux runtime acceptance, signing/notarization, auto-update, and the full CLI
feature parity checklist. Cross-OS packaging was attempted but produces host-native binaries; use per-OS CI runners.

### Phase 1 progress (executed 2026-10-23)

Implemented in `packages/desktop`:

- `runtime/bootstrap.ts`: workspace resolution (env, project marker walk-up), nearest `.env`, OpenAI auth context,
  provider discovery, model catalog, demo fallback, sub-agent/skill/command registries, stream config.
- `runtime/agent-host.ts`: real `agentLoop`, per-session `LoopState`, session save/load/new, model switching with
  prompt-cache invalidation, approval bridge (permission / authority / ask-user / plan), abort, fail-closed
  cancellation.
- `runtime/sessions.ts`: session listing, hydration, and transcript conversion for the renderer.
- Renderer: model picker, session drawer (list/resume/new), permission/plan/question dialogs, tool cards,
  structured diffs, todos, usage, queued input, abort, diagnostics, terminal drawer.
- Demo model (`[tool-demo]`) exercises write → permission → diff without credentials.

Verification (macOS 15.3 arm64, Electron 44.9.3):

| Check                                          | Result | Notes                                                                                                                   |
| ---------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck` (includes desktop)            | PASSED |                                                                                                                         |
| `pnpm lint:check` / `pnpm format:check`        | PASSED |                                                                                                                         |
| `pnpm --filter @x-code-cli/desktop smoke`      | PASSED | Modules, PTY, demo agent                                                                                                |
| `pnpm --filter @x-code-cli/desktop smoke:ui`   | PASSED | agent, tool approval + diff, denial (no diff), session list/resume, PTY, diagnostics, terminal default/toggle, renderer |
| Real provider path against a local fake server | PASSED | `custom:test-model` via `OPENAI_COMPATIBLE_BASE_URL`; server received one request and the streamed reply rendered       |
| Session cross-read                             | PASSED | Core `loadSession` read a desktop-written session; the UI smoke resumed a session with 10 messages                      |
| Full repository suite                          | PASSED | `pnpm test`: 203 files passed / 1 skipped; 2022 tests passed / 27 skipped                                               |

Deferred from Phase 1: plugin install/uninstall UI, the interactive MCP OAuth flow, the project-level MCP trust UI,
file/image attachments, the slash command palette, fork/rewind, peers, and Windows/Linux runtime acceptance. The
real-provider check used the repository's fake provider, not a live vendor API.

### Settings center (executed 2026-10-23)

Implemented:

- `设置` drawer with tabs for models/keys, skills, MCP, plugins, marketplace, and tools.
- API keys are stored in `~/.x-code/desktop-secrets.json` (mode 0600) and injected into the runtime environment
  before provider discovery. The renderer receives only a configured flag and a last-four hint; clearing a stored
  key restores the environment value captured at startup. Custom OpenAI-compatible endpoints also take a base URL.
  `测试连接` sends one minimal streaming request through the real provider registry, using an unsaved draft key or
  base URL when present, and reports latency or the provider error. The always-visible `custom` row accepts a model
  ID, Base URL, and key for an OpenAI-compatible endpoint; saving it persists the model and activates it. The model
  menu also accepts any `provider:model` id.
- Skills: user-scope enable/disable with registry reload and prompt-cache invalidation, file/folder import
  (`SKILL.md` or a directory containing it), marketplace command install (`npx skills add`, `add-skill`,
  GitHub/Git URLs, local paths, and `xc`/`claude plugin install`), and deletion of user-scope skills that are not
  plugin-contributed. Only the command target is parsed; no shell runs.
- MCP: user-scope add/update/remove/reconnect, validated by the core schema. Project-level configs can be trusted
  and loaded from the tab; OAuth servers expose their authorization URL and a re-authorize action. The runtime
  emits `mcp:auth-url` and the main process opens the browser.
- Plugins: list/enable/disable with a full contribution reload, local-directory import, marketplace search and
  refresh, marketplace/command installs gated by the core consent preview (source, contributions, hooks, MCP,
  author/license) with an explicit confirmation, and uninstall with inline confirmation.
- Tools: Chinese labels/descriptions for the built-in surface, per-tool enable/disable, full/standard profile,
  per-tool `始终允许` for permission-needing tools, and a global `全部工具始终允许` (maps to `trustMode`).
  An empty deny list leaves the default deferred tool surface untouched.
- CI: a `Desktop Smoke` job in `.github/workflows/pr-check.yml` builds core/desktop, runs the desktop vitest
  project, and runs both Electron smokes under xvfb with `--no-sandbox`.

Verification (macOS 15.3 arm64, Electron 44.9.3):

| Check                                            | Result       | Notes                                                                                                |
| ------------------------------------------------ | ------------ | ---------------------------------------------------------------------------------------------------- |
| `pnpm typecheck` / `lint:check` / `format:check` | PASSED       |                                                                                                      |
| Desktop unit tests (`vitest --project desktop`)  | PASSED       | 12 tests: secrets, settings/always-allow, command parsing, consent preview/install                   |
| `pnpm --filter @x-code-cli/desktop smoke:ui`     | PASSED       | settings snapshot, drawer, skill command field, marketplace tab, always-allow, auto-approved write   |
| Test connection against the fake provider        | PASSED       | Streaming request returned `来自假服务商的真实 provider 链路。` in 29 ms                             |
| Marketplace refresh                              | PASSED       | `anthropic-marketplace` fetched; 315 entries available                                               |
| Skill import                                     | PASSED       | `SKILL.md` copied to `~/.x-code/skills/demo-skill/SKILL.md`                                          |
| Skill command install                            | PASSED       | `npx skills add <local dir>` and `npx skills add file://<local git repo>` both imported their skills |
| Plugin consent preview / confirmed install       | PASSED       | Local fixture previewed without installing; confirmation installed it exactly once                   |
| Custom OpenAI-compatible model                   | PASSED       | `setCustomModel` persisted model/base URL/key; active model, demo=false, and model list updated      |
| Full repository suite                            | PASSED       | 204 files passed / 1 skipped; 2034 tests passed / 27 skipped                                         |
| Packaged `--smoke-test` and `--ui-smoke`         | PASSED       | Settings included in the packaged renderer smoke                                                     |
| Desktop CI job                                   | NOT EXECUTED | Workflow added; first run will validate Linux natives, xvfb, and `--no-sandbox`                      |

Limitations: plugin `userConfig` fields are not collected by the desktop installer (defaults apply; sensitive
fields stay unset); the consent preview covers manifest/root contributions but does not execute or validate them.
Live MCP OAuth acceptance has not been exercised against a real OAuth server. Secrets remain plaintext with 0600
permissions (no OS keychain yet). Disabling any tool switches the root agent to the restricted tool surface; global
always-allow bypasses all permission prompts.

### Slash command palette (executed 2026-10-23)

Implemented:

- Composer `/` palette with filtering, arrow-key selection, Tab completion, Enter to run, Escape to close, and
  unknown-command handling.
- UI actions: `/help`, `/model`, `/settings`, `/sessions`, `/resume`, `/terminal`, `/diagnostics`, `/clear`,
  `/stop`, `/exit`, `/init`, `/review`.
- Runtime commands: `/compact`, `/context`, `/usage`, `/usage-history`, `/doctor`, `/ps`, `/list-agents`, `/goal`,
  `/memory`, `/thinking`, and `/plan`. Reports render in the transcript report panel; `/init` and `/review` submit
  built-in prompts.
- `/ps` covers core background shell sessions; the terminal drawer PTY is separate. `/memory` is a read-only view
  of the user memory Core profile and topic list.
- Not yet implemented: `/fork`, `/rewind`, theme switching, the browser sub-agent, and `/clear-peer-context`; the
  palette reports these as unavailable.

Verification:

| Check                                    | Result | Notes                                                                                                                        |
| ---------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --filter ... smoke:ui`             | PASSED | palette mounts, `/usage` renders a report; context/doctor/agents/goal/shell reports non-empty; thinking/plan toggles restore |
| Full repository suite                    | PASSED | 204 files passed / 1 skipped; 2034 tests passed / 27 skipped                                                                 |
| Packaged `--smoke-test` and `--ui-smoke` | PASSED | Palette and command reports included in the packaged renderer smoke                                                          |

### Documents, media, and project sidebar (executed 2026-10-23)

Implemented:

- Core `readDocument` tool (registered in `toolRegistry`, read-only/always-allow): PDF text + page ranges, Word
  `.docx`, Excel `.xlsx`/`.csv`/`.tsv`, PowerPoint `.pptx`, OpenDocument, Markdown/text, EPUB (spine order),
  MOBI/AZW (PalmDOC; HUFF/CDIC and DRM rejected), images (local OCR + dimensions), audio (local whisper.cpp),
  and video metadata plus optional ffmpeg frame extraction. Extraction is local, bounded by `maxChars`, and never
  sends document bytes to a model.
- Desktop bundles core workers beside the runtime module (`office-xlsx`, `audio-transcribe`, `pdf-render`,
  `image-compress`), unpacks them from asar, and sets `ELECTRON_RUN_AS_NODE=1` for core's `fork()`-based audio
  worker. The composer has a `文档` picker that inserts a `readDocument` prompt with the selected path.
- Two-level sidebar: recent projects (persisted in `desktop-settings.json` with the last workspace) and sessions for
  the current project. Project `＋` opens a folder picker; session `＋` starts a new session; clicking a project
  saves the current session, re-bootstraps core for that workspace, and clears the conversation. The topbar
  `侧栏` button and `/sessions` toggle the sidebar.

Verification:

| Check                                    | Result | Notes                                                                                                       |
| ---------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------- |
| Core document extraction tests           | PASSED | 8 tests: Markdown, quoted CSV, truncation, EPUB, MOBI/PalmDOC, MP4 duration, tool-result formatting         |
| Desktop runtime smoke                    | PASSED | All four worker files present; `readDocument` executed in the utility process and returned the fixture text |
| Workspace switch (`AgentHost`)           | PASSED | Init → switch to a temp project; current workspace, recent list, and settings workspace updated             |
| UI smoke                                 | PASSED | Sidebar with projects, collapse/reopen, document picker present; 16 built-in tools                          |
| Full repository suite                    | PASSED | 205 files passed / 1 skipped; 2042 tests passed / 27 skipped                                                |
| Packaged `--smoke-test` and `--ui-smoke` | PASSED | Worker/document probes and sidebar included in the packaged renderer smoke                                  |

Limitations: video frame extraction requires `ffmpeg`; MOBI HUFF/CDIC and DRM-protected EPUB/MOBI are rejected;
scanned PDF pages are rendered and OCRed locally (first 10 pages, `ocr:false` opts out) so text extraction works
without a vision model, though recognition quality depends on the scan; images are OCR-only (large images are
downscaled to an 1800px OCR copy, and `readFile` is the vision path); audio transcription requires the optional
whisper native
binding and may download a model; the Office/PDF/audio worker paths are verified for presence and smoke execution,
not every format end-to-end. The project picker is an OS dialog, so project switching is covered by the runtime
test rather than the headless UI smoke. `agent:submit` has no IPC timeout; its response arrives at turn end. The
main process applies a long (15 min) timeout to install, marketplace, MCP, workspace-switch, and extension-reload
requests, and a 10 min timeout to `agent:compact`, so slow network work is not mistaken for a hung request.

Context overflow is handled inside the core agent loop rather than surfaced to the user: an API error matching
`maximum context length` / `context_length_exceeded` triggers reactive compaction and a retry of the same turn.
If the summary request itself overflows, the old history is split at a non-tool message boundary and summarized in
chained chunks. Only when compaction cannot free context does the friendly "Context too long" error appear, with
`/compact` as the manual recovery path.

## 11. Risks

| Risk                                     | Severity | Mitigation                                                                    |
| ---------------------------------------- | -------- | ----------------------------------------------------------------------------- |
| Native addon ABI mismatch under Electron | High     | Phase 0 probe; `@electron/rebuild`; prefer N-API; Node-runtime fallback       |
| Main-process blocking freezes windows    | High     | Runtime in `utilityProcess`; batch IPC; workers for heavy work                |
| Worker/asset path breakage in asar       | High     | `asarUnpack`, packaged smoke test on 3 OS, explicit path tests                |
| UI parity scope creep                    | Medium   | Section 6 checklist; phase gates; itemized evidence                           |
| Bootstrap drift between CLI and desktop  | Medium   | Parity test; revisit shared `createRuntime()` if drift appears                |
| Duplicate session writes (CLI + desktop) | Medium   | Single-instance lock; documented constraint; advisory lock if available       |
| Prompt-cache instability                 | Medium   | Never inject per-turn data into `systemPromptCache` or sub-agent descriptions |
| Credentials exposure via renderer        | High     | Secrets stay in runtime; preload allowlist; fail-closed approvals             |
| Signing/notarization lead time           | Medium   | Start Phase 3 account setup early; maintainer-owned secrets                   |
| Installer size (OCR/whisper)             | Low      | Optional asset downloads later; document size                                 |

## 12. Open decisions

1. Renderer stack: React + Vite + Zustand (recommended) vs other. Ink cannot run in a browser.
2. Runtime process: `utilityProcess` (recommended) vs Electron `main` (Phase 0 spike may start in `main`).
3. Runtime assembly: desktop-local bootstrap using public core exports (recommended for Phase 1) vs extracting
   `createRuntime()` into core now.
4. Window model: single window per app instance (recommended for MVP) vs multiple windows sharing a runtime.
5. Shared storage: keep `~/.x-code` for both UIs (recommended) vs a desktop-specific directory.
6. Product identity: app name, `appId`, icons, and whether the desktop app ships as a separate npm-unrelated
   binary (recommended) or through the existing package.

## 13. Verification checklist for this plan

- [ ] Human Plan Review recorded (maintainer decision in chat/Issue/Draft PR).
- [ ] Phase 0 native-module report produced before MVP commitment.
- [ ] Acceptance criteria per phase verified with recorded evidence, not inference.
- [ ] `AGENTS.md` architecture section updated (`desktop → core`, process model) when Phase 1 lands.
- [ ] `docs/development/agent-workflow.md` harness table updated with desktop capability status.
- [ ] No change to `packages/core` public behavior without updating the API export snapshot deliberately.
