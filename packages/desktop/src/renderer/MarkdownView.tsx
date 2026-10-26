import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'

import { memo, useState } from 'react'
import type { JSX, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import type { Components } from 'react-markdown'

interface HastNode {
  type?: string
  value?: string
  properties?: { className?: unknown }
  children?: HastNode[]
}

function hastText(node?: HastNode): string {
  if (!node) return ''
  if (node.type === 'text') return node.value ?? ''
  return (node.children ?? []).map(hastText).join('')
}

function codeLanguage(node?: HastNode): string {
  const className = node?.children?.[0]?.properties?.className
  if (!Array.isArray(className)) return ''
  const found = className.find((name) => typeof name === 'string' && name.startsWith('language-'))
  return typeof found === 'string' ? found.slice('language-'.length) : ''
}

export function CopyButton({ text, label = '复制' }: { text: string; label?: string }): JSX.Element {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="copy-btn"
      onClick={() => {
        window.xcode.copyText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      }}
    >
      {copied ? t('已复制') : t(label)}
    </button>
  )
}

function CodeBlock({ text, language, children }: { text: string; language: string; children: ReactNode }): JSX.Element {
  const { t } = useTranslation()
  const [wrap, setWrap] = useState(false)
  return (
    <div className={`code-block ${wrap ? 'wrap' : ''}`}>
      <div className="code-head">
        <span className="code-lang">{language || 'code'}</span>
        <button type="button" className="copy-btn" onClick={() => setWrap((value) => !value)}>
          {wrap ? t('不换行') : t('换行')}
        </button>
        <CopyButton text={text} />
      </div>
      <pre>{children}</pre>
    </div>
  )
}

const components: Components = {
  pre({ node, children }) {
    const text = hastText(node as HastNode | undefined)
    const language = codeLanguage(node as HastNode | undefined)
    return (
      <CodeBlock text={text} language={language}>
        {children}
      </CodeBlock>
    )
  },
  a({ href, children }) {
    return (
      <a
        href={href}
        onClick={(event) => {
          event.preventDefault()
          if (href?.startsWith('https://')) {
            void window.xcode.request({
              id: crypto.randomUUID(),
              method: 'app:open-external',
              params: { url: href },
            })
          }
        }}
      >
        {children}
      </a>
    )
  },
}

/** 渲染助手输出的 Markdown。代码块会加上语言标签和复制按钮；链接在系统
 *  浏览器中打开，而不是在沙箱窗口内导航。文本仍在流式输出时跳过语法高亮：
 *  对每个不完整的代码块重复高亮会让记录重排并抖动，最终渲染时再高亮一次。 */
export const MarkdownView = memo(function MarkdownView({
  text,
  streaming = false,
}: {
  text: string
  streaming?: boolean
}): JSX.Element {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={streaming ? [] : [[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        urlTransform={(url) => (url.startsWith('data:image/') ? url : defaultUrlTransform(url))}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})
