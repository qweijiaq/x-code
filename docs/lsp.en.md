# Semantic code navigation

X-Code includes four read-only tools that use the workspace's TypeScript language service. They answer questions that text search cannot answer precisely: where a symbol is declared, every place it is referenced, compiler diagnostics for a file, and what a rename would change.

The pilot targets TypeScript and JavaScript. It resolves the `typescript` package from the workspace, so the project being edited controls the compiler version. Other languages fall back to `grep`, `readFile` and project checks for now.

## Requirements

A TypeScript installation in the workspace (or a parent directory):

```bash
npm install -D typescript
```

If the compiler lives somewhere unusual, point X-Code at its server entry point:

```bash
export X_CODE_TSSERVER_PATH=/path/to/typescript/lib/tsserver.js
```

The tools start `tsserver` lazily, reuse it for a minute, then close it. No language server runs unless one of the tools is called.

## Tools

| Tool             | What it returns                                                                       |
| ---------------- | ------------------------------------------------------------------------------------- |
| `lspDiagnostics` | Syntactic and semantic diagnostics for one file, with `file:line:column` and previews |
| `lspDefinition`  | The declaration(s) of the symbol at a position                                        |
| `lspReferences`  | Every reference to the symbol, optionally including the declaration                   |
| `lspRename`      | A preview of every location a rename would change; it never writes                    |

All four accept `filePath`, plus `root` when the project root cannot be inferred from the file. Absolute paths are preferred. The position tools also need `line` and `column`, both 1-based.

## Example

```text
lspReferences { filePath: "/repo/src/config.ts", line: 18, column: 14 }
```

```text
/repo/src/config.ts:18:14    export function loadConfig() {
/repo/src/app.ts:42:19       const config = loadConfig()
/repo/src/server.ts:11:23    loadConfig().then(...)
```

`lspRename` returns a preview only:

```text
Preview only: 3 occurrence(s) would become "readConfig". Nothing was written.
```

Apply the edits with the normal `edit` or `writeFile` tools. That keeps the usual diff card and permission path, and makes the change reviewable before it lands.

## When to use what

- Use `lspDefinition` / `lspReferences` before a rename or a cross-file refactor.
- Use `lspDiagnostics` after an edit when you need the compiler's opinion rather than a full project check.
- Use `grep` when the symbol is dynamic, generated, or the workspace has no TypeScript.
- Use the Inspector project checks for full `tsc` / ESLint / test runs.

## Current limits

- TypeScript/JavaScript only; no generic LSP transport yet.
- Rename is a preview, not an automatic multi-file write.
- The service reads the file from disk; unsaved editor buffers are not part of the session.
- DAP debugging is out of scope for this pilot.

The implementation lives in `packages/core/src/lsp/` and the tools in `packages/core/src/tools/lsp.ts`. Tests live in `packages/core/tests/lsp.test.ts`.
