import type {
  Highlight,
  HighlightPaletteItem,
  OutlineItem,
  PageAnnotation,
  PageTitleMap,
} from '../pdf/types'

function normalizeColor(c: string) {
  return c.replace(/99$/i, '').slice(0, 7).toLowerCase()
}

function resolveColorLabel(
  h: Highlight,
  palette: HighlightPaletteItem[],
): string {
  const saved = (h.colorLabel || '').trim()
  if (saved) return saved
  const key = normalizeColor(h.color || '')
  return palette.find((p) => normalizeColor(p.color) === key)?.label.trim() || ''
}

/** 侧栏目录节点：页为父级文件夹，批注/高亮为子级 */
export type PageOutlineNode = {
  id: string
  kind: 'page' | 'page-note' | 'highlight'
  /** 完整展示标题，含「第 N 页」 */
  title: string
  /** 固定页号文案，如「第 3 页」 */
  pageLabel: string
  /** 可重命名部分（不含页号）；空则仅显示页号 */
  customTitle: string
  /** 高亮条目：选中原文（清空自定义标题后回退显示） */
  defaultTitle?: string
  pageIndex: number
  /** 高亮色（仅 highlight） */
  color?: string
  /** 颜色含义，显示在色块上 */
  colorLabel?: string
  highlightId?: string
  annotationId?: string
  items: PageOutlineNode[]
}

/** 扁平收集 PDF/OCR 目录里「某页 → 标题」 */
function collectPageTitles(items: OutlineItem[], map: Map<number, string[]>) {
  for (const item of items) {
    if (item.pageIndex != null) {
      const list = map.get(item.pageIndex) || []
      const t = item.title.trim()
      if (t && !list.includes(t)) list.push(t)
      map.set(item.pageIndex, list)
    }
    if (item.items?.length) collectPageTitles(item.items, map)
  }
}

/**
 * 构建「每一页文件夹 + 批注子级」目录。
 * 父级覆盖全部页；有 PDF/OCR 标题时附在页名后。
 */
export function buildPageOutline(
  pageCount: number,
  outline: OutlineItem[],
  highlights: Highlight[],
  pageAnnotations: PageAnnotation[],
  palette: HighlightPaletteItem[] = [],
  pageTitles: PageTitleMap = {},
): PageOutlineNode[] {
  const titlesByPage = new Map<number, string[]>()
  collectPageTitles(outline, titlesByPage)

  const count = Math.max(
    pageCount,
    ...[
      ...titlesByPage.keys(),
      ...highlights.map((h) => h.pageIndex),
      ...pageAnnotations.map((a) => a.pageIndex),
      -1,
    ].map((n) => n + 1),
  )

  if (count <= 0) return []

  const nodes: PageOutlineNode[] = []
  for (let pageIndex = 0; pageIndex < count; pageIndex++) {
    const pageLabel = `第 ${pageIndex + 1} 页`
    const renamed = (pageTitles[String(pageIndex)] || '').trim()
    const fromOutline = titlesByPage.get(pageIndex)
    const customTitle =
      renamed || (fromOutline && fromOutline.length ? fromOutline.join(' / ') : '')
    const title = customTitle ? `${pageLabel} · ${customTitle}` : pageLabel

    const children: PageOutlineNode[] = []

    for (const a of pageAnnotations.filter((x) => x.pageIndex === pageIndex)) {
      const raw = a.body.trim().replace(/\s+/g, ' ') || '（空批注）'
      const title = raw.length > 48 ? `${raw.slice(0, 48)}…` : raw
      children.push({
        id: `a:${a.id}`,
        kind: 'page-note',
        title,
        pageLabel: '',
        customTitle: '',
        pageIndex,
        annotationId: a.id,
        items: [],
      })
    }

    for (const h of highlights.filter((x) => x.pageIndex === pageIndex)) {
      const meaning = resolveColorLabel(h, palette)
      const selected = h.text.trim() || '（高亮）'
      const custom = (h.outlineTitle || '').trim()
      const display = custom || selected
      const title =
        display.length > 48 ? `${display.slice(0, 48)}…` : display
      children.push({
        id: `h:${h.id}`,
        kind: 'highlight',
        title,
        pageLabel: '',
        customTitle: custom,
        defaultTitle: selected,
        pageIndex,
        color: h.color,
        colorLabel: meaning,
        highlightId: h.id,
        items: [],
      })
    }

    nodes.push({
      id: `p:${pageIndex}`,
      kind: 'page',
      title,
      pageLabel,
      customTitle,
      pageIndex,
      items: children,
    })
  }

  return nodes
}
