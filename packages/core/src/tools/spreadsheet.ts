// @x-code-cli/core — spreadsheet tool
//
// Reads and writes .xlsx locally (ExcelJS). Reading is capped at 100 rows × 50
// columns per call; querying supports filters and group aggregates; writing is
// limited to explicit cell ranges or appended rows and requires permission.
// Charts are rendered as a small SVG file from label/value arrays.
import ExcelJS from 'exceljs'

import fs from 'node:fs/promises'
import path from 'node:path'

import { tool } from 'ai'

import { z } from 'zod'

import { formatToolError } from '../utils/tool-errors.js'
import { reportProgress } from './progress.js'

const MAX_ROWS = 100
const MAX_COLUMNS = 50
const MAX_CHART_POINTS = 30

type Cell = string | number | boolean | null

const FILTER_OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'empty', 'notEmpty'] as const
const AGGREGATE_OPS = ['count', 'sum', 'avg', 'min', 'max'] as const

const inputSchema = z.object({
  action: z.enum(['read', 'query', 'write', 'chart']).describe('Operation to run'),
  filePath: z.string().min(1).max(4096).optional().describe('Absolute path to the .xlsx file'),
  sheet: z.string().max(200).optional().describe('Worksheet name (default: first sheet)'),
  range: z.string().max(50).optional().describe('Cell range for read, e.g. "A1:F50"'),
  hasHeader: z.boolean().optional().describe('Treat the first row as column names (default true)'),
  filters: z
    .array(
      z.object({
        column: z.union([z.string(), z.number().int().min(1)]),
        op: z.enum(FILTER_OPS),
        value: z.union([z.string(), z.number(), z.boolean()]).optional(),
      }),
    )
    .max(10)
    .optional(),
  groupBy: z.union([z.string(), z.number().int().min(1)]).optional(),
  aggregates: z
    .array(
      z.object({
        column: z.union([z.string(), z.number().int().min(1)]).optional(),
        op: z.enum(AGGREGATE_OPS),
        as: z.string().max(100).optional(),
      }),
    )
    .max(10)
    .optional(),
  sortBy: z.union([z.string(), z.number().int().min(1)]).optional(),
  descending: z.boolean().optional(),
  limit: z.number().int().min(1).max(MAX_ROWS).optional(),
  write: z
    .object({
      mode: z.enum(['set', 'append']),
      rows: z
        .array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])))
        .min(1)
        .max(MAX_ROWS),
      startCell: z.string().max(20).optional(),
    })
    .optional(),
  labels: z.array(z.string().max(40)).min(1).max(MAX_CHART_POINTS).optional(),
  values: z.array(z.number()).min(1).max(MAX_CHART_POINTS).optional(),
  title: z.string().max(100).optional(),
  chartType: z.enum(['bar', 'line']).optional(),
  output: z.string().min(1).max(4096).optional().describe('Chart output path (must not exist)'),
})

type Input = z.infer<typeof inputSchema>

function cellValue(value: ExcelJS.CellValue): Cell {
  if (value === null || value === undefined) return null
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') return value
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') {
    const record = value as unknown as Record<string, unknown>
    if ('result' in record) return cellValue(record.result as ExcelJS.CellValue)
    if (typeof record.text === 'string') return record.text
    if (Array.isArray(record.richText)) {
      return record.richText.map((part) => String((part as { text?: string }).text ?? '')).join('')
    }
    if ('error' in record) return String(record.error)
  }
  return String(value)
}

function columnIndex(letters: string): number {
  let index = 0
  for (const char of letters.toUpperCase()) {
    const code = char.charCodeAt(0)
    if (code < 65 || code > 90) throw new Error(`Invalid column: ${letters}`)
    index = index * 26 + (code - 64)
  }
  return index
}

function columnLetters(index: number): string {
  let value = index
  let letters = ''
  while (value > 0) {
    const remainder = (value - 1) % 26
    letters = String.fromCharCode(65 + remainder) + letters
    value = Math.floor((value - 1) / 26)
  }
  return letters
}

function parseRange(range: string): { startRow: number; startCol: number; endRow: number; endCol: number } {
  const match = /^([A-Za-z]+)(\d+):([A-Za-z]+)(\d+)$/.exec(range.trim())
  if (!match) throw new Error(`Invalid range "${range}"; expected something like A1:F50.`)
  const startCol = columnIndex(match[1]!)
  const startRow = Number(match[2])
  const endCol = columnIndex(match[3]!)
  const endRow = Number(match[4])
  return {
    startRow: Math.min(startRow, endRow),
    endRow: Math.max(startRow, endRow),
    startCol: Math.min(startCol, endCol),
    endCol: Math.max(startCol, endCol),
  }
}

