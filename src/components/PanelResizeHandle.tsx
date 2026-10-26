import { useEffect, useRef } from 'react'

type Props = {
  /** e：拖右缘加宽左侧面板；w：拖左缘加宽右侧面板 */
  edge: 'e' | 'w'
  value: number
  min: number
  max: number
  onChange: (next: number) => void
  onCommit?: (next: number) => void
  label: string
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n))
}

/** 竖直分隔条：按住拖动调整相邻分区宽度 */
export function PanelResizeHandle({
  edge,
  value,
  min,
  max,
  onChange,
  onCommit,
  label,
}: Props) {
  const dragging = useRef(false)
  const startX = useRef(0)
  const startValue = useRef(value)
  const latest = useRef(value)
  latest.current = value

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!dragging.current) return
      const dx = e.clientX - startX.current
      const next = clamp(
        edge === 'e' ? startValue.current + dx : startValue.current - dx,
        min,
        max,
      )
      latest.current = next
      onChange(next)
    }
    const onUp = () => {
      if (!dragging.current) return
      dragging.current = false
      document.body.classList.remove('is-panel-resizing')
      onCommit?.(latest.current)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [edge, min, max, onChange, onCommit])

  return (
    <div
      className={`panel-resize-handle edge-${edge}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        dragging.current = true
        startX.current = e.clientX
        startValue.current = value
        latest.current = value
        document.body.classList.add('is-panel-resizing')
      }}
      onDoubleClick={() => {
        const fallback = edge === 'e' ? 260 : 420
        const next = clamp(fallback, min, max)
        onChange(next)
        onCommit?.(next)
      }}
    />
  )
}
