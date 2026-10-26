import { useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import { useI18n } from '../lib/i18n/I18nContext'

const REMARK_PLUGINS = [remarkGfm, remarkMath]
const REHYPE_PLUGINS = [rehypeKatex]

type Props = {
  content: string
  onGotoPage?: (pageIndex: number) => void
  className?: string
}

/** 把 [p12] 变成可点击的页码引用；代码块与行内代码中的内容保持原样 */
function withCitationLinks(content: string): string {
  return content
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part.replace(/(?<!\[)\[p(\d{1,5})\](?!\()/g, '[[p$1]](#page-$1)'),
    )
    .join('')
}

export function MarkdownMessage({ content, onGotoPage, className }: Props) {
  const { t } = useI18n()
  const source = useMemo(() => withCitationLinks(content), [content])

  return (
    <div className={`ai-md${className ? ` ${className}` : ''}`}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={{
          a: (props) => {
            const href = props.href || ''
            if (href.startsWith('#page-')) {
              const page = Number(href.slice(6))
              const valid = Number.isInteger(page) && page >= 1
              return (
                <a
                  className="ai-cite"
                  href={href}
                  title={valid ? t('ai.citeJump', { page }) : undefined}
                  onClick={(e) => {
                    e.preventDefault()
                    if (valid && onGotoPage) onGotoPage(page - 1)
                  }}
                >
                  {props.children}
                </a>
              )
            }
            return (
              <a
                href={href}
                target="_blank"
                rel="noreferrer noopener"
                onClick={(e) => {
                  if (!href.startsWith('http')) return
                  e.preventDefault()
                  window.open(href, '_blank', 'noopener,noreferrer')
                }}
              >
                {props.children}
              </a>
            )
          },
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  )
}
