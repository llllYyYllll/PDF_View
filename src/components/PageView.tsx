import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import { TextLayer } from 'pdfjs-dist'
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist'
import type { Highlight, OcrPageOverlay } from '../lib/pdf/types'

type Props = {
  pdf: PDFDocumentProxy
  pageIndex: number
  scale: number
  widthHint: number
  heightHint: number
  active: boolean
  highlights: Highlight[]
  ocrOverlay?: OcrPageOverlay
  highlightColor: string
  onTextSelected: (
    pageIndex: number,
    text: string,
    rects: Highlight['rects'],
    clientX: number,
    clientY: number,
  ) => void
  onUpdateHighlightNote: (id: string, note: string) => void
  onRemoveHighlight: (id: string) => void
}

type HlRect = Highlight['rects'][number]

/** 仅去掉「包住至少 2 个子框」的跨行大包围盒，保留每一行 */
function refineSelectionRects(rects: HlRect[]): HlRect[] {
  if (rects.length <= 1) return rects
  const filtered = rects.filter((a, i) => {
    let contained = 0
    for (let j = 0; j < rects.length; j++) {
      if (i === j) continue
      const b = rects[j]
      const wraps =
        a.x <= b.x + 0.75 &&
        a.y <= b.y + 0.75 &&
        a.x + a.width >= b.x + b.width - 0.75 &&
        a.y + a.height >= b.y + b.height - 0.75
      if (wraps) contained++
    }
    return contained < 2
  })
  return filtered.length ? filtered : rects
}

/** 合并同一行上几乎相连的碎框（不向未选中区域扩张） */
function mergeLineRects(rects: HlRect[]): HlRect[] {
  if (rects.length <= 1) return rects
  const sorted = [...rects].sort((a, b) => a.y - b.y || a.x - b.x)
  const lines: HlRect[] = []
  for (const r of sorted) {
    const line = lines.find((l) => {
      const sameRow = Math.abs(l.y - r.y) <= Math.max(l.height, r.height) * 0.45
      const gap = Math.max(l.height, r.height) * 0.35
      const closeX = r.x <= l.x + l.width + gap
      return sameRow && closeX
    })
    if (!line) {
      lines.push({ ...r })
      continue
    }
    const right = Math.max(line.x + line.width, r.x + r.width)
    const bottom = Math.max(line.y + line.height, r.y + r.height)
    line.x = Math.min(line.x, r.x)
    line.y = Math.min(line.y, r.y)
    line.width = right - line.x
    line.height = bottom - line.y
  }
  return lines
}

function pushUniqueDomRect(raw: DOMRect[], seen: Set<string>, r: DOMRect) {
  if (r.width < 1 || r.height < 1) return
  const key = `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`
  if (seen.has(key)) return
  seen.add(key)
  raw.push(r)
}

/**
 * 采集选区矩形：按文本节点与选区的交集取框，
 * 避免把仅部分选中的行/节点整段撑满。
 */
function collectRangeRects(
  range: Range,
  pageRect: DOMRect,
  scale: number,
): HlRect[] {
  const raw: DOMRect[] = []
  const seen = new Set<string>()

  const root = range.commonAncestorContainer
  const iterator = document.createNodeIterator(root, NodeFilter.SHOW_TEXT)
  let node = iterator.nextNode()
  while (node) {
    const textNode = node as Text
    node = iterator.nextNode()
    if (!textNode.data || !range.intersectsNode(textNode)) continue

    const sub = document.createRange()
    try {
      sub.selectNodeContents(textNode)
      if (textNode === range.startContainer) {
        sub.setStart(textNode, range.startOffset)
      }
      if (textNode === range.endContainer) {
        sub.setEnd(textNode, range.endOffset)
      }
      // 完全在选区外的节点（边界情况）跳过
      if (sub.compareBoundaryPoints(Range.END_TO_START, range) <= 0) continue
      if (sub.compareBoundaryPoints(Range.START_TO_END, range) >= 0) continue
    } catch {
      continue
    }

    for (const r of Array.from(sub.getClientRects())) {
      pushUniqueDomRect(raw, seen, r)
    }
  }

  // 仍为空时退回浏览器选区矩形
  if (raw.length === 0) {
    for (const r of Array.from(range.getClientRects())) {
      pushUniqueDomRect(raw, seen, r)
    }
  }

  const mapped = raw.map((r) => ({
    x: (r.left - pageRect.left) / scale,
    y: (r.top - pageRect.top) / scale,
    width: r.width / scale,
    height: r.height / scale,
  }))
  return mergeLineRects(refineSelectionRects(mapped))
}