function parseCell(address: string): { row: number; col: number } {
  const match = /^([A-Za-z]+)(\d+)$/.exec(address.trim())
  if (!match) throw new Error(`Invalid cell "${address}"; expected something like B3.`)
  return { row: Number(match[2]), col: columnIndex(match[1]!) }
}

async function loadWorkbook(filePath: string): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(filePath)
  return workbook
}

function selectSheet(workbook: ExcelJS.Workbook, name?: string): ExcelJS.Worksheet {
  if (name) {
    const sheet = workbook.getWorksheet(name)
    if (!sheet) throw new Error(`Sheet "${name}" not found.`)
    return sheet
  }
  const first = workbook.worksheets[0]
  if (!first) throw new Error('Workbook has no sheets.')
  return first
}

interface TableData {
  sheet: string
  headers: string[]
  rows: Cell[][]
  totalRows: number
  truncated: boolean
}

function readTable(sheet: ExcelJS.Worksheet, input: Input): TableData {
  const range = input.range ? parseRange(input.range) : null
  const startRow = range?.startRow ?? 1
  const startCol = range?.startCol ?? 1
  const requestedCols = range ? range.endCol - range.startCol + 1 : Math.max(1, sheet.columnCount)
  const endCol = startCol + Math.min(requestedCols, MAX_COLUMNS) - 1
  const lastRow = Math.min(sheet.rowCount, range?.endRow ?? sheet.rowCount)
  const totalRows = Math.max(0, lastRow - startRow + 1)
  const endRow = Math.min(lastRow, startRow + MAX_ROWS - 1)
  const raw: Cell[][] = []
  for (let rowNumber = startRow; rowNumber <= endRow; rowNumber++) {
    const row = sheet.getRow(rowNumber)
    const cells: Cell[] = []
    for (let col = startCol; col <= endCol; col++) cells.push(cellValue(row.getCell(col).value))
    raw.push(cells)
  }
  const hasHeader = input.hasHeader !== false
  const headers = hasHeader
    ? (raw[0] ?? []).map((value, index) =>
        value === null || value === '' ? columnLetters(startCol + index) : String(value),
      )
    : Array.from({ length: endCol - startCol + 1 }, (_, index) => columnLetters(startCol + index))
  const rows = hasHeader ? raw.slice(1) : raw
  return { sheet: sheet.name, headers, rows, totalRows, truncated: totalRows > MAX_ROWS }
}

function resolveColumn(column: string | number | undefined, headers: string[]): number {
  if (column === undefined) return -1
  if (typeof column === 'number') {
    if (column < 1 || column > headers.length) throw new Error(`Column index ${column} is out of range.`)
    return column - 1
  }
  const trimmed = column.trim()
  const exact = headers.findIndex((header) => header === trimmed)
  if (exact >= 0) return exact
  const lower = headers.findIndex((header) => header.toLowerCase() === trimmed.toLowerCase())
  if (lower >= 0) return lower
  if (/^[A-Za-z]+$/.test(trimmed)) return columnIndex(trimmed) - 1
  throw new Error(`Column "${column}" not found. Available: ${headers.join(', ')}`)
}

function toNumber(value: Cell): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function matches(
  value: Cell,
  op: (typeof FILTER_OPS)[number],
  expected: string | number | boolean | undefined,
): boolean {
  const left = typeof value === 'string' ? value.toLowerCase() : value
  const right = typeof expected === 'string' ? expected.toLowerCase() : expected
  switch (op) {
    case 'eq':
      return String(left ?? '') === String(right ?? '')
    case 'neq':
      return String(left ?? '') !== String(right ?? '')
    case 'contains':
      return String(left ?? '').includes(String(right ?? ''))
    case 'empty':
      return value === null || value === ''
    case 'notEmpty':
      return !(value === null || value === '')
    default: {
      const a = toNumber(value)
      const b = typeof expected === 'number' ? expected : toNumber(expected ?? null)
      if (a === null || b === null) return false
      if (op === 'gt') return a > b
      if (op === 'gte') return a >= b
      if (op === 'lt') return a < b
      return a <= b
    }
  }
}

