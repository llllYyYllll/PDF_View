export type OutlineItem = {
  title: string
  pageIndex: number | null
  items: OutlineItem[]
}

export type HighlightRect = {
  x: number
  y: number
  width: number
  height: number
}

/** 文字高亮；可附带批注 note */
export type Highlight = {
  id: string
  pageIndex: number
  color: string
  text: string
  note: string
  rects: HighlightRect[]
  createdAt: number
}

/** 页面级批注（与高亮无关） */
export type PageAnnotation = {
  id: string
  pageIndex: number
  body: string
  createdAt: number
}

/** 三向索引一行：页码 ↔ 高亮 ↔ 批注 */
export type IndexRow = {
  id: string
  pageIndex: number
  highlightId: string | null
  highlightText: string
  annotationId: string | null
  annotationText: string
  kind: 'highlight' | 'page-note' | 'both'
}

export type OcrMode = 'offline' | 'online'

export type OcrWord = {
  text: string
  x0: number
  y0: number
  x1: number
  y1: number
}

export type OcrPageOverlay = {
  pageIndex: number
  text: string
  words: OcrWord[]
  mode: OcrMode
}

/** 落盘的工程文件（与 PDF 同目录的 .pdfview.json） */
export type ProjectFile = {
  version: 1
  fileName: string
  savedAt: number
  outline: OutlineItem[]
  highlights: Highlight[]
  pageAnnotations: PageAnnotation[]
  ocrOverlays: OcrPageOverlay[]
  scale: number
  pageIndex: number
}
