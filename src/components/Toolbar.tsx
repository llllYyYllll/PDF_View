import type { OcrMode } from '../lib/pdf/types'

type Props = {
  fileName: string | null
  pageCount: number
  currentPage: number
  scale: number
  highlightColor: string
  ocrBusy: boolean
  ocrMode: OcrMode
  dirty: boolean
  onOpen: () => void
  onSave: () => void
  onPageInput: (page: number) => void
  onZoom: (scale: number) => void
  onToggleSidebar: () => void
  onHighlightColor: (c: string) => void
  onOcrPage: () => void
  onOcrAll: () => void
  onPageNote: () => void
  onOcrMode: (m: OcrMode) => void
  onOcrSettings: () => void
}

export function Toolbar({
  fileName,
  pageCount,
  currentPage,
  scale,
  highlightColor,
  ocrBusy,
  ocrMode,
  dirty,
  onOpen,
  onSave,
  onPageInput,
  onZoom,
  onToggleSidebar,
  onHighlightColor,
  onOcrPage,
  onOcrAll,
  onPageNote,
  onOcrMode,
  onOcrSettings,
}: Props) {
  return (
    <header className="toolbar">
      <div className="toolbar-group">
        <button type="button" className="btn" onClick={onToggleSidebar} title="侧栏">
          ☰
        </button>
        <button type="button" className="btn primary" onClick={onOpen}>
          打开
        </button>
        <button type="button" className="btn" onClick={onSave} disabled={!fileName}>
          保存{dirty ? ' *' : ''}
        </button>
        <span className="file-name" title={fileName || ''}>
          {fileName || '未打开文件'}
        </span>
      </div>

      <div className="toolbar-group">
        <button
          type="button"
          className="btn"
          disabled={currentPage <= 0}
          onClick={() => onPageInput(currentPage - 1)}
        >
          上页
        </button>
        <label className="page-input">
          <input
            type="number"
            min={1}
            max={Math.max(1, pageCount)}
            value={pageCount ? currentPage + 1 : 1}
            onChange={(e) => onPageInput(Math.max(0, Number(e.target.value) - 1))}
          />
          <span>/ {pageCount || '—'}</span>
        </label>
        <button
          type="button"
          className="btn"
          disabled={!pageCount || currentPage >= pageCount - 1}
          onClick={() => onPageInput(currentPage + 1)}
        >
          下页
        </button>
        <button type="button" className="btn" onClick={() => onZoom(Math.max(0.5, scale - 0.1))}>
          −
        </button>
        <span className="zoom-label">{Math.round(scale * 100)}%</span>
        <button type="button" className="btn" onClick={() => onZoom(Math.min(3, scale + 0.1))}>
          +
        </button>
      </div>

      <div className="toolbar-group">
        <label className="color-pick" title="高亮颜色">
          <input
            type="color"
            value={highlightColor}
            onChange={(e) => onHighlightColor(e.target.value)}
          />
        </label>
        <button type="button" className="btn" onClick={onPageNote} disabled={!fileName}>
          页批注
        </button>
        <select
          className="ocr-mode"
          value={ocrMode}
          onChange={(e) => onOcrMode(e.target.value as OcrMode)}
          title="OCR 模式"
        >
          <option value="offline">离线 OCR</option>
          <option value="online">联网 OCR</option>
        </select>
        <button type="button" className="btn" onClick={onOcrSettings} title="OCR 设置">
          OCR设置
        </button>
        <button type="button" className="btn" onClick={onOcrPage} disabled={ocrBusy || !fileName}>
          {ocrBusy ? 'OCR…' : 'OCR本页'}
        </button>
        <button type="button" className="btn" onClick={onOcrAll} disabled={ocrBusy || !fileName}>
          OCR全书
        </button>
      </div>
    </header>
  )
}
