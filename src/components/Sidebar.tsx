import { useEffect, useRef, useState } from 'react'
import type { IndexRow } from '../lib/pdf/types'
import type { PageOutlineNode } from '../lib/index/pageOutline'
import { useI18n } from '../lib/i18n/I18nContext'

type Tab = 'outline' | 'index'

type Props = {
  open: boolean
  tab: Tab
  onTab: (t: Tab) => void
  pageOutline: PageOutlineNode[]
  indexRows: IndexRow[]
  onGotoPage: (pageIndex: number) => void
  onRenamePage: (pageIndex: number, title: string) => void
  onRenameHighlight: (id: string, title: string) => void
  onEditHighlightNote: (id: string) => void
  onRemoveHighlight: (id: string) => void
  onOpenPageNote: (id: string) => void
  onRemovePageNote: (id: string) => void
  scannedHint: boolean
  hasDocument: boolean
}

export function Sidebar({
  open,
  tab,
  onTab,
  pageOutline,
  indexRows,
  onGotoPage,
  onRenamePage,
  onRenameHighlight,
  onEditHighlightNote,
  onRemoveHighlight,
  onOpenPageNote,
  onRemovePageNote,
  scannedHint,
  hasDocument,
}: Props) {
  const { t } = useI18n()
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [renamingHighlightId, setRenamingHighlightId] = useState<string | null>(null)
  const [highlightRenameDraft, setHighlightRenameDraft] = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)
  const highlightRenameRef = useRef<HTMLInputElement>(null)
  const prevChildCount = useRef<Map<string, number>>(new Map())

  useEffect(() => {
    if (renamingId) renameInputRef.current?.focus()
  }, [renamingId])

  useEffect(() => {
    if (renamingHighlightId) highlightRenameRef.current?.focus()
  }, [renamingHighlightId])

  // 某页新出现子项时自动展开该文件夹；默认其余折叠
  useEffect(() => {
    setExpanded((prev) => {
      const next = new Set(prev)
      let changed = false
      const seen = new Set<string>()
      for (const page of pageOutline) {
        seen.add(page.id)
        const count = page.items.length
        const was = prevChildCount.current.get(page.id) ?? 0
        if (count > 0 && was === 0 && !next.has(page.id)) {
          next.add(page.id)
          changed = true
        }
        if (count === 0 && next.has(page.id)) {
          next.delete(page.id)
          changed = true
        }
        prevChildCount.current.set(page.id, count)
      }
      for (const id of [...prevChildCount.current.keys()]) {
        if (!seen.has(id)) prevChildCount.current.delete(id)
      }
      return changed ? next : prev
    })
  }, [pageOutline])

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const expandAll = () => {
    setExpanded(
      new Set(pageOutline.filter((p) => p.items.length > 0).map((p) => p.id)),
    )
  }

  const collapseAll = () => setExpanded(new Set())

  const foldableCount = pageOutline.filter((p) => p.items.length > 0).length

  return (
    <aside className={`sidebar${open ? '' : ' collapsed'}`} aria-hidden={!open}>
      <div className="sidebar-tabs tabs-2">
        <button
          type="button"
          className={tab === 'outline' ? 'tab active' : 'tab'}
          onClick={() => onTab('outline')}
        >
          {t('sidebar.outline')}
        </button>
        <button
          type="button"
          className={tab === 'index' ? 'tab active' : 'tab'}
          onClick={() => onTab('index')}
        >
          {t('sidebar.index')}
        </button>
      </div>

      <div className="sidebar-body">
        {tab === 'outline' && (
          <div className="outline-tree">
            {!hasDocument ? (
              <div className="empty">
                <p>{t('sidebar.openDoc')}</p>
              </div>
            ) : pageOutline.length === 0 ? (
              <div className="empty">
                <p>{t('sidebar.noOutline')}</p>
                <p className="hint">
                  {scannedHint ? t('sidebar.hint.scanned') : t('sidebar.hint.normal')}
                </p>
              </div>
            ) : (
              <>
                {foldableCount > 0 && (
                  <div className="outline-toolbar">
                    <button type="button" className="btn tiny" onClick={expandAll}>
                      {t('sidebar.expandAll')}
                    </button>
                    <button type="button" className="btn tiny" onClick={collapseAll}>
                      {t('sidebar.collapseAll')}
                    </button>
                  </div>
                )}
                <ul className="outline-nodes page-outline">
                  {pageOutline.map((page) => {
                    const hasKids = page.items.length > 0
                    const isOpen = hasKids && expanded.has(page.id)
                    const isRenaming = renamingId === page.id
                    const commitRename = () => {
                      onRenamePage(page.pageIndex, renameDraft.trim())
                      setRenamingId(null)
                    }
                    return (
                      <li
                        key={page.id}
                        className={`outline-page${isOpen ? ' open' : ''}${hasKids ? ' folder' : ''}`}
                      >
                        <div className="outline-page-row">
                          {isRenaming ? (
                            <div className="outline-page-title renaming">
                              {hasKids ? (
                                <span className="outline-twist" aria-hidden>
                                  {isOpen ? '▼' : '▶'}
                                </span>
                              ) : (
                                <span className="outline-twist spacer" aria-hidden />
                              )}
                              <span className="outline-page-num">{page.pageLabel}</span>
                              <input
                                ref={renameInputRef}
                                className="outline-rename-input"
                                value={renameDraft}
                                placeholder="页标题（不含页号）"
                                onChange={(e) => setRenameDraft(e.target.value)}
                                onBlur={commitRename}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    e.preventDefault()
                                    commitRename()
                                  } else if (e.key === 'Escape') {
                                    e.preventDefault()
                                    setRenamingId(null)
                                  }
                                }}
                                onClick={(e) => e.stopPropagation()}
                              />
                            </div>
                          ) : (
                            <button
                              type="button"
                              className="linkish outline-page-title"
                              aria-expanded={hasKids ? isOpen : undefined}
                              onClick={() => {
                                onGotoPage(page.pageIndex)
                                if (hasKids) toggle(page.id)
                              }}
                              onDoubleClick={(e) => {
                                e.preventDefault()
                                e.stopPropagation()
                                setRenamingId(page.id)
                                setRenameDraft(page.customTitle)
                              }}
                              title="单击跳转；双击重命名（不改页号）"
                            >
                              {hasKids ? (
                                <span className="outline-twist" aria-hidden>
                                  {isOpen ? '▼' : '▶'}
                                </span>
                              ) : (
                                <span className="outline-twist spacer" aria-hidden />
                              )}
                              <span className="outline-page-label">{page.title}</span>
                              {hasKids && (
                                <span className="muted outline-count">{page.items.length}</span>
                              )}
                            </button>
                          )}
                        </div>
                        {hasKids && isOpen && (
                          <ul className="outline-nodes outline-children">
                            {page.items.map((child) => {
                              const editingHl =
                                child.kind === 'highlight' &&
                                child.highlightId &&
                                renamingHighlightId === child.highlightId
                              const commitHlRename = () => {
                                if (!child.highlightId) return
                                onRenameHighlight(
                                  child.highlightId,
                                  highlightRenameDraft.trim(),
                                )
                                setRenamingHighlightId(null)
                              }
                              return (
                              <li key={child.id} className={`outline-child kind-${child.kind}`}>
                                {editingHl ? (
                                  <div className="outline-child-edit">
                                    <span
                                      className="child-tag hl"
                                      style={
                                        child.color
                                          ? { background: child.color }
                                          : undefined
                                      }
                                    >
                                      {child.colorLabel || '高亮'}
                                    </span>
                                    <input
                                      ref={highlightRenameRef}
                                      className="outline-rename-input child"
                                      value={highlightRenameDraft}
                                      placeholder={child.defaultTitle || '选中原文'}
                                      onChange={(e) =>
                                        setHighlightRenameDraft(e.target.value)
                                      }
                                      onBlur={commitHlRename}
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                          e.preventDefault()
                                          commitHlRename()
                                        } else if (e.key === 'Escape') {
                                          e.preventDefault()
                                          setRenamingHighlightId(null)
                                        }
                                      }}
                                      onClick={(e) => e.stopPropagation()}
                                    />
                                  </div>
                                ) : (
                                  <button
                                    type="button"
                                    className="linkish"
                                    onClick={() => {
                                      if (
                                        child.kind === 'page-note' &&
                                        child.annotationId
                                      ) {
                                        onOpenPageNote(child.annotationId)
                                        return
                                      }
                                      onGotoPage(child.pageIndex)
                                    }}
                                    onDoubleClick={(e) => {
                                      if (
                                        child.kind !== 'highlight' ||
                                        !child.highlightId
                                      ) {
                                        return
                                      }
                                      e.preventDefault()
                                      e.stopPropagation()
                                      setRenamingHighlightId(child.highlightId)
                                      setHighlightRenameDraft(
                                        child.customTitle ||
                                          child.defaultTitle ||
                                          '',
                                      )
                                    }}
                                    title={
                                      child.kind === 'page-note'
                                        ? t('pageNote.open')
                                        : child.kind === 'highlight'
                                          ? '单击跳转；双击修改目录显示（清空则恢复选中原文）'
                                          : child.title
                                    }
                                  >
                                    {child.kind === 'page-note' ? (
                                      <span className="child-tag note">批注</span>
                                    ) : (
                                      <span
                                        className="child-tag hl"
                                        style={
                                          child.color
                                            ? { background: child.color }
                                            : undefined
                                        }
                                        title={child.colorLabel || '高亮'}
                                      >
                                        {child.colorLabel || '高亮'}
                                      </span>
                                    )}
                                    <span className="child-text">{child.title}</span>
                                  </button>
                                )}
                              </li>
                              )
                            })}
                          </ul>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </>
            )}
          </div>
        )}

        {tab === 'index' && (
          <ul className="simple-list index-list">
            {indexRows.length === 0 && (
              <li className="empty">{t('sidebar.indexEmpty')}</li>
            )}
            {indexRows.map((row) => (
              <li key={row.id} className="index-row">
                <button
                  type="button"
                  className="linkish"
                  onClick={() => {
                    if (row.kind === 'page-note' && row.annotationId) {
                      onOpenPageNote(row.annotationId)
                      return
                    }
                    onGotoPage(row.pageIndex)
                  }}
                >
                  <div className="index-line">
                    <span className="index-page">p.{row.pageIndex + 1}</span>
                    {row.highlightText && (
                      <span className="index-hl" title={row.highlightText}>
                        高亮：{row.highlightText.slice(0, 36)}
                        {row.highlightText.length > 36 ? '…' : ''}
                      </span>
                    )}
                    {row.annotationText && (
                      <span className="index-note" title={row.annotationText}>
                        批注：{row.annotationText.slice(0, 36)}
                        {row.annotationText.length > 36 ? '…' : ''}
                      </span>
                    )}
                  </div>
                </button>
                <div className="index-actions">
                  {row.highlightId && (
                    <>
                      <button
                        type="button"
                        className="btn tiny"
                        onClick={() => onEditHighlightNote(row.highlightId!)}
                      >
                        注
                      </button>
                      <button
                        type="button"
                        className="btn tiny"
                        onClick={() => onRemoveHighlight(row.highlightId!)}
                      >
                        删高亮
                      </button>
                    </>
                  )}
                  {row.kind === 'page-note' && row.annotationId && (
                    <>
                      <button
                        type="button"
                        className="btn tiny"
                        onClick={() => onOpenPageNote(row.annotationId!)}
                      >
                        {t('pageNote.open')}
                      </button>
                      <button
                        type="button"
                        className="btn tiny"
                        onClick={() => onRemovePageNote(row.annotationId!)}
                      >
                        删批注
                      </button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  )
}
