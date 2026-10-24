// @x-code-cli/core — Tool registry (unified export)
//
// Memory writes are never exposed as a tool. A durable post-turn worker
// extracts operations after the root loop finishes. The root-only
// memorySearch tool is created dynamically in loop.ts because it needs the
// current MemoryService and LoopState; sub-agents never receive it.
import { askUser } from './ask-user.js'
import { killShell, shellOutput } from './background-shell.js'
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
  batchRename,
  convert,
  transcribe,
  spreadsheet,
  documentExport,
  documentSearch,
  documentLibrary,
}

export { MAX_TOOL_RESULT_BYTES, truncateToolResult } from './truncate.js'
