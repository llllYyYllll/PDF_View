import type { Highlight, IndexRow, OutlineItem, PageAnnotation } from '../lib/pdf/types'

type Tab = 'outline' | 'index'

type Props = {
  open: boolean
  tab: Tab
  onTab: (t: Tab) => void
  outline: OutlineItem[]
  indexRows: IndexRow[]
  highlights: Highlight[]
  pageAnnotations: PageAnnotation[]
  onGotoPage: (pageIndex: number) => void
  onEditHighlightNote: (id: string) => void
  onRemoveHighlight: (id: string) => void
  onEditPageNote: (id: string) => void
  onRemovePageNote: (id: string) => void
  scannedHint: boolean
}

export function Sidebar({
  open,
  tab,
  onTab,
  outline,
  indexRows,
  onGotoPage,
  onEditHighlightNote,
  onRemoveHighlight,
  onEditPageNote,
  onRemovePageNote,
  scannedHint,
}: Props) {
  if (!open) return null

  return (
    <aside className="sidebar">
      <div className="sidebar-tabs tabs-2">
        <button
          type="button"
          className={tab === 'outline' ? 'tab active' : 'tab'}
          onClick={() => onTab('outline')}
        >
          目录
        </button>
        <button
          type="button"
          className={tab === 'index' ? 'tab active' : 'tab'}
          onClick={() => onTab('index')}
        >
          三向索引
        </button>
      </div>

      <div className="sidebar-body">
        {tab === 'outline' && (
          <div className="outline-tree">
            {outline.length === 0 ? (
              <div className="empty">
                <p>暂无目录。</p>
                <p className="hint">
                  {scannedHint
                    ? '扫描件请用「OCR全书」识别文字并自动生成目录。'
                    : '内嵌目录为空时，也可 OCR 后生成目录。'}
                </p>
              </div>
            ) : (
              <OutlineNodes items={outline} depth={0} onGotoPage={onGotoPage} />
            )}
          </div>
        )}

        {tab === 'index' && (
          <ul className="simple-list index-list">
            {indexRows.length === 0 && (
              <li className="empty">拖选文字高亮，或点「页批注」添加批注后，将出现在此索引。</li>
            )}
            {indexRows.map((row) => (
              <li key={row.id} className="index-row">
                <button type="button" className="linkish" onClick={() => onGotoPage(row.pageIndex)}>
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
                        onClick={() => onEditPageNote(row.annotationId!)}
                      >
                        改
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

function OutlineNodes({
  items,
  depth,
  onGotoPage,
}: {
  items: OutlineItem[]
  depth: number
  onGotoPage: (pageIndex: number) => void
}) {
  return (
    <ul className="outline-nodes" style={{ paddingLeft: depth ? 12 : 0 }}>
      {items.map((item, i) => (
        <li key={`${item.title}-${i}`}>
          <button
            type="button"
            className="linkish"
            disabled={item.pageIndex === null}
            onClick={() => item.pageIndex !== null && onGotoPage(item.pageIndex)}
          >
            {item.title}
            {item.pageIndex !== null && <span className="muted"> · {item.pageIndex + 1}</span>}
          </button>
          {item.items.length > 0 && (
            <OutlineNodes items={item.items} depth={depth + 1} onGotoPage={onGotoPage} />
          )}
        </li>
      ))}
    </ul>
  )
}