function scaleRect(r: HlRect, scale: number) {
  return {
    left: r.x * scale,
    top: r.y * scale,
    width: r.width * scale,
    height: r.height * scale,
  }
}

export function PageView({
  pdf,
  pageIndex,
  scale,
  widthHint,
  heightHint,
  active,
  highlights,
  ocrOverlay,
  highlightColor,
  onTextSelected,
  onUpdateHighlightNote,
  onRemoveHighlight,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const cleanCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const textLayerRef = useRef<HTMLDivElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [bitmapEpoch, setBitmapEpoch] = useState(0)
  const renderTaskRef = useRef<RenderTask | null>(null)
  const pageRef = useRef<PDFPageProxy | null>(null)

  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  /** 当前悬停/打开的具体行框，避免多行合成大包围盒 */
  const [focusRectIndex, setFocusRectIndex] = useState(0)
  const [draftNote, setDraftNote] = useState('')
  const openIdRef = useRef<string | null>(null)
  const draftNoteRef = useRef('')
  openIdRef.current = openId
  draftNoteRef.current = draftNote

  // 撤销/重做后同步批注框内容
  useEffect(() => {
    if (!openId) return
    const h = highlights.find((x) => x.id === openId)
    if (!h) {
      setOpenId(null)
      setHoveredId(null)
      return
    }
    if (h.note !== draftNoteRef.current) {
      setDraftNote(h.note || '')
    }
  }, [highlights, openId])

  useEffect(() => {
    if (!active) {
      renderTaskRef.current?.cancel()
      renderTaskRef.current = null
      const canvas = canvasRef.current
      if (canvas) {
        const ctx = canvas.getContext('2d')
        ctx?.clearRect(0, 0, canvas.width, canvas.height)
        canvas.width = 0
        canvas.height = 0
      }
      if (cleanCanvasRef.current) {
        cleanCanvasRef.current.width = 0
        cleanCanvasRef.current.height = 0
      }
      if (textLayerRef.current) textLayerRef.current.innerHTML = ''
      return
    }

    let cancelled = false

    ;(async () => {
      try {
        setError(null)
        const page = await pdf.getPage(pageIndex + 1)
        if (cancelled) return
        pageRef.current = page
        const viewport = page.getViewport({ scale })
        const canvas = canvasRef.current
        const textLayerDiv = textLayerRef.current
        if (!canvas || !textLayerDiv) return

        const outputScale = window.devicePixelRatio || 1
        canvas.width = Math.floor(viewport.width * outputScale)
        canvas.height = Math.floor(viewport.height * outputScale)
        canvas.style.width = `${viewport.width}px`
        canvas.style.height = `${viewport.height}px`

        const ctx = canvas.getContext('2d')
        if (!ctx) return
        const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined

        renderTaskRef.current?.cancel()
        const task = page.render({
          canvasContext: ctx,
          viewport,
          canvas,
          transform,
        })
        renderTaskRef.current = task
        await task.promise
        if (cancelled) return

        // 缓存未加高亮的页面位图，后续用 canvas multiply 叠色（不挡字、不发灰）
        let clean = cleanCanvasRef.current
        if (!clean) {
          clean = document.createElement('canvas')
          cleanCanvasRef.current = clean
        }
        clean.width = canvas.width
        clean.height = canvas.height
        const cleanCtx = clean.getContext('2d')
        if (cleanCtx) {
          cleanCtx.clearRect(0, 0, clean.width, clean.height)
          cleanCtx.drawImage(canvas, 0, 0)
        }
        setBitmapEpoch((n) => n + 1)

        const textContent = await page.getTextContent()
        textLayerDiv.innerHTML = ''
        textLayerDiv.style.width = `${viewport.width}px`
        textLayerDiv.style.height = `${viewport.height}px`

        const textLayer = new TextLayer({
          textContentSource: textContent,
          container: textLayerDiv,
          viewport,
        })
        await textLayer.render()
      } catch (e) {
        if ((e as { name?: string })?.name === 'RenderingCancelledException') return
        setError(e instanceof Error ? e.message : String(e))
      }
    })()

    return () => {
      cancelled = true
      renderTaskRef.current?.cancel()
    }
  }, [pdf, pageIndex, scale, active])

  // 显示时只去掉跨行大包围盒，保留各行（并合并碎框）
  const preciseHighlights = useMemo(
    () =>
      highlights.map((h) => ({
        ...h,
        rects: mergeLineRects(refineSelectionRects(h.rects)),
      })),
    [highlights],
  )

  // 在干净位图上 multiply 绘制高亮：墨水保持深色，纸面着色（不依赖 CSS mix-blend）
  useEffect(() => {
    if (!active) return
    const canvas = canvasRef.current
    const clean = cleanCanvasRef.current
    if (!canvas || !clean || !clean.width || !clean.height) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const outputScale = window.devicePixelRatio || 1
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalCompositeOperation = 'source-over'
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(clean, 0, 0)

    ctx.globalCompositeOperation = 'multiply'
    for (const h of preciseHighlights) {
      ctx.fillStyle = (h.color || highlightColor).slice(0, 7)
      for (const r of h.rects) {
        ctx.fillRect(
          r.x * scale * outputScale,
          r.y * scale * outputScale,
          Math.max(1, r.width * scale * outputScale),
          Math.max(1, r.height * scale * outputScale),
        )
      }
    }
    ctx.globalCompositeOperation = 'source-over'
  }, [active, preciseHighlights, scale, highlightColor, bitmapEpoch])

  useEffect(() => {
    if (!openId) return
    const close = () => {
      const id = openIdRef.current
      if (id) onUpdateHighlightNote(id, draftNoteRef.current)
      setOpenId(null)
      setHoveredId(null)
    }
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (popoverRef.current?.contains(t)) return
      if ((t as HTMLElement).closest?.(`[data-hl-id="${openId}"]`)) return
      close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        close()
        return
      }
      // 批注输入框内 Backspace 用于编辑文字，不删高亮
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable)) {
        return
      }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault()
        const id = openIdRef.current
        if (!id) return
        setOpenId(null)
        setHoveredId(null)
        onRemoveHighlight(id)
      }
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [openId, onUpdateHighlightNote, onRemoveHighlight])

  const onMouseUp = (e: ReactMouseEvent) => {
    if (openId) return
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || !wrapRef.current) return
    const text = sel.toString().trim()
    if (!text) return
    const pageRect = wrapRef.current.getBoundingClientRect()
    const rects: Highlight['rects'] = []
    for (let i = 0; i < sel.rangeCount; i++) {
      rects.push(...collectRangeRects(sel.getRangeAt(i), pageRect, scale))
    }
    // 跨多个 range 再合并一次同行碎框
    const finalRects = mergeLineRects(refineSelectionRects(rects))
    if (finalRects.length) {
      onTextSelected(pageIndex, text, finalRects, e.clientX, e.clientY)
    }
  }

  const openHighlight = preciseHighlights.find((h) => h.id === openId) || null
  const showChromeId = openId || hoveredId
  const chromeHighlight = preciseHighlights.find((h) => h.id === showChromeId) || null
  const chromeRects = chromeHighlight?.rects || []
  const safeFocusIdx = Math.min(
    Math.max(0, focusRectIndex),
    Math.max(0, chromeRects.length - 1),
  )
  const anchorRect = chromeRects[safeFocusIdx]
  const popoverAnchor = anchorRect ? scaleRect(anchorRect, scale) : null

  // 面积小的命中框叠在上面，交叉时更易点到精确行
  const hitEntries = useMemo(() => {
    const entries = preciseHighlights.flatMap((h) =>
      h.rects.map((r, i) => ({
        h,
        r,
        i,
        area: Math.max(1, r.width * r.height),
      })),
    )
    entries.sort((a, b) => b.area - a.area)
    return entries
  }, [preciseHighlights])

  return (
    <div
      className="page-view"
      ref={wrapRef}
      data-page={pageIndex}
      style={{ width: widthHint, height: heightHint }}
      onMouseUp={onMouseUp}
    >
      <div className="page-label">第 {pageIndex + 1} 页</div>
      {active ? (
        <div className="page-stack" style={{ width: widthHint, height: heightHint }}>
          <canvas ref={canvasRef} className="page-canvas" />
          <div ref={textLayerRef} className="textLayer" />
          {ocrOverlay && (
            <div className="ocr-layer" style={{ width: widthHint, height: heightHint }}>
              {ocrOverlay.words.map((w, i) => (
                <span
                  key={i}
                  className="ocr-word"
                  style={{
                    left: w.x0 * scale,
                    top: w.y0 * scale,
                    width: (w.x1 - w.x0) * scale,
                    height: (w.y1 - w.y0) * scale,
                    fontSize: Math.max(8, (w.y1 - w.y0) * scale * 0.85),
                  }}
                >
                  {w.text}
                </span>
              ))}
            </div>
          )}

          {/* 可点击命中层：按行框命中；悬停/选中时整段跨行都高亮 */}
          <div className="hl-hit-layer">
            {hitEntries.map(({ h, r, i, area }) => {
              const active = openId === h.id || hoveredId === h.id
              return (
                <div
                  key={`hit-${h.id}-${i}`}
                  className={`hl-hit${active ? ' focused' : ''}`}
                  data-hl-id={h.id}
                  style={{
                    left: r.x * scale,
                    top: r.y * scale,
                    width: r.width * scale,
                    height: r.height * scale,
                    zIndex: Math.min(500, Math.max(1, Math.round(8000 / area))),
                  }}
                  onMouseEnter={() => {
                    setHoveredId(h.id)
                    setFocusRectIndex(i)
                  }}
                  onMouseLeave={() => {
                    if (openId !== h.id) {
                      setHoveredId((cur) => (cur === h.id ? null : cur))
                    }
                  }}
                  onClick={(e) => {
                    e.stopPropagation()
                    e.preventDefault()
                    setFocusRectIndex(i)
                    if (openId === h.id) {
                      setOpenId(null)
                      return
                    }
                    setOpenId(h.id)
                    setHoveredId(h.id)
                    setDraftNote(h.note || '')
                  }}
                />
              )
            })}
          </div>

          {/* 跨行高亮：每一行都画蓝框 */}
          {chromeHighlight &&
            chromeHighlight.rects.map((r, i) => (
              <div
                key={`frame-${chromeHighlight.id}-${i}`}
                className={`hl-frame${openId === chromeHighlight.id ? ' open' : ''}`}
                style={{
                  left: r.x * scale - 1,
                  top: r.y * scale - 1,
                  width: r.width * scale + 2,
                  height: r.height * scale + 2,
                }}
                data-hl-id={chromeHighlight.id}
              />
            ))}

          {openHighlight && popoverAnchor && (
            <div
              ref={popoverRef}
              className="hl-note-popover"
              style={{
                left: Math.min(popoverAnchor.left, widthHint - 220),
                top: popoverAnchor.top + popoverAnchor.height + 6,
              }}
              data-hl-id={openHighlight.id}
            >
              <textarea
                className="hl-note-input"
                rows={4}
                placeholder="写下批注…"
                value={draftNote}
                onChange={(e) => {
                  const value = e.target.value
                  setDraftNote(value)
                  onUpdateHighlightNote(openHighlight.id, value)
                }}
              />
            </div>
          )}
        </div>
      ) : (
        <div className="page-placeholder" style={{ width: widthHint, height: heightHint }}>
          <span>…</span>
        </div>
      )}
      {error && <div className="page-error">{error}</div>}
    </div>
  )
}

export async function renderPageToCanvas(
  pdf: PDFDocumentProxy,
  pageIndex: number,
  scale = 2,
): Promise<HTMLCanvasElement> {
  const page = await pdf.getPage(pageIndex + 1)
  const viewport = page.getViewport({ scale })
  const canvas = document.createElement('canvas')
  canvas.width = viewport.width
  canvas.height = viewport.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建 canvas')
  await page.render({ canvasContext: ctx, viewport, canvas }).promise
  return canvas
}
