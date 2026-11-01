import fs from 'node:fs'
import path from 'node:path'

import type { LspDiagnostic, LspLocation, LspRenameEdit } from './typescript-service.js'

function marker(filePath: string, line: number, column: number): string {
  return `${filePath}:${line}:${column}`
}

export function formatLocations(locations: readonly LspLocation[], empty: string): string {
  if (locations.length === 0) return empty
  return locations
    .map((item) => {
      const preview = item.preview ? `  ${item.preview}` : ''
      return `${marker(item.file, item.line, item.column)}${preview}`
    })
    .join('\n')
}

export function formatDiagnostics(diagnostics: readonly LspDiagnostic[], filePath: string): string {
  if (diagnostics.length === 0) return `No TypeScript diagnostics for ${filePath}.`
  return diagnostics
    .map((item) => {
      const code = item.code === undefined ? '' : ` TS${item.code}`
      const preview = item.preview ? `\n  ${item.preview}` : ''
      return `${marker(item.file, item.line, item.column)} - ${item.severity}${code}: ${item.message}${preview}`
    })
    .join('\n')
}

export function formatRename(edits: readonly LspRenameEdit[], newName: string): string {
  if (edits.length === 0) return `No rename locations found for ${newName}.`
  const byFile = new Map<string, LspRenameEdit[]>()
  for (const edit of edits) {
    const list = byFile.get(edit.file) ?? []
    list.push(edit)
    byFile.set(edit.file, list)
  }
  const lines = [`Preview only: ${edits.length} occurrence(s) would become "${newName}". Nothing was written.`]
  for (const [file, items] of byFile) {
    lines.push('', file)
    for (const item of items) {
      const preview = item.preview ? `  ${item.preview}` : ''
      lines.push(`  ${item.line}:${item.column}${preview}`)
    }
  }
  lines.push('', 'Apply the change with the normal edit/write tools so it goes through the usual permission path.')
  return lines.join('\n')
}

/** Find the nearest project marker when the caller did not pass a root. */
export function inferProjectRoot(filePath: string): string {
  const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath)
  let directory = path.dirname(absolute)
  for (;;) {
    for (const markerName of ['tsconfig.json', 'jsconfig.json', 'package.json', '.git']) {
      if (fs.existsSync(path.join(directory, markerName))) return directory
    }
    const parent = path.dirname(directory)
    if (parent === directory) return path.dirname(absolute)
    directory = parent
  }
}