function aggregate(values: number[], op: (typeof AGGREGATE_OPS)[number]): number {
  if (op === 'count') return values.length
  if (values.length === 0) return 0
  if (op === 'sum') return values.reduce((total, value) => total + value, 0)
  if (op === 'avg') return values.reduce((total, value) => total + value, 0) / values.length
  if (op === 'min') return Math.min(...values)
  return Math.max(...values)
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function renderChartSvg(input: Input): string {
  const labels = input.labels ?? []
  const values = input.values ?? []
  if (labels.length !== values.length) throw new Error('labels and values must have the same length.')
  const width = 640
  const height = 320
  const padding = { top: 32, right: 24, bottom: 56, left: 56 }
  const plotWidth = width - padding.left - padding.right
  const plotHeight = height - padding.top - padding.bottom
  const max = Math.max(...values, 0)
  const min = Math.min(...values, 0)
  const span = max - min || 1
  const y = (value: number): number => padding.top + plotHeight - ((value - min) / span) * plotHeight
  const zeroY = y(0)
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    '<rect width="100%" height="100%" fill="#f6f2e8"/>',
    `<text x="${width / 2}" y="22" text-anchor="middle" font-family="Songti SC, serif" font-size="15" fill="#1c1a16">${escapeXml(input.title ?? 'Chart')}</text>`,
    `<line x1="${padding.left}" y1="${zeroY}" x2="${width - padding.right}" y2="${zeroY}" stroke="#1c1a16" stroke-opacity="0.35"/>`,
  ]
  if (input.chartType === 'line') {
    const step = values.length > 1 ? plotWidth / (values.length - 1) : 0
    const points = values.map((value, index) => `${padding.left + step * index},${y(value)}`).join(' ')
    parts.push(`<polyline points="${points}" fill="none" stroke="#b03a2e" stroke-width="2"/>`)
    for (const [index, value] of values.entries()) {
      parts.push(
        `<circle cx="${padding.left + step * index}" cy="${y(value)}" r="3" fill="#b03a2e"/>`,
        `<text x="${padding.left + step * index}" y="${height - padding.bottom + 16}" text-anchor="middle" font-size="10" fill="#1c1a16">${escapeXml(labels[index] ?? '')}</text>`,
      )
    }
  } else {
    const slot = plotWidth / values.length
    const barWidth = Math.max(4, slot * 0.6)
    for (const [index, value] of values.entries()) {
      const x = padding.left + slot * index + (slot - barWidth) / 2
      const top = Math.min(y(value), zeroY)
      const barHeight = Math.max(1, Math.abs(zeroY - y(value)))
      parts.push(
        `<rect x="${x}" y="${top}" width="${barWidth}" height="${barHeight}" fill="#3f5f7f" fill-opacity="0.85"/>`,
        `<text x="${x + barWidth / 2}" y="${height - padding.bottom + 16}" text-anchor="middle" font-size="10" fill="#1c1a16">${escapeXml(labels[index] ?? '')}</text>`,
        `<text x="${x + barWidth / 2}" y="${top - 4}" text-anchor="middle" font-size="9" fill="#1c1a16">${value}</text>`,
      )
    }
  }
  parts.push('</svg>')
  return parts.join('\n')
}

async function assertWritableOutput(output: string): Promise<void> {
  const exists = await fs
    .access(output)
    .then(() => true)
    .catch(() => false)
  if (exists) throw new Error(`Output already exists; refusing to overwrite: ${output}`)
  await fs.mkdir(path.dirname(output), { recursive: true })
}

