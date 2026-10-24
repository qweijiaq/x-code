// Task modes: product-level framing for the agent, injected through
// AgentOptions.systemPromptExtra. Modes affect guidance only — there is no
// hard tool isolation, so any tool remains available in any mode.
export const TASK_MODES = ['coding', 'writing', 'research', 'office'] as const

export type TaskMode = (typeof TASK_MODES)[number]

export const DEFAULT_TASK_MODE: TaskMode = 'coding'

export function isTaskMode(value: unknown): value is TaskMode {
  return typeof value === 'string' && (TASK_MODES as readonly string[]).includes(value)
}

const MODE_INSTRUCTIONS: Record<TaskMode, string> = {
  coding: `## Task Mode: Coding
The user is working on software. Focus on correct, minimal, well-tested changes. Read the relevant code before
editing, prefer the edit tool over full rewrites, and run the project's checks when they exist. Keep explanations
short and tie them to the files you changed.`,
  writing: `## Task Mode: Writing
The user is drafting or editing prose. Prioritize structure, clarity, tone, and consistency with the user's voice.
Ask for the audience or goal when it materially changes the draft. Write the draft directly in the reply; use
readDocument for source material and documentExport when a PDF/DOCX file is requested. Do not turn prose work into
code work.`,
  research: `## Task Mode: Research
The user is researching a question. Ground claims in sources you actually read (readDocument, documentSearch,
webSearch/webFetch), keep page or section references for citations, separate evidence from inference, and state
uncertainty or missing data. Use the local document library for corpora already on this machine. Never invent
citations or numbers.`,
  office: `## Task Mode: Office
The user is preparing documents, spreadsheets, slides, or reports. Prefer readDocument, spreadsheet, convert, and
documentExport for local files; keep tables tidy and consistent. Confirm before overwriting files, bulk renames, or
clearing data, and produce summaries that are ready to paste into an email or slide.`,
}

export function taskModeInstruction(mode: TaskMode): string {
  return MODE_INSTRUCTIONS[mode]
}
