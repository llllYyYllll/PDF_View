import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { PageRenderCache } from '../lib/pdf/pageCache'
import type { Highlight, OcrPageOverlay } from '../lib/pdf/types'
import { PageView } from './PageView'

type PageGeom = { width: number; height: number }

type Props = {
  pdf: PDFDocumentProxy
  scale: number
  currentPage: number
  jumpToken: number
  highlights: Highlight[]
  ocrOverlays: OcrPageOverlay[]
  highlightColor: string
  onPageChange: (pageIndex: number, scrollRatio: number) => void
  onAddHighlight: (pageIndex: number, text: string, rects: Highlight['rects']) => void
}

const CACHE_SIZE = 10
const OVERSCAN = 2

export function Viewer({
  pdf,
  scale,
  currentPage,
  jumpToken,
  highlights,
  ocrOverlays,
  highlightColor,
  onPageChange,
  onAddHighlight,
}: Props) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const [geoms, setGeoms] = useState<PageGeom[]>([])
  const [activePages, setActivePages] = useState<Set<number>>(() => new Set([0]))
  const cacheRef = useRef(new PageRenderCache(CACHE_SIZE))
  const offsetsRef = useRef<number[]>([])
  const jumpingRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const list: PageGeom[] = []
      for (let i = 0; i < pdf.numPages; i++) {
        const page = await pdf.getPage(i + 1)
        if (cancelled) return
        const vp = page.getViewport({ scale: 1 })
        list.push({ width: vp.width, height: vp.height })
      }
      setGeoms(list)
      cacheRef.current.clear()
    })()
    return () => {
      cancelled = true
    }
  }, [pdf])

  const scaledGeoms = useMemo(
    () => geoms.map((g) => ({ width: g.width * scale, height: g.height * scale })),
    [geoms, scale],
  )

  const offsets = useMemo(() => {
    const gap = 16
    const arr: number[] = []
    let y = 16
    for (const g of scaledGeoms) {
      arr.push(y)
      y += g.height + gap
    }
    offsetsRef.current = arr
    return arr
  }, [scaledGeoms])

  const totalHeight = useMemo(() => {
    if (!scaledGeoms.length) return 0
    const last = scaledGeoms.length - 1
    return offsets[last] + scaledGeoms[last].height + 32
  }, [scaledGeoms, offsets])

  const updateVisible = useCallback(() => {
    const el = scrollerRef.current
    if (!el || !scaledGeoms.length) return
    const top = el.scrollTop
    const bottom = top + el.clientHeight
    const next = new Set<number>()
    let current = 0
    let bestVisible = 0

    for (let i = 0; i < scaledGeoms.length; i++) {
      const y0 = offsets[i]
      const y1 = y0 + scaledGeoms[i].height
      if (y1 < top - OVERSCAN * 200) continue
      if (y0 > bottom + OVERSCAN * 200) break
      next.add(i)
      const visible = Math.min(y1, bottom) - Math.max(y0, top)
      if (visible > bestVisible) {
        bestVisible = visible
        current = i
      }
    }

    // ensure neighbors
    for (let i = current - OVERSCAN; i <= current + OVERSCAN; i++) {
      if (i >= 0 && i < scaledGeoms.length) next.add(i)
    }

    for (const p of next) cacheRef.current.touch(p)
    cacheRef.current.evictCandidates(next)

    setActivePages(next)
    if (!jumpingRef.current) {
      const pageTop = offsets[current]
      const pageH = scaledGeoms[current].height
      const ratio = pageH > 0 ? Math.min(1, Math.max(0, (top - pageTop) / pageH)) : 0
      onPageChange(current, ratio)
    }
  }, [scaledGeoms, offsets, onPageChange])

  useEffect(() => {
    updateVisible()
  }, [updateVisible, scale])

  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    let ticking = false
    const onScroll = () => {
      if (ticking) return
      ticking = true
      requestAnimationFrame(() => {
        updateVisible()
        ticking = false
      })
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [updateVisible])

  // Jump to page when jumpToken changes
  useEffect(() => {
    if (!scrollerRef.current || !offsets.length) return
    jumpingRef.current = true
    const y = offsets[currentPage] ?? 0
    scrollerRef.current.scrollTo({ top: Math.max(0, y - 8), behavior: 'auto' })
    requestAnimationFrame(() => {
      updateVisible()
      jumpingRef.current = false
    })
  }, [jumpToken]) // eslint-disable-line react-hooks/exhaustive-deps

  const ocrMap = useMemo(() => {
    const m = new Map<number, OcrPageOverlay>()
    for (const o of ocrOverlays) m.set(o.pageIndex, o)
    return m
  }, [ocrOverlays])

  const highlightsByPage = useMemo(() => {
    const m = new Map<number, Highlight[]>()
    for (const h of highlights) {
      const list = m.get(h.pageIndex) || []
      list.push(h)
      m.set(h.pageIndex, list)
    }
    return m
  }, [highlights])

  return (
    <div className="viewer" ref={scrollerRef}>
      <div className="viewer-inner" style={{ height: totalHeight }}>
        {scaledGeoms.map((g, i) => (
          <div
            key={i}
            className="page-slot"
            style={{
              position: 'absolute',
              top: offsets[i],
              left: '50%',
              transform: 'translateX(-50%)',
              width: g.width,
              height: g.height,
            }}
          >
            <PageView
              pdf={pdf}
              pageIndex={i}
              scale={scale}
              widthHint={g.width}
              heightHint={g.height}
              active={activePages.has(i)}
              highlights={highlightsByPage.get(i) || []}
              ocrOverlay={ocrMap.get(i)}
              highlightColor={highlightColor}
              onAddHighlight={onAddHighlight}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
