# Getting started

This is the shortest path from a fresh clone or download to a first useful task.

## Desktop (macOS arm64)

1. Download `X-Code-<version>-arm64.dmg` from [Releases](https://github.com/qweijiaq/x-code/releases/latest).
2. Verify it against `SHA256SUMS`.
3. Drag **X-Code** into Applications.
4. The community build is ad-hoc signed, not notarized. macOS asks for approval once. If macOS says the app is damaged:
   - verify `SHA256SUMS` first;
   - then run `xattr -dr com.apple.quarantine /Applications/X-Code.app`.

The desktop app is the recommended path if you want the Inspector, diffs, checks and the built-in terminal.

## CLI (Node 22+)

```bash
npm install -g @x-code-cli/cli@latest
xc --version
```

From source:

```bash
git clone https://github.com/qweijiaq/x-code.git
cd x-code
pnpm install
pnpm build
pnpm dev
```

## Connect a model

Open **Settings → Models & keys**. Pick a provider, paste the key, and press **Test connection**.

- No key? The app starts in demo mode. The demo model only exercises the UI.
- Local models: Ollama or LM Studio are discovered automatically.
- Hosted gateways: OpenCode Zen / OpenCode Go and OpenDesign / OpenDesign Go have their own keys; pick the provider in **Settings → Models & keys**.
- Any OpenAI-compatible endpoint: choose **custom**, fill **Base URL** and **API key**, press **获取模型 / Fetch models**, then pick a model from the list.

If a provider is slow or unstable, check the connection result before assuming the app is stuck. The status bar shows whether the model is thinking, generating tool arguments, or retrying.

## First task

Do not start with “analyze the whole repository”. Pick one narrow task:

1. **Explain one module** — “Read `src/app.ts` and explain what it does in five bullets.”
2. **Fix one failure** — paste a test error and ask the agent to find the cause and fix it.
3. **Review a diff** — ask it to review the current `git diff` and list real risks.
4. **Add one test** — pick a function and ask for a focused test.

The intended loop is: ask → see the plan/tool calls → approve the diff → run a check → read the result.

## Where to look next

- The desktop app ships an in-app manual. Press `?` or run `/manual`.
- CLI: `xc --help`, `xc help watch`, `xc help plugin`.
- Source package: [`packages/desktop/README.md`](./packages/desktop/README.md); the CLI is documented by `xc --help`.
- Release notes: [`CHANGELOG.md`](./CHANGELOG.md); the in-app manual is the complete guide.

## Common first-run problems

- **“Waiting for model response” for a long time** — check whether the status bar says thinking, generating tool input, or retrying. Very large `writeFile` calls can legitimately take minutes.
- **Connection resets** — some gateways are unstable on direct connections. The desktop app uses the macOS system proxy when one is configured; the OpenDesign provider in particular may need it.
- **Permission prompts** — read the diff or command. Approve once, always for that pattern, or deny with feedback.
- **Command not found after installing a tool** — the agent refreshes PATH before each turn; ask it to retry instead of running the command yourself.
