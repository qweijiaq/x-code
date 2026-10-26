# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Where the rules live

[`AGENTS.md`](AGENTS.md) is the canonical instruction entrypoint and is more detailed than this file — read it first. This file summarizes the load-bearing facts so you can be productive before reading every doc. Deeper workflow rules live in [`docs/development/agent-workflow.md`](docs/development/agent-workflow.md) (delivery stages, verification evidence, Human Plan Review / Local Acceptance, PR handling) and [`docs/development/harness-setup.md`](docs/development/harness-setup.md). The repo is X-Code CLI, a model-agnostic coding-agent CLI with Claude Code-compatible extensions.

## Commands

pnpm workspace; Node >= 22 (Node 20 is unsupported), pnpm 10.

```bash
pnpm build              # core: tsc -b + copy-native; cli: esbuild → dist/cli.js
pnpm dev                # build, then run the CLI from source via tsx
pnpm typecheck          # tsc -b across core, cli, and all test tsconfigs
pnpm lint               # eslint --fix (MUTATES files)
pnpm lint:check         # eslint, non-mutating
pnpm format             # prettier --write; format:check is non-mutating
pnpm test               # build + vitest run (unit, faults, package, pty projects)
pnpm test <pattern>     # single file: pnpm test packages/core/tests/agent-loop.test.ts
pnpm test:e2e           # real-LLM E2E suite (token cost; not part of PR CI)
pnpm run ci             # typecheck + lint:check + format:check + test — the broad local gate
```

- `pnpm test` builds first and runs four vitest projects: `unit` (core + cli tests), `faults`, `package`, `pty`. A single file is matched via the `<pattern>` filter.
- `pnpm lint` mutates; use `lint:check` for a read-only gate.
- After editing **core** sources you must `pnpm build` (or `tsc -b --watch` in `packages/core`). The CLI imports `packages/core/dist/`, not the TS source.
- Tests use **vitest globals** (`describe`, `it`, `expect`, `vi`) — no imports needed. Test files are ignored by eslint.

## Architecture

Two packages, unidirectional dependency: `cli` → `core`. **Core has zero UI dependencies.**

```
packages/
  core/    Agent engine: agentLoop, tools, providers, knowledge, permissions, sub-agents
  cli/     Terminal UI: Ink (lifecycle only), ChatInput cell-grid renderer, slash commands
```

Key systems and the files that define them:

- **Rendering** — Ink's dynamic region is permanently empty; every visible element is drawn by `packages/cli/src/ui/chat-input/ChatInput.tsx` writing directly to `process.stdout` via cell-level diff. `package.json` aliases `ink` to `@jrichman/ink@6.6.9`; never import from `@jrichman/ink` directly.
- **Agent loop** — `packages/core/src/agent/loop.ts:agentLoop`: one call = one user message, spinning `runTurn` rounds until stop / tool-calls / abort. `LoopState` is reused across submits within a CLI session. `systemPromptCache` must stay **byte-stable** between invalidation events (model switch, `/skill`/`/mcp` refresh, permission-mode flip); any per-turn interpolation silently disables prompt caching for OpenAI-compatible providers.
- **Deferred tools** — `packages/core/src/agent/tool-search/`: MCP tools and non-core built-ins are listed by name under `## Deferred Tools` and loaded on demand via `toolSearch`; `buildDeferredCatalog` falls back to full injection for weak models / small catalogs. Sub-agents get no catalog (inline `## MCP Tools` block instead).
- **Sub-agents** — `packages/core/src/agent/sub-agents/`: the `task` tool delegates to an isolated `agentLoop` with a fresh `LoopState`. The registry is built at CLI startup and frozen; adding/editing agent files requires a CLI restart. Sub-agents always deny `task` (no recursion). In plan mode, write tools are denied via tool filter.
- **Knowledge** — `packages/core/src/knowledge/`: four layers merged into the system prompt — user AGENTS.md, user memory Core profile (`~/.x-code/memory/MEMORY.md`), project AGENTS.md chain (root→leaf, leaf wins), `AGENTS.local.md`.
- **Providers** — `packages/core/src/providers/catalog.ts:PROVIDERS` is the single metadata table (envKey, defaultModel, `/model` picker, base URLs, reasoning tiers); derived views and the test env-var list all come from it. Adding a provider = one catalog entry + a constructor branch in `registry.ts`. API keys read only from env vars (+ `OPENAI_COMPATIBLE_API_KEY`/`OPENAI_COMPATIBLE_BASE_URL` escape hatch).
- **Permissions** — 3-level model (always-allow / ask / deny); shell commands classified via `shell-utils.ts` (quote-aware compound-command splitting, LRU cache).
- **Cross-session messaging** — `packages/core/src/peers/`, `packages/cli/src/peer-lifecycle.ts`: `--name` enables local discovery/messaging. Peer input taints derived context and routes tool calls through the authority evaluator; local Unix sockets on macOS/Linux, Windows fails closed as unsupported.
- **Shared internal modules** (`packages/core/src/`): `frontmatter.ts` (YAML frontmatter parser), `registry-diff.ts` (`diffNamedEntries()` for all registry reloads), `settings-io.ts` (fault-tolerant JSON settings), `utils.ts:generateTimestampId` (canonical `YYYYMMDD-HHMMSS-mmm`). `userXcodeDir()` resolves all user file I/O (respects `X_CODE_HOME`); the frozen `USER_XCODE_DIR` constant is only for byte-stable prompt content and log init.

