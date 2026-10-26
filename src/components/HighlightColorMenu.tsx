import { useEffect, useRef } from 'react'
import type {
  AiSelectionContext,
  AiTask,
  HighlightPaletteItem,
} from '../lib/pdf/types'
import { useI18n } from '../lib/i18n/I18nContext'

export type PendingHighlight = {
  pageIndex: number
  text: string
  rects: { x: number; y: number; width: number; height: number }[]
  clientX: number
  clientY: number
}

type Props = {
  pending: PendingHighlight
  palette: HighlightPaletteItem[]
  onPick: (item: HighlightPaletteItem) => void
  onCancel: () => void
  onManage: () => void
  onAiAsk: (task: AiTask, selection: AiSelectionContext) => void
}

export function HighlightColorMenu({
  pending,
  palette,
  onPick,
  onCancel,
  onManage,
  onAiAsk,
}: Props) {
  const { t } = useI18n()
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) onCancel()
    }
    window.addEventListener('keydown', onKey)
    const t = window.setTimeout(() => window.addEventListener('mousedown', onDown), 0)
    return () => {
      window.clearTimeout(t)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onDown)
    }
  }, [onCancel])

  const left = Math.min(Math.max(12, pending.clientX - 20), window.innerWidth - 280)
  const top = Math.min(Math.max(12, pending.clientY + 12), window.innerHeight - 300)
  const selection: AiSelectionContext = {
    text: pending.text,
    pageIndex: pending.pageIndex,
  }

  return (
    <div
      ref={rootRef}
      className="hl-color-menu vertical"
      style={{ left, top }}
      role="dialog"
      aria-label={t('highlight.menu.aria')}
    >
      <div className="hl-color-menu-head">
        <span className="hl-color-menu-label">{t('highlight.menu.title')}</span>
        <button type="button" className="btn tiny" onClick={onManage}>
          {t('highlight.menu.manage')}
        </button>
      </div>
      {palette.length === 0 ? (
        <p className="hl-color-empty">
          {t('highlight.menu.empty')}
          <button type="button" className="btn tiny primary" onClick={onManage}>
            {t('highlight.menu.manage')}
          </button>
        </p>
      ) : (
        <ul className="hl-color-options">
          {palette.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className="hl-color-option"
                onClick={() => onPick(item)}
                title={item.label}
              >
                <span className="hl-swatch" style={{ background: item.color }} />
                <span className="hl-color-option-label">{item.label}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="hl-color-menu-ai">
        <span className="hl-color-menu-label">{t('highlight.menu.ai')}</span>
        <div className="hl-ai-actions">
          <button
            type="button"
            className="btn tiny"
            disabled={!pending.text.trim()}
            onClick={() => onAiAsk('explain-selection', selection)}
          >
            {t('ai.quick.explain')}
          </button>
          <button
            type="button"
            className="btn tiny"
            disabled={!pending.text.trim()}
            onClick={() => onAiAsk('translate-selection', selection)}
          >
            {t('ai.quick.translate')}
          </button>
          <button
            type="button"
            className="btn tiny"
            disabled={!pending.text.trim()}
            onClick={() => onAiAsk('summarize-selection', selection)}
          >
            {t('ai.quick.summarizeSelection')}
          </button>
        </div>
      </div>
    </div>
  )
}
