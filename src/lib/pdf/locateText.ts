import { Util } from 'pdfjs-dist'
import type { PDFPageProxy } from 'pdfjs-dist'
import type { HighlightRect, OcrWord } from './types'

function compact(s: string): string {
  return s.replace(/\s+/g, '').toLowerCase()
}

type ItemBox = {
  compactStart: number
  compactLen: number
  rect: HighlightRect
}

function mergeLineRects(rects: HighlightRect[]): HighlightRect[] {
  if (rects.length <= 1) return rects
  const sorted = [...rects].sort((a, b) => a.y - b.y || a.x - b.x)
  const lines: HighlightRect[] = []
  for (const r of sorted) {
    const line = lines.find((l) => {
      const sameRow = Math.abs(l.y - r.y) <= Math.max(l.height, r.height) * 0.45
      const gap = Math.max(l.height, r.height) * 0.4
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

function rectsForRange(
  items: ItemBox[],
  start: number,
  end: number,
): HighlightRect[] {
  const rects: HighlightRect[] = []
  for (const it of items) {
    const itEnd = it.compactStart + it.compactLen
    if (itEnd <= start || it.compactStart >= end) continue
    rects.push(it.rect)
  }
  return mergeLineRects(rects)
}

function findBestMatch(
  haystack: string,
  needle: string,
): { start: number; end: number } | null {
  if (!needle || needle.length < 2) return null
  const exact = haystack.indexOf(needle)
  if (exact >= 0) return { start: exact, end: exact + needle.length }

  // 长引文匹配失败时，用前缀再试（模型常轻微改写后半段）
  if (needle.length > 20) {
    const prefixLen = Math.min(48, Math.max(16, Math.floor(needle.length * 0.45)))
    const prefix = needle.slice(0, prefixLen)
    const at = haystack.indexOf(prefix)
    if (at >= 0) {
      const end = Math.min(haystack.length, at + needle.length)
      return { start: at, end }
    }
  }
  return null
}

async function buildPdfItems(
  page: PDFPageProxy,
): Promise<{ compactText: string; items: ItemBox[] }> {
  const viewport = page.getViewport({ scale: 1 })
  const content = await page.getTextContent()
  const items: ItemBox[] = []
  let compactText = ''

  for (const raw of content.items) {
    if (!raw || typeof raw !== 'object' || !('str' in raw)) continue
    const item = raw as {
      str: string
      transform: number[]
      width?: number
    }
    if (!item.str) continue
    const c = compact(item.str)
    if (!c) continue

    const tm = Util.transform(viewport.transform, item.transform)
    const fontHeight = Math.max(1, Math.hypot(tm[2], tm[3]))
    const width = Math.max(1, (item.width ?? 0) * Math.hypot(tm[0], tm[1]))
    items.push({
      compactStart: compactText.length,
      compactLen: c.length,
      rect: {
        x: tm[4],
        y: tm[5] - fontHeight * 0.85,
        width,
        height: fontHeight,
      },
    })
    compactText += c
  }

  return { compactText, items }
}

function locateInOcr(words: OcrWord[], quote: string): HighlightRect[] | null {
  if (!words.length) return null
  const sorted = [...words].sort(
    (a, b) => a.y0 - b.y0 || a.x0 - b.x0,
  )
  const items: ItemBox[] = []
  let compactText = ''
  for (const w of sorted) {
    const c = compact(w.text)
    if (!c) continue
    items.push({
      compactStart: compactText.length,
      compactLen: c.length,
      rect: {
        x: w.x0,
        y: w.y0,
        width: Math.max(1, w.x1 - w.x0),
        height: Math.max(1, w.y1 - w.y0),
      },
    })
    compactText += c
  }
  const match = findBestMatch(compactText, compact(quote))
  if (!match) return null
  const rects = rectsForRange(items, match.start, match.end)
  return rects.length ? rects : null
}

/** 在单页中定位引文，返回页面坐标（scale=1）下的高亮框 */
export async function locateQuoteOnPage(
  page: PDFPageProxy,
  quote: string,
  ocrWords?: OcrWord[],
): Promise<HighlightRect[] | null> {
  const q = quote.trim()
  if (q.length < 2) return null

  if (ocrWords?.length) {
    const fromOcr = locateInOcr(ocrWords, q)
    if (fromOcr?.length) return fromOcr
  }

  const { compactText, items } = await buildPdfItems(page)
  const match = findBestMatch(compactText, compact(q))
  if (!match) return null
  const rects = rectsForRange(items, match.start, match.end)
  return rects.length ? rects : null
}
