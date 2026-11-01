# 语义代码导航

X-Code 提供四个只读工具，直接使用工作区的 TypeScript language service。它们回答纯文本搜索难以精确回答的问题：符号在哪里定义、被哪些地方引用、这个文件有哪些编译诊断，以及重命名会改到哪些位置。

这一版先覆盖 TypeScript / JavaScript。工具从工作区解析 `typescript` 包，所以编译器版本由被编辑的项目决定。其他语言暂时回退到 `grep`、`readFile` 和项目检查。

## 前提

工作区（或上层目录）里有 TypeScript：

```bash
npm install -D typescript
```

如果编译器在非标准位置，可以指定 tsserver：

```bash
export X_CODE_TSSERVER_PATH=/path/to/typescript/lib/tsserver.js
```

工具会懒启动 `tsserver`，一分钟内复用，空闲后自动退出。没有调用这些工具时不会跑语言服务。

## 四个工具

| 工具             | 返回                                                        |
| ---------------- | ----------------------------------------------------------- |
| `lspDiagnostics` | 单个文件的语法 / 语义诊断，带 `file:line:column` 和代码预览 |
| `lspDefinition`  | 指定位置的符号定义                                          |
| `lspReferences`  | 符号的全部引用，可选择是否包含声明                          |
| `lspRename`      | 重命名会改到的所有位置预览，不会写文件                      |

四个工具都接受 `filePath`；如果无法从文件推断项目根，再传 `root`。建议传绝对路径。定位类工具还需要 `line` 和 `column`，都从 1 开始。

## 示例

```text
lspReferences { filePath: "/repo/src/config.ts", line: 18, column: 14 }
```

```text
/repo/src/config.ts:18:14    export function loadConfig() {
/repo/src/app.ts:42:19       const config = loadConfig()
/repo/src/server.ts:11:23    loadConfig().then(...)
```

`lspRename` 只返回预览：

```text
Preview only: 3 occurrence(s) would become "readConfig". Nothing was written.
```

真正的修改请继续用 `edit` / `writeFile`，这样会走正常的 diff 卡片和权限审批。

## 什么时候用

- 重命名或跨文件重构前，先用 `lspDefinition` / `lspReferences`。
- 编辑后想知道编译器怎么判断，用 `lspDiagnostics`，不必跑完整项目检查。
- 符号是动态的、生成的，或项目没有 TypeScript 时，回退 `grep`。
- 完整的 `tsc` / ESLint / 测试仍然用 Inspector 的项目检查。

## 当前限制

- 只支持 TypeScript / JavaScript，还没有通用 LSP transport。
- 重命名是预览，不会自动多文件写入。
- 语言服务读磁盘文件，不包含编辑器里未保存的临时内容。
- DAP 调试不在这一版范围内。

实现位于 `packages/core/src/lsp/`，工具定义在 `packages/core/src/tools/lsp.ts`，测试在 `packages/core/tests/lsp.test.ts`。
