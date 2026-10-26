import { useMemo, useRef, useState } from 'react'
import {
  appendSnippet,
  clearManagedVars,
  CSS_DOC_INTRO,
  CSS_SELECTOR_DOCS,
  CSS_SNIPPETS,
  CSS_VAR_DOCS,
  readManagedVars,
  writeManagedVar,
} from '../lib/theme/cssGuide'

type Props = {
  value: string
  onChange: (next: string) => void
}

function toColorInput(value: string | undefined, fallback: string): string {
  const v = (value || fallback).trim()
  if (/^#[0-9a-fA-F]{6}$/.test(v)) return v
  if (/^#[0-9a-fA-F]{3}$/.test(v)) {
    const s = v.slice(1)
    return `#${s[0]}${s[0]}${s[1]}${s[1]}${s[2]}${s[2]}`
  }
  return /^#[0-9a-fA-F]{6}$/.test(fallback) ? fallback : '#007acc'
}

export function CustomCssPanel({ value, onChange }: Props) {
  const [docOpen, setDocOpen] = useState(true)
  const [docTab, setDocTab] = useState<'guide' | 'vars' | 'selectors'>('guide')
  const [copied, setCopied] = useState('')
  const [filter, setFilter] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const editorRef = useRef<HTMLTextAreaElement>(null)

  const managed = useMemo(() => readManagedVars(value), [value])
  const colorVars = CSS_VAR_DOCS.filter((v) => v.color)

  const filteredVars = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return CSS_VAR_DOCS
    return CSS_VAR_DOCS.filter(
      (v) =>
        v.name.toLowerCase().includes(q) ||
        v.desc.toLowerCase().includes(q),
    )
  }, [filter])

  const filteredSelectors = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return CSS_SELECTOR_DOCS
    return CSS_SELECTOR_DOCS.filter(
      (s) =>
        s.selector.toLowerCase().includes(q) ||
        s.desc.toLowerCase().includes(q),
    )
  }, [filter])

  const insertAtCursor = (text: string) => {
    const el = editorRef.current
    if (!el) {
      onChange(appendSnippet(value, text))
      return
    }
    const start = el.selectionStart
    const end = el.selectionEnd
    const next = value.slice(0, start) + text + value.slice(end)
    onChange(next)
    requestAnimationFrame(() => {
      el.focus()
      const pos = start + text.length
      el.setSelectionRange(pos, pos)
    })
  }

  const copyText = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(key)
      window.setTimeout(() => setCopied(''), 1200)
    } catch {
      /* ignore */
    }
  }

  const exportCss = () => {
    const blob = new Blob([value || ''], { type: 'text/css;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'pdfview-custom.css'
    a.click()
    URL.revokeObjectURL(url)
  }

  const importCss = async (file: File) => {
    const text = await file.text()
    onChange(text)
  }

  return (
    <div className="css-panel">
      <div className="obs-setting-group">
        <div className="obs-setting-item">
          <div className="obs-setting-info">
            <div className="obs-setting-name">自定义样式</div>
            <div className="obs-setting-desc">
              修改即时生效并自动保存。可用下方快速调色、片段与说明文档。
            </div>
          </div>
          <div className="obs-setting-control css-toolbar">
            <button type="button" className="obs-btn" onClick={exportCss} disabled={!value.trim()}>
              导出
            </button>
            <button type="button" className="obs-btn" onClick={() => fileRef.current?.click()}>
              导入
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".css,text/css,text/plain"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void importCss(f)
                e.target.value = ''
              }}
            />
            <button
              type="button"
              className="obs-btn"
              disabled={!value.trim()}
              onClick={() => onChange('')}
            >
              全部清空
            </button>
          </div>
        </div>
      </div>

      <h3 className="obs-section-heading">快速调色</h3>
      <div className="obs-setting-group">
        <div className="css-color-grid">
          {colorVars.map((v) => {
            const current = managed[v.name]
            const colorValue = toColorInput(current, v.sample)
            return (
              <label key={v.name} className="css-color-item" title={v.desc}>
                <input
                  type="color"
                  value={colorValue}
                  onChange={(e) => onChange(writeManagedVar(value, v.name, e.target.value))}
                />
                <span className="css-color-meta">
                  <span className="css-color-name">{v.name}</span>
                  <span className="css-color-desc">{v.desc}</span>
                </span>
              </label>
            )
          })}
        </div>
        {Object.keys(managed).length > 0 ? (
          <div className="css-color-actions">
            <button
              type="button"
              className="obs-btn"
              onClick={() => onChange(clearManagedVars(value))}
            >
              清除快速调色块
            </button>
          </div>
        ) : null}
      </div>

      <h3 className="obs-section-heading">示例片段</h3>
      <div className="css-snippet-list">
        {CSS_SNIPPETS.map((s) => (
          <div key={s.id} className="css-snippet-card">
            <div className="css-snippet-head">
              <strong>{s.title}</strong>
              <span>{s.desc}</span>
            </div>
            <div className="css-snippet-actions">
              <button
                type="button"
                className="obs-btn"
                onClick={() => onChange(appendSnippet(value, s.code))}
              >
                追加
              </button>
              <button
                type="button"
                className="obs-btn"
                onClick={() => onChange(s.code)}
              >
                替换全部
              </button>
              <button
                type="button"
                className="obs-btn"
                onClick={() => void copyText(s.code, s.id)}
              >
                {copied === s.id ? '已复制' : '复制'}
              </button>
            </div>
          </div>
        ))}
      </div>

      <h3 className="obs-section-heading">CSS 编辑器</h3>
      <div className="obs-setting-group">
        <div className="obs-css-block">
          <textarea
            ref={editorRef}
            className="obs-css-editor"
            spellCheck={false}
            rows={16}
            placeholder={`:root {\n  --accent: #c586c0;\n  --sidebar-width: 320px;\n}\n.toolbar {\n  border-bottom: 2px solid var(--accent);\n}`}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Tab') {
                e.preventDefault()
                insertAtCursor('  ')
              }
            }}
          />
        </div>
      </div>

      <h3 className="obs-section-heading">
        <button
          type="button"
          className="css-doc-toggle"
          onClick={() => setDocOpen((v) => !v)}
        >
          说明文档 {docOpen ? '▾' : '▸'}
        </button>
      </h3>

      {docOpen ? (
        <div className="css-doc">
          <div className="css-doc-tabs">
            <button
              type="button"
              className={`obs-btn${docTab === 'guide' ? ' is-active' : ''}`}
              onClick={() => setDocTab('guide')}
            >
              用法
            </button>
            <button
              type="button"
              className={`obs-btn${docTab === 'vars' ? ' is-active' : ''}`}
              onClick={() => setDocTab('vars')}
            >
              变量表
            </button>
            <button
              type="button"
              className={`obs-btn${docTab === 'selectors' ? ' is-active' : ''}`}
              onClick={() => setDocTab('selectors')}
            >
              选择器
            </button>
            {(docTab === 'vars' || docTab === 'selectors') && (
              <input
                className="css-doc-filter"
                type="search"
                placeholder="筛选…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            )}
          </div>

          {docTab === 'guide' && (
            <pre className="css-doc-intro">{CSS_DOC_INTRO}</pre>
          )}

          {docTab === 'vars' && (
            <div className="css-doc-table">
              {filteredVars.map((v) => (
                <div key={v.name} className="css-doc-row">
                  <div className="css-doc-row-main">
                    <code>{v.name}</code>
                    <span>{v.desc}</span>
                    <span className="css-doc-sample">例：{v.sample}</span>
                  </div>
                  <div className="css-doc-row-actions">
                    <button
                      type="button"
                      className="obs-btn tiny"
                      onClick={() => insertAtCursor(`${v.name}: ${v.sample};`)}
                    >
                      插入
                    </button>
                    <button
                      type="button"
                      className="obs-btn tiny"
                      onClick={() =>
                        onChange(writeManagedVar(value, v.name, managed[v.name] || v.sample))
                      }
                    >
                      写入调色块
                    </button>
                    <button
                      type="button"
                      className="obs-btn tiny"
                      onClick={() => void copyText(v.name, v.name)}
                    >
                      {copied === v.name ? '已复制' : '复制名'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {docTab === 'selectors' && (
            <div className="css-doc-table">
              {filteredSelectors.map((s) => (
                <div key={s.selector} className="css-doc-row">
                  <div className="css-doc-row-main">
                    <code>{s.selector}</code>
                    <span>{s.desc}</span>
                  </div>
                  <div className="css-doc-row-actions">
                    <button
                      type="button"
                      className="obs-btn tiny"
                      onClick={() =>
                        insertAtCursor(
                          `${s.selector.split(' / ')[0]} {\n  \n}\n`,
                        )
                      }
                    >
                      插入规则
                    </button>
                    <button
                      type="button"
                      className="obs-btn tiny"
                      onClick={() => void copyText(s.selector, s.selector)}
                    >
                      {copied === s.selector ? '已复制' : '复制'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}