## Conventions

- **ESM only** (`"type": "module"`); `.js` extensions on relative imports even in `.ts` files (NodeNext).
- No semicolons, single quotes, trailing commas, print width 120.
- Import order enforced by `prettier-plugin-sort-imports`: `node:` → `react` → `ink` → `ai`/`@ai-sdk` → `zod` → `@x-code-cli/` → `./` relative.
- Comments are written in Simplified Chinese and reserved for _why_ (terminal-protocol workarounds, provider quirks), not what the next line does. Keep machine directives and code examples verbatim.
- Conventional commits (`feat:`, `fix:`, `refactor:`, …; plus `release`, `wip`) enforced by commitlint.
- `.x-code/` at repo root is gitignored (session summaries, auto-memory, local prefs, custom sub-agents). Tests redirect via `X_CODE_HOME`.
- `DEBUG_STDOUT=1 xc` writes to `~/.x-code/logs/debug.log` (10 MB rolling); `debugLog()` in core is a no-op without it.
- `packages/core/tests/api-exports.test.ts` locks the `@x-code-cli/core` public export list; run `pnpm test -- -u` after intentional changes.

## Gotchas

- **Don't auto-commit.** Passing typecheck/build/tests is NOT authorization — wait for an explicit `提交` / `commit` / `ok ship it`. One authorization covers one chunk only.
- **Thread `options.abortSignal` through any tool-execution code you change.** Orphan tool_calls (without tool_results) make the next API request fail.
- **OpenAI-compatible providers auto-cache stable prefixes** — never interpolate timestamps or frame-shifting data into `systemPromptCache` or sub-agent tool descriptions.
- **Blocking the UI thread kills the TUI** — `ChatInput` renders via direct stdout writes on a setInterval timer; long synchronous work in tool execution, permission callbacks, or slash-command handlers freezes the display.
- **No `<Box>` / `<Text>` Ink children that produce visible output** — `App.tsx` returns a single `<ChatInput>`; new UI surfaces go inside `ChatInput.tsx`'s cell buffer.

## Delivery workflow (summary)

Follow [`docs/development/agent-workflow.md`](docs/development/agent-workflow.md) for the full contract. The essentials: define the work and get **Human Plan Review** before non-trivial changes (silence is not approval); verify with the narrowest check first (`pnpm test <pattern>` → `pnpm typecheck` / `lint:check` / `format:check` → `pnpm build` after core edits → `pnpm run ci` before Ready); record every check as `PASSED` / `FAILED` / `NOT EXECUTED` / `NOT APPLICABLE`; **Human Local Acceptance** is a human decision — an implementing agent cannot accept its own work. Use [`.github/pull_request_template.md`](.github/pull_request_template.md) for the PR handoff. The real-LLM E2E suite is `SETUP REQUIRED` (no credentials/cadence chosen) — never claim it ran; report unexecuted E2E as `NOT EXECUTED`.
