import type { OcrPageOverlay, OutlineItem } from './types'

const HEADING_RE =
  /^(第[一二三四五六七八九十百千0-9]+[章节篇部节]|[0-9]+(\.[0-9]+)*\s+\S|Chapter\s+\d+|CHAPTER\s+\d+|目录|摘要|前言|附录)/i

/**
 * 从 OCR 文本启发式生成可跳转目录（轻量、无额外模型）。
 * 规则：短行 + 像章节标题的模式，按页聚合。
 */
export function buildOutlineFromOcr(overlays: OcrPageOverlay[]): OutlineItem[] {
  const items: OutlineItem[] = []
  const sorted = [...overlays].sort((a, b) => a.pageIndex - b.pageIndex)

  for (const page of sorted) {
    const lines = page.text
      .split(/\r?\n|(?<=[。；;])\s+/)
      .map((l) => l.replace(/\s+/g, ' ').trim())
      .filter(Boolean)

    // 也按空格切出的「伪行」：取偏短片段
    const candidates = new Set<string>()
    for (const line of lines) {
      if (line.length >= 2 && line.length <= 48) candidates.add(line)
    }
    // 词高较大的词串更像标题
    if (page.words.length) {
      const heights = page.words.map((w) => w.y1 - w.y0).filter((h) => h > 0)
      const avg = heights.reduce((a, b) => a + b, 0) / Math.max(1, heights.length)
      const tall = page.words.filter((w) => w.y1 - w.y0 >= avg * 1.25)
      const byLine = new Map<number, string[]>()
      for (const w of tall) {
        const key = Math.round(w.y0 / 8)
        const arr = byLine.get(key) || []
        arr.push(w.text)
        byLine.set(key, arr)
      }
      for (const parts of byLine.values()) {
        const t = parts.join('').trim()
        if (t.length >= 2 && t.length <= 48) candidates.add(t)
      }
    }

    for (const title of candidates) {
      if (!HEADING_RE.test(title) && title.length > 28) continue
      if (!HEADING_RE.test(title) && !/^[\d一二三四五六七八九十]/.test(title)) {
        // 无编号时仅收很短的一行
        if (title.length > 16) continue
      }
      if (items.some((i) => i.title === title && i.pageIndex === page.pageIndex)) continue
      items.push({ title, pageIndex: page.pageIndex, items: [] })
    }
  }

  return items
}

export function isLikelyScannedPage(text: string): boolean {
  return text.replace(/\s+/g, '').length < 12
}
