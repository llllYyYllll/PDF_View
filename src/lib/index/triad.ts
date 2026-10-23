import type { Highlight, IndexRow, PageAnnotation } from '../pdf/types'

/** 高亮 · 批注 · 页码 三向索引 */
export function buildTriadIndex(
  highlights: Highlight[],
  pageAnnotations: PageAnnotation[],
): IndexRow[] {
  const rows: IndexRow[] = []
  const usedPageNotes = new Set<string>()

  for (const h of highlights) {
    const note = (h.note || '').trim()
    rows.push({
      id: `h:${h.id}`,
      pageIndex: h.pageIndex,
      highlightId: h.id,
      highlightText: h.text,
      annotationId: note ? h.id : null,
      annotationText: note,
      kind: note ? 'both' : 'highlight',
    })
  }

  for (const a of pageAnnotations) {
    if (usedPageNotes.has(a.id)) continue
    rows.push({
      id: `a:${a.id}`,
      pageIndex: a.pageIndex,
      highlightId: null,
      highlightText: '',
      annotationId: a.id,
      annotationText: a.body,
      kind: 'page-note',
    })
  }

  rows.sort((a, b) => a.pageIndex - b.pageIndex || a.id.localeCompare(b.id))
  return rows
}
