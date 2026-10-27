// @x-code-cli/core — 工具注册表（统一导出）
//
// 记忆写入从不作为工具暴露。一个持久的轮次后 worker 会在根 loop 结束后
// 抽取操作。仅根拥有的 memorySearch 工具在 loop.ts 里动态创建，因为它需要
// 当前的 MemoryService 和 LoopState；子 agent 永远不会拿到它。
import { askUser } from './ask-user.js'
import { killShell, shellOutput } from './background-shell.js'
import { backgroundGet, backgroundList, backgroundOutput } from './background-tasks.js'
import { batchRename } from './batch-rename.js'
import { convert } from './convert.js'
import { documentExport } from './document-export.js'
import { documentLibrary } from './document-library.js'
import { documentSearch } from './document-search.js'
import { edit } from './edit.js'
import { enterPlanMode } from './enter-plan-mode.js'
import { exitPlanMode } from './exit-plan-mode.js'
import { glob } from './glob.js'
import { grep } from './grep.js'
import { listDir } from './list-dir.js'
import { readDocumentTool } from './read-document.js'
import { readFile } from './read-file.js'
import { shell } from './shell.js'
import { spreadsheet } from './spreadsheet.js'
import { todoWrite } from './todo-write.js'
import { transcribe } from './transcribe.js'
import { webFetch } from './web-fetch.js'
import { webSearch } from './web-search.js'
import { writeFile } from './write-file.js'

export const toolRegistry = {
  readFile,
  readDocument: readDocumentTool,
  writeFile,
  edit,
  shell,
  glob,
  grep,
  listDir,
  webSearch,
  webFetch,
  askUser,
  enterPlanMode,
  exitPlanMode,
  todoWrite,
  shellOutput,
  killShell,
  backgroundList,
  backgroundGet,
  backgroundOutput,
  batchRename,
  convert,
  transcribe,
  spreadsheet,
  documentExport,
  documentSearch,
  documentLibrary,
}

export { MAX_TOOL_RESULT_BYTES, truncateToolResult } from './truncate.js'
