// @x-code-cli/desktop — composer 键盘逻辑
//
// mention / slash 菜单、Markdown 快捷键和发送键的判定都集中在这里。App 只负责
// 提供状态和动作，ComposerBox 只负责渲染 textarea。
import type { Dispatch, RefObject, SetStateAction } from 'react'
import { useTranslation } from 'react-i18next'

import type { CustomCommandView, WorkspaceFileItem } from '../shared/protocol.js'
import type { MarkdownFormat } from './ComposerChrome.js'
import { isImeEnter, isImeEvent } from './ime.js'
import type { SlashCommand } from './slash-commands.js'

export interface ComposerKeyDownOptions {
  mention: { atIdx: number; query: string; tokenEnd: number } | null
  mentionItems: WorkspaceFileItem[]
  mentionIndex: number
  setMention: Dispatch<SetStateAction<{ atIdx: number; query: string; tokenEnd: number } | null>>
  setMentionIndex: Dispatch<SetStateAction<number>>
  dismissedMentionRef: RefObject<{ atIdx: number; query: string } | null>
  pickMention: (file: WorkspaceFileItem) => void
  paletteCommands: SlashCommand[]
  paletteIndex: number
  setPaletteIndex: Dispatch<SetStateAction<number>>
  setInput: Dispatch<SetStateAction<string>>
  runSlashCommand: (command: SlashCommand) => void
  applyMarkdown: (kind: MarkdownFormat) => void
  input: string
  exportCurrentSession: (format: 'markdown' | 'json' | 'pdf') => Promise<void>
  customCommands: CustomCommandView[]
  runCustomCommand: (name: string, args: string) => Promise<void>
  append: (message: { role: 'system'; text: string }) => void
  attachments: string[]
  submit: (prompt: string) => Promise<unknown>
}

export function useComposerKeyDown(
  options: ComposerKeyDownOptions,
): (event: React.KeyboardEvent<HTMLTextAreaElement>) => void {
  const { t } = useTranslation()
  const {
    mention,
    mentionItems,
    mentionIndex,
    setMention,
    setMentionIndex,
    dismissedMentionRef,
    pickMention,
    paletteCommands,
    paletteIndex,
    setPaletteIndex,
    setInput,
    runSlashCommand,
    applyMarkdown,
    input,
    exportCurrentSession,
    customCommands,
    runCustomCommand,
    append,
    attachments,
    submit,
  } = options
  return (event) => {
    // 组词期间的候选确认键（Enter / 方向键）不能被当作发送或菜单确认。
    if (isImeEvent(event)) return
    // 部分输入法会先结束组词再派发确认键，保留一个很短的宽限窗口。
    if (event.key === 'Enter' && !event.shiftKey && isImeEnter(event)) {
      event.preventDefault()
      return
    }
    if (mention !== null && mentionItems.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setMentionIndex((index) => (index + 1) % mentionItems.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setMentionIndex((index) => (index - 1 + mentionItems.length) % mentionItems.length)
        return
      }
      if (event.key === 'Tab' || event.key === 'Enter') {
        event.preventDefault()
        const picked = mentionItems[mentionIndex]
        if (picked) pickMention(picked)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        dismissedMentionRef.current = { atIdx: mention.atIdx, query: mention.query }
        setMention(null)
        return
      }
    }
    if (paletteCommands.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setPaletteIndex((index) => (index + 1) % paletteCommands.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setPaletteIndex((index) => (index - 1 + paletteCommands.length) % paletteCommands.length)
        return
      }
      if (event.key === 'Tab') {
        event.preventDefault()
        const command = paletteCommands[paletteIndex]
        if (command) setInput(command.name)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setInput('')
        return
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        const command = paletteCommands[paletteIndex]
        if (command) runSlashCommand(command)
        return
      }
    }
    if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey) {
      const key = event.key.toLowerCase()
      if (key === 'b') {
        event.preventDefault()
        applyMarkdown('bold')
        return
      }
      if (key === 'i') {
        event.preventDefault()
        applyMarkdown('italic')
        return
      }
      if (key === 'e') {
        event.preventDefault()
        applyMarkdown('code')
        return
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      if (input.startsWith('/')) {
        const match = input.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/)
        const name = match?.[1]
        if (name === 'export') {
          const format = (match?.[2] ?? '').trim().toLowerCase()
          setInput('')
          void exportCurrentSession(format === 'json' ? 'json' : format === 'pdf' ? 'pdf' : 'markdown')
          return
        }
        if (name && customCommands.some((command) => command.name === name)) {
          setInput('')
          void runCustomCommand(name, (match?.[2] ?? '').trim())
          return
        }
        append({
          role: 'system',
          text: t('未知命令：{{command}}（输入 /help 查看命令）', { command: input.trim() }),
        })
        setInput('')
        return
      }
      if (!input.trim() && attachments.length === 0) return
      const prompt = input
      setInput('')
      void submit(prompt)
    }
  }
}