export const spreadsheet = tool({
  description:
    'Work with local .xlsx files. Actions: "read" returns up to 100 rows × 50 columns (optional range like ' +
    '"A1:F50"); "query" filters rows and optionally groups/aggregates (count/sum/avg/min/max); "write" sets a ' +
    'cell range or appends rows (write permission required); "chart" renders a bar or line SVG from explicit ' +
    'labels and values. All processing is local; nothing is uploaded.',
  inputSchema,
  execute: async (input, { toolCallId, abortSignal }) => {
    try {
      abortSignal?.throwIfAborted()

      if (input.action === 'chart') {
        if (!input.output) throw new Error('chart needs an output path.')
        const output = path.resolve(input.output)
        await assertWritableOutput(output)
        reportProgress(toolCallId, 'Rendering chart')
        await fs.writeFile(output, renderChartSvg(input))
        return `Chart written to ${output}`
      }

      if (!input.filePath) throw new Error(`${input.action} needs a filePath.`)
      const filePath = path.resolve(input.filePath)

      if (input.action === 'read') {
        reportProgress(toolCallId, `Reading ${path.basename(filePath)}`)
        const workbook = await loadWorkbook(filePath)
        const table = readTable(selectSheet(workbook, input.sheet), input)
        return JSON.stringify(table, null, 2)
      }

      if (input.action === 'query') {
        reportProgress(toolCallId, `Querying ${path.basename(filePath)}`)
        const workbook = await loadWorkbook(filePath)
        const table = readTable(selectSheet(workbook, input.sheet), input)
        let rows = table.rows
        for (const filter of input.filters ?? []) {
          abortSignal?.throwIfAborted()
          const index = resolveColumn(filter.column, table.headers)
          rows = rows.filter((row) => matches(row[index] ?? null, filter.op, filter.value))
        }

        let output: Array<Record<string, Cell>> = []
        if (input.groupBy !== undefined) {
          const groupIndex = resolveColumn(input.groupBy, table.headers)
          const groups = new Map<string, Cell[][]>()
          for (const row of rows) {
            const key = String(row[groupIndex] ?? '')
            const bucket = groups.get(key)
            if (bucket) bucket.push(row)
            else groups.set(key, [row])
          }
          const aggregates = input.aggregates?.length ? input.aggregates : [{ op: 'count' as const }]
          for (const [key, bucket] of groups) {
            const record: Record<string, Cell> = { [table.headers[groupIndex] ?? 'group']: key }
            for (const spec of aggregates) {
              const columnIndex = spec.column === undefined ? -1 : resolveColumn(spec.column, table.headers)
              const numbers =
                columnIndex >= 0
                  ? bucket
                      .map((row) => toNumber(row[columnIndex] ?? null))
                      .filter((value): value is number => value !== null)
                  : []
              const name = spec.as ?? `${spec.op}${columnIndex >= 0 ? `(${table.headers[columnIndex]})` : ''}`
              record[name] = aggregate(numbers, spec.op)
            }
            output.push(record)
          }
        } else {
          output = rows.map((row) => {
            const record: Record<string, Cell> = {}
            for (const [index, header] of table.headers.entries()) record[header] = row[index] ?? null
            return record
          })
        }

        if (input.sortBy !== undefined) {
          const key = table.headers[resolveColumn(input.sortBy, table.headers)] ?? ''
          output.sort((a, b) => {
            const left = a[key]
            const right = b[key]
            const leftNumber = toNumber(left)
            const rightNumber = toNumber(right)
            const compared =
              leftNumber !== null && rightNumber !== null
                ? leftNumber - rightNumber
                : String(left ?? '').localeCompare(String(right ?? ''))
            return input.descending ? -compared : compared
          })
        }
        const limit = Math.min(input.limit ?? 50, MAX_ROWS)
        return JSON.stringify(
          {
            sheet: table.sheet,
            matched: output.length,
            returned: Math.min(limit, output.length),
            rows: output.slice(0, limit),
          },
          null,
          2,
        )
      }

      if (!input.write) throw new Error('write needs a write payload.')
      const rows = input.write.rows
      if (rows.length === 0) throw new Error('write.rows is empty.')
      for (const row of rows) {
        if (row.length > MAX_COLUMNS) throw new Error(`A row exceeds the ${MAX_COLUMNS}-column limit.`)
      }
      reportProgress(toolCallId, `Writing ${rows.length} row(s) to ${path.basename(filePath)}`)
      const exists = await fs
        .access(filePath)
        .then(() => true)
        .catch(() => false)
      let workbook: ExcelJS.Workbook
      let sheet: ExcelJS.Worksheet
      if (exists) {
        workbook = await loadWorkbook(filePath)
        sheet = selectSheet(workbook, input.sheet)
      } else {
        workbook = new ExcelJS.Workbook()
        sheet = workbook.addWorksheet(input.sheet ?? 'Sheet1')
      }

      if (input.write.mode === 'append') {
        const startRow = Math.max(1, sheet.rowCount + 1)
        for (const [rowOffset, values] of rows.entries()) {
          const row = sheet.getRow(startRow + rowOffset)
          values.forEach((value, columnOffset) => {
            row.getCell(columnOffset + 1).value = value
          })
          row.commit()
        }
      } else {
        const start = parseCell(input.write.startCell ?? 'A1')
        for (const [rowOffset, values] of rows.entries()) {
          const row = sheet.getRow(start.row + rowOffset)
          values.forEach((value, columnOffset) => {
            row.getCell(start.col + columnOffset).value = value
          })
          row.commit()
        }
      }
      await workbook.xlsx.writeFile(filePath)
      return `Wrote ${rows.length} row(s) to ${filePath} (${input.write.mode}).`
    } catch (err) {
      return formatToolError('working with the spreadsheet', err)
    }
  },
})
