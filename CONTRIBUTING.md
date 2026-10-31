# Contributing to X-Code

Thanks for trying X-Code. Bug reports, provider compatibility notes and small
focused pull requests are all useful.

## Before opening an issue

- Search existing issues first.
- Include the X-Code version, macOS version, provider/model and whether the app
  or the CLI is involved.
- For UI problems, attach a screenshot with API keys and private paths removed.
- For agent behavior, include the relevant session JSONL or a minimal
  reproduction prompt if it is safe to share.

## Development setup

Node.js 22+ and pnpm 10.x are required.

```bash
pnpm install
pnpm build
pnpm dev:desktop     # desktop app
pnpm dev             # CLI from source
```

Run the narrowest check first, then broaden:

```bash
pnpm test packages/core/tests/<name>.test.ts
pnpm typecheck
pnpm lint:check
pnpm format:check
pnpm run ci
```

The real-LLM E2E suite costs tokens and is not part of the default PR gate:

```bash
pnpm test:e2e --filter <scenario>
```

## Pull requests

- Keep changes focused; avoid unrelated refactors in the same PR.
- Match the existing style: ESM, no semicolons, single quotes, Chinese comments
  reserved for non-obvious constraints.
- Add or update tests for behavior changes. UI changes should keep the desktop
  UI smoke suite passing.
- Do not commit API keys, `.env` files, sessions, attachments or logs.
- Use conventional commits (`feat:`, `fix:`, `docs:`, `perf:`, `test:` ...).
- Describe what you verified and what you could not verify. "Tests not run" is
  acceptable when stated; a false claim is not.

## Platform support

macOS arm64 is the supported desktop build. Windows and Linux builds are
configured in CI but have not completed real-device acceptance. If you can test
on those platforms, open an issue with the build log and the failing workflow.
