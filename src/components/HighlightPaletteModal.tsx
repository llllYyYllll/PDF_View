import { useState } from 'react'
import type { HighlightPaletteItem } from '../lib/pdf/types'

type Props = {
  open: boolean
  items: HighlightPaletteItem[]
  onClose: () => void
  onChange: (items: HighlightPaletteItem[]) => void
  onResetDefaults: () => void
}

export function HighlightPaletteModal({
  open,
  items,
  onClose,
  onChange,
  onResetDefaults,
}: Props) {
  const [draftColor, setDraftColor] = useState('#ffe566')
  const [draftLabel, setDraftLabel] = useState('')

  if (!open) return null

  const addItem = () => {
    const label = draftLabel.trim()
    if (!label) return
    const color = draftColor.length === 7 ? draftColor : '#ffe566'
    if (items.some((x) => x.color.toLowerCase() === color.toLowerCase())) {
      window.alert('该颜色已存在，请修改颜色或编辑已有项。')
      return
    }
    onChange([
      ...items,
      { id: crypto.randomUUID(), color, label },
    ])
    setDraftLabel('')
  }

  const updateItem = (id: string, patch: Partial<HighlightPaletteItem>) => {
    onChange(items.map((x) => (x.id === id ? { ...x, ...patch } : x)))
  }

  const removeItem = (id: string) => {
    onChange(items.filter((x) => x.id !== id))
  }

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal palette-modal"
        role="dialog"
        aria-labelledby="hl-palette-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="hl-palette-title">高亮颜色与含义</h2>
        <p className="muted" style={{ margin: '0 0 8px', fontSize: '0.9rem' }}>
          已内置常用颜色与含义，可修改、删除或继续添加。选中文字高亮时将使用这些选项。
        </p>

        <ul className="palette-list">
          {items.length === 0 && (
            <li className="empty">色板为空，可在下方添加，或恢复默认色板。</li>
          )}
          {items.map((item) => (
            <li key={item.id} className="palette-row">
              <label className="palette-swatch" title="颜色">
                <input
                  type="color"
                  value={item.color.slice(0, 7)}
                  onChange={(e) => updateItem(item.id, { color: e.target.value })}
                />
              </label>
              <input
                className="palette-label-input"
                type="text"
                value={item.label}
                placeholder="含义，如：重点、疑问"
                onChange={(e) => updateItem(item.id, { label: e.target.value })}
              />
              <button
                type="button"
                className="btn tiny"
                onClick={() => removeItem(item.id)}
                title="删除"
              >
                删
              </button>
            </li>
          ))}
        </ul>

        <div className="palette-add">
          <span className="palette-add-title">添加</span>
          <label className="palette-swatch" title="新颜色">
            <input
              type="color"
              value={draftColor}
              onChange={(e) => setDraftColor(e.target.value)}
            />
          </label>
          <input
            className="palette-label-input"
            type="text"
            value={draftLabel}
            placeholder="含义（必填）"
            onChange={(e) => setDraftLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addItem()
              }
            }}
          />
          <button
            type="button"
            className="btn tiny primary"
            disabled={!draftLabel.trim()}
            onClick={addItem}
          >
            添加
          </button>
        </div>

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onResetDefaults}>
            恢复默认
          </button>
          <button type="button" className="btn primary" onClick={onClose}>
            完成
          </button>
        </div>
      </div>
    </div>
  )
}
