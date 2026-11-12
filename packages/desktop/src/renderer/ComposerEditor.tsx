// @x-code-cli/desktop — 富文本 composer
//
// 输入区改用 Tiptap：Markdown 语法在输入时直接变成格式（粗体、标题、列表、
// 引用、代码块等），发送时再序列化回 Markdown。@ 提及、/ 命令、快捷键和
// Enter 发送仍由 App 的键盘逻辑决定，这里只负责编辑与选区同步。
import { Markdown } from '@tiptap/markdown'
import { splitBlock } from '@tiptap/pm/commands'
import { splitListItem } from '@tiptap/pm/schema-list'
import { EditorContent, useEditor } from '@tiptap/react'
import { StarterKit } from '@tiptap/starter-kit'

import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

import type { MarkdownFormat } from './ComposerChrome.js'
import { isUiSmoke } from './ui-smoke.js'

export interface ComposerChange {
  /** 序列化后的 Markdown，发送和草稿都使用它。 */
  markdown: string
  /** 纯文本内容，供 @ 提及和 / 命令检测使用。 */
  text: string
  /** 光标在纯文本中的字符位置。 */
  caret: number
}

export interface ComposerEditorHandle {
  focus: () => void
  clear: () => void
  setMarkdown: (markdown: string, focusEnd?: boolean) => void
  /** 删除光标前 count 个字符并插入纯文本；caretFromEnd 让光标停在插入内容末尾之前。 */
  replaceBeforeCaret: (count: number, text: string, caretFromEnd?: number) => void
  toggleFormat: (kind: MarkdownFormat) => void
  isFormatActive: (kind: MarkdownFormat) => boolean
}

interface ComposerEditorProps {
  value: string
  placeholder: string
  editorRef: RefObject<ComposerEditorHandle | null>
  onChange: (change: ComposerChange) => void
  /** 返回 true 表示已经处理并阻止编辑器默认行为。 */
  onKeyDown: (event: KeyboardEvent) => boolean
}

function plainText(editor: NonNullable<ReturnType<typeof useEditor>>): string {
  return editor.getText({ blockSeparator: '\n' })
}

function caretIndex(editor: NonNullable<ReturnType<typeof useEditor>>): number {
  return editor.state.doc.textBetween(0, editor.state.selection.from, '\n').length
}

export function ComposerEditor({
  value,
  placeholder,
  editorRef,
  onChange,
  onKeyDown,
}: ComposerEditorProps): React.JSX.Element {
  const [empty, setEmpty] = useState(true)
  const onChangeRef = useRef(onChange)
  const onKeyDownRef = useRef(onKeyDown)

  useEffect(() => {
    onChangeRef.current = onChange
    onKeyDownRef.current = onKeyDown
  }, [onChange, onKeyDown])

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        dropcursor: false,
        gapcursor: false,
        trailingNode: false,
        horizontalRule: false,
        link: {
          openOnClick: false,
          autolink: true,
          HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
        },
      }),
      Markdown.configure({ indentation: { style: 'space', size: 2 } }),
    ],
    content: value,
    contentType: 'markdown',
    editorProps: {
      attributes: {
        class: 'composer-editor-input',
        'data-testid': 'composer-editor',
        role: 'textbox',
        'aria-multiline': 'true',
        spellcheck: 'true',
      },
      handleKeyDown: (view, event) => {
        // Shift+Enter 起新段落而不是软换行：这样下一行可以继续用 Markdown
        // 标题、列表、引用等块级语法。
        if (event.key === 'Enter' && event.shiftKey && !event.isComposing) {
          event.preventDefault()
          // 列表里换行应生成同级列表项，而不是在列表项内部再起段落。
          if (view.state.selection.$from.node(-1)?.type.name === 'listItem') {
            const listItem = view.state.schema.nodes.listItem
            if (listItem) splitListItem(listItem)(view.state, view.dispatch, view)
          } else {
            splitBlock(view.state, view.dispatch, view)
          }
          return true
        }
        const handled = onKeyDownRef.current(event)
        return handled || event.defaultPrevented
      },
    },
    onUpdate: ({ editor: current }) => {
      setEmpty(current.isEmpty)
      onChangeRef.current({
        markdown: current.getMarkdown(),
        text: plainText(current),
        caret: caretIndex(current),
      })
    },
    onSelectionUpdate: ({ editor: current }) => {
      setEmpty(current.isEmpty)
      onChangeRef.current({
        markdown: current.getMarkdown(),
        text: plainText(current),
        caret: caretIndex(current),
      })
    },
  })

  // 外部修改（语音转写、草稿恢复、编辑重发、命令插入）同步进编辑器；
  // 相等时跳过，避免和 onUpdate 形成回环。
  useEffect(() => {
    if (!editor) return
    if (editor.getMarkdown() === value) return
    editor.commands.setContent(value, { contentType: 'markdown', emitUpdate: false })
  }, [value, editor])

  useEffect(() => {
    if (!editor) {
      editorRef.current = null
      return
    }
    const handle: ComposerEditorHandle = {
      focus: () => {
        editor.commands.focus('end')
      },
      clear: () => {
        editor.commands.clearContent(true)
        editor.commands.focus('end')
      },
      setMarkdown: (markdown, focusEnd = true) => {
        editor.commands.setContent(markdown, { contentType: 'markdown', emitUpdate: true })
        if (focusEnd) editor.commands.focus('end')
      },
      replaceBeforeCaret: (count, text, caretFromEnd = 0) => {
        const to = editor.state.selection.from
        const from = Math.max(0, to - count)
        editor.chain().focus().deleteRange({ from, to }).insertContent({ type: 'text', text }).run()
        if (caretFromEnd > 0) {
          const end = editor.state.selection.from
          editor.commands.setTextSelection(Math.max(0, end - caretFromEnd))
        }
      },
      toggleFormat: (kind) => {
        const chain = editor.chain().focus()
        switch (kind) {
          case 'bold':
            chain.toggleBold().run()
            break
          case 'italic':
            chain.toggleItalic().run()
            break
          case 'code':
            chain.toggleCode().run()
            break
          case 'codeBlock':
            chain.toggleCodeBlock().run()
            break
          case 'list':
            chain.toggleBulletList().run()
            break
          case 'quote':
            chain.toggleBlockquote().run()
            break
          case 'link': {
            const { empty, from, to } = editor.state.selection
            const selected = editor.state.doc.textBetween(from, to, ' ')
            if (empty && !/^https?:\/\//i.test(selected)) {
              chain.insertContent([{ type: 'text', text: 'https://' }]).run()
              break
            }
            const href = /^https?:\/\//i.test(selected) ? selected : 'https://'
            chain.extendMarkRange('link').setLink({ href }).run()
            break
          }
        }
      },
      isFormatActive: (kind) => {
        switch (kind) {
          case 'bold':
            return editor.isActive('bold')
          case 'italic':
            return editor.isActive('italic')
          case 'code':
            return editor.isActive('code')
          case 'codeBlock':
            return editor.isActive('codeBlock')
          case 'list':
            return editor.isActive('bulletList')
          case 'quote':
            return editor.isActive('blockquote')
          case 'link':
            return editor.isActive('link')
        }
      },
    }
    editorRef.current = handle
    if (isUiSmoke) {
      ;(window as unknown as { __xcodeComposer?: unknown }).__xcodeComposer = editor
    }
    return () => {
      editorRef.current = null
    }
  }, [editor, editorRef])

  return (
    <div className={`composer-editor ${empty ? 'is-empty' : ''}`} data-placeholder={placeholder}>
      <EditorContent editor={editor} />
    </div>
  )
}
