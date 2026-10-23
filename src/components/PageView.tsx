import { useEffect, useRef, useState } from 'react'
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
  onAddHighlight: (pageIndex: number, text: string, rects: Highlight['rects']) => void
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
  onAddHighlight,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textLayerRef = useRef<HTMLDivElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const renderTaskRef = useRef<RenderTask | null>(null)
  const pageRef = useRef<PDFPageProxy | null>(null)

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

  const onMouseUp = () => {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || !wrapRef.current) return
    const text = sel.toString().trim()
    if (!text) return
    const pageRect = wrapRef.current.getBoundingClientRect()
    const rects: Highlight['rects'] = []
    for (let i = 0; i < sel.rangeCount; i++) {
      const range = sel.getRangeAt(i)
      for (const r of Array.from(range.getClientRects())) {
        if (r.width < 1 || r.height < 1) continue
        rects.push({
          x: (r.left - pageRect.left) / scale,
          y: (r.top - pageRect.top) / scale,
          width: r.width / scale,
          height: r.height / scale,
        })
      }
    }
    if (rects.length) {
      onAddHighlight(pageIndex, text, rects)
      sel.removeAllRanges()
    }
  }

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
          <div className="highlight-layer">
            {highlights.map((h) =>
              h.rects.map((r, i) => (
                <div
                  key={`${h.id}-${i}`}
                  className="hl-rect"
                  title={h.note || h.text}
                  style={{
                    left: r.x * scale,
                    top: r.y * scale,
                    width: r.width * scale,
                    height: r.height * scale,
                    background: h.color || highlightColor,
                  }}
                />
              )),
            )}
          </div>
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
