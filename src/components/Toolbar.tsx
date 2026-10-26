import { useI18n } from '../lib/i18n/I18nContext'

type Props = {
  fileName: string | null
  pageCount: number
  currentPage: number
  scale: number
  ocrBusy: boolean
  ocrModeLabel: string
  aiOpen: boolean
  sidebarOpen: boolean
  onPageInput: (page: number) => void
  onZoom: (scale: number) => void
  onToggleSidebar: () => void
  onOcrPage: () => void
  onOcrAll: () => void
  onAi: () => void
  onSettings: () => void
}

function IconSidebar() {
  return (
    <svg className="toolbar-icon" viewBox="0 0 16 16" aria-hidden>
      <path
        fill="currentColor"
        d="M2.5 2h11A1.5 1.5 0 0 1 15 3.5v9a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 12.5v-9A1.5 1.5 0 0 1 2.5 2zm0 1.2c-.16 0-.3.14-.3.3v9c0 .16.14.3.3.3H6V3.2H2.5zm4.7 0v9.6h6.3c.16 0 .3-.14.3-.3v-9c0-.16-.14-.3-.3-.3H7.2z"
      />
    </svg>
  )
}

function IconOcrPage() {
  return (
    <svg className="toolbar-icon" viewBox="0 0 16 16" aria-hidden>
      <path
        fill="currentColor"
        d="M3 1.5h7.5L14 5v9.5H3V1.5zm7 0v3.5H13.5M4.5 8h7v1h-7V8zm0 2.5h7v1h-7v-1zm0 2.5h4.5v1H4.5v-1z"
      />
    </svg>
  )
}

function IconOcrAll() {
  return (
    <svg className="toolbar-icon" viewBox="0 0 16 16" aria-hidden>
      <path
        fill="currentColor"
        d="M2 3h9v1.2H2V3zm0 2.5h9V6.7H2V5.5zm0 2.5h6V9.2H2V8zm11.2-5.2 1.3 1.3-5.4 5.4H7.8V8.2l5.4-5.4z"
      />
      <path
        fill="currentColor"
        opacity="0.65"
        d="M1 4.2h.9V13h8.8v.9H1V4.2z"
      />
    </svg>
  )
}

function IconAi() {
  return (
    <svg className="toolbar-icon" viewBox="0 0 16 16" aria-hidden>
      <path
        fill="currentColor"
        d="M8 1.5 9.2 5H13l-3 2.2L11.2 11 8 8.9 4.8 11l1.2-3.8L3 5h3.8L8 1.5zm0 9.2c2.2 0 4 1.1 4 2.4v.9H4v-.9c0-1.3 1.8-2.4 4-2.4z"
      />
    </svg>
  )
}

function IconSettings() {
  return (
    <svg className="toolbar-icon" viewBox="0 0 16 16" aria-hidden>
      <path
        fill="currentColor"
        d="M6.1 1.2h3.8l.3 1.5a5.2 5.2 0 0 1 1.2.7l1.5-.5 1.9 3.3-1.2 1a5.4 5.4 0 0 1 0 1.4l1.2 1-1.9 3.3-1.5-.5a5.2 5.2 0 0 1-1.2.7l-.3 1.5H6.1l-.3-1.5a5.2 5.2 0 0 1-1.2-.7l-1.5.5L1.2 9.9l1.2-1a5.4 5.4 0 0 1 0-1.4l-1.2-1 1.9-3.3 1.5.5a5.2 5.2 0 0 1 1.2-.7l.3-1.5zM8 5.6A2.4 2.4 0 1 0 8 10.4 2.4 2.4 0 0 0 8 5.6z"
      />
    </svg>
  )
}

export function Toolbar({
  fileName,
  pageCount,
  currentPage,
  scale,
  ocrBusy,
  ocrModeLabel,
  aiOpen,
  sidebarOpen,
  onPageInput,
  onZoom,
  onToggleSidebar,
  onOcrPage,
  onOcrAll,
  onAi,
  onSettings,
}: Props) {
  const { t } = useI18n()
  const sidebarTitle = sidebarOpen
    ? t('toolbar.sidebarHide')
    : t('toolbar.sidebarShow')

  return (
    <header className="toolbar">
      <div className="toolbar-group">
        <button
          type="button"
          className={`btn icon-btn${sidebarOpen ? ' is-active' : ''}`}
          onClick={onToggleSidebar}
          title={sidebarTitle}
          aria-label={sidebarTitle}
          aria-pressed={sidebarOpen}
        >
          <IconSidebar />
        </button>
        <span className="file-name" title={fileName || ''}>
          {fileName || t('app.noFile')}
        </span>
      </div>

      <div className="toolbar-group">
        <button
          type="button"
          className="btn"
          disabled={currentPage <= 0}
          onClick={() => onPageInput(currentPage - 1)}
        >
          {t('toolbar.prev')}
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
          {t('toolbar.next')}
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
        <button
          type="button"
          className="btn icon-btn"
          onClick={onOcrPage}
          disabled={ocrBusy || !fileName}
          title={
            ocrBusy
              ? t('toolbar.ocrBusy')
              : t('toolbar.ocrPageTitle', { mode: ocrModeLabel })
          }
          aria-label={t('toolbar.ocrPage')}
        >
          <IconOcrPage />
        </button>
        <button
          type="button"
          className="btn icon-btn"
          onClick={onOcrAll}
          disabled={ocrBusy || !fileName}
          title={
            ocrBusy
              ? t('toolbar.ocrBusy')
              : t('toolbar.ocrAllTitle', { mode: ocrModeLabel })
          }
          aria-label={t('toolbar.ocrAll')}
        >
          <IconOcrAll />
        </button>
        <button
          type="button"
          className={`btn icon-btn${aiOpen ? ' is-active' : ''}`}
          onClick={onAi}
          title={t('toolbar.ai')}
          aria-label={t('toolbar.ai')}
          aria-pressed={aiOpen}
        >
          <IconAi />
        </button>
        <button
          type="button"
          className="btn icon-btn"
          onClick={onSettings}
          title={t('toolbar.settings')}
          aria-label={t('toolbar.settings')}
        >
          <IconSettings />
        </button>
      </div>
    </header>
  )
}
