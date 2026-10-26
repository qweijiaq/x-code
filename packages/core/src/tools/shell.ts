// @x-code-cli/core — shell 工具（跨平台命令执行，无 execute —— 需要权限检查）
import { tool } from 'ai'

import { z } from 'zod'

export const shell = tool({
  description: `Execute a shell command and return stdout/stderr. Commands that are still running after the initial wait automatically continue as background shell sessions.

Use glob, grep, listDir, readFile, edit, and writeFile for their matching file operations. Use shell when no dedicated tool fits.

Instructions:
- Before a shell command creates files or directories, verify the parent with listDir.
- Write deliverables the user will keep (reports, transcripts, exports, generated media) inside the working directory. Use the system temp directory only for disposable intermediates and delete them when the task is done.
- Always quote file paths that contain spaces with double quotes.
- Run independent commands in separate parallel tool calls; chain dependent commands using syntax valid for the current shell.
- For git commands: prefer creating a new commit rather than amending. Never skip hooks (--no-verify) unless the user explicitly asks. Before running destructive operations (git reset --hard, git push --force), consider safer alternatives.
- The default initial wait is 10 seconds. If the command is still running, the result includes a shell id; read new output with shellOutput or stop it with killShell.
- When output is truncated, the complete output is saved to a temporary log. Use readFile with the returned path and offset/limit to inspect it.
- Set tty: true for interactive programs. Continue the terminal with shellOutput chars, including terminal control input such as Ctrl+C.
- Set yieldTimeMs: 0 for an immediate background result. timeout is an optional hard runtime limit.`,
  inputSchema: z.object({
    command: z.string().describe('The command to execute'),
    timeout: z
      .number()
      .int()
      .positive()
      .max(2_147_483_647)
      .optional()
      .describe('Optional hard runtime limit in milliseconds. Omit for no hard timeout.'),
    yieldTimeMs: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Initial wait in milliseconds before returning a running shell id (default: 10000; 0: immediate).'),
    cwd: z.string().optional().describe('Working directory, resolved relative to the session project directory.'),
    maxOutputTokens: z.number().int().positive().optional().describe('Optional model-facing output budget in tokens.'),
    tty: z
      .boolean()
      .optional()
      .describe('Run the command in a PTY/ConPTY so it can accept interactive terminal input.'),
    runInBackground: z
      .boolean()
      .optional()
      .describe('Legacy compatibility flag. When true and yieldTimeMs is omitted, return a shell id immediately.'),
  }),
  // 无 execute —— 在 agent loop 里手动处理：权限检查 + 跨平台 shell + 流式输出
})
