import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import type { DocChunk, DocIndex, DocPageText, OcrPageOverlay, OcrWord } from '../pdf/types'

const CJK_RE = /[㐀-䶿一-鿿豈-﫿]/

const CHUNK_TARGET = 1500
const CHUNK_OVERLAP = 180

export function isCjk(ch: string): boolean {
  return CJK_RE.test(ch)
}

function cjkRatio(text: string): number {
  let cjk = 0
  let total = 0
  for (const ch of text) {
    if (/\s/.test(ch)) continue
    total++
    if (CJK_RE.test(ch)) cjk++
  }
  return total ? cjk / total : 0
}

/** 粗估 token：中文约 1 字 1 token，拉丁文约 3.6 字符 1 token */
export function estimateTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (/\s/.test(ch)) continue
    if (CJK_RE.test(ch)) cjk++
    else other++
  }
  return Math.ceil(cjk + other / 3.6)
}

function normalizeText(text: string): string {
  return text
    .replace(/­/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/([A-Za-z])-\n([a-z])/g, '$1$2')
    .trim()
}

function isTextItem(item: unknown): item is {
  str: string
  transform?: number[]
  width?: number
  height?: number
  hasEOL?: boolean
} {
  return !!item && typeof item === 'object' && 'str' in item
}

/**
 * 从 PDF.js 文字层还原段落。
 * 依据文字的 y 坐标断行、x 间距补空格；中文之间尽量不插空格。
 */
export async function extractPdfPageText(page: PDFPageProxy): Promise<string> {
  const content = await page.getTextContent()
  let out = ''
  let lastY: number | null = null
  let lastXEnd: number | null = null
  let lastChar = ''

  for (const raw of content.items) {
    if (!isTextItem(raw)) continue
    const str = raw.str
    if (!str) {
      if (raw.hasEOL) out += '\n'
      continue
    }

    const transform = raw.transform
    const x = transform?.[4]
    const y = transform?.[5]
    const height = Math.max(6, raw.height || 10)

    if (lastY != null && y != null && Math.abs(y - lastY) > height * 0.5) {
      if (!out.endsWith('\n')) out += '\n'
    } else if (lastXEnd != null && x != null && lastChar) {
      const gap = x - lastXEnd
      const nextChar = str[0] || ''
      // 中文与中文之间通常不需要空格；英文/数字之间按间距补
      const needSpace =
        gap > height * 0.32 &&
        !(isCjk(lastChar) && isCjk(nextChar)) &&
        !/\s$/.test(out) &&
        !/^\s/.test(str)
      if (needSpace) out += ' '
    }

    out += str
    if (raw.width != null && x != null) lastXEnd = x + raw.width
    if (y != null) lastY = y
    const trimmed = str.trimEnd()
    lastChar = trimmed ? trimmed[trimmed.length - 1] : lastChar
    if (raw.hasEOL && !out.endsWith('\n')) out += '\n'
  }

  return normalizeText(out)
}

function median(values: number[]): number {
  if (!values.length) return 10
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

function joinOcrLine(words: OcrWord[]): string {
  const sorted = [...words].sort((a, b) => a.x0 - b.x0)
  let line = ''
  let prev: OcrWord | null = null
  for (const word of sorted) {
    if (prev) {
      const gap = word.x0 - prev.x1
      const h = Math.max(1, Math.max(prev.y1 - prev.y0, word.y1 - word.y0))
      const bothCjk = isCjk(prev.text.slice(-1)) && isCjk(word.text[0] || '')
      if (gap > h * 0.3 && !bothCjk) line += ' '
    }
    line += word.text
    prev = word
  }
  return line.trim()
}

/** 把 OCR 单词按行聚合成可读文本 */
export function textFromOcrOverlay(overlay: OcrPageOverlay): string {
  const words = overlay.words.filter((w) => w.text.trim())
  // 某些联网 OCR 只返回整页文字，没有词级坐标
  if (!words.length) return normalizeText(overlay.text || '')
  const lineHeight = median(words.map((w) => Math.max(1, w.y1 - w.y0)))
  const tolerance = Math.max(3, lineHeight * 0.55)

  type Line = { center: number; words: OcrWord[] }
  const lines: Line[] = []
  for (const word of [...words].sort((a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2)) {
    const center = (word.y0 + word.y1) / 2
    let line = lines.find((l) => Math.abs(l.center - center) <= tolerance)
    if (!line) {
      line = { center, words: [] }
      lines.push(line)
    } else {
      line.center = (line.center * line.words.length + center) / (line.words.length + 1)
    }
    line.words.push(word)
  }

  lines.sort((a, b) => a.center - b.center)
  return normalizeText(lines.map((l) => joinOcrLine(l.words)).join('\n'))
}

function pickPageText(pdfText: string, ocrText: string): {
  text: string
  source: DocPageText['source']
} {
  const pdf = normalizeText(pdfText)
  const ocr = normalizeText(ocrText)
  // 有些扫描件带一层乱码文字，OCR 更可信
  if (!pdf) return ocr ? { text: ocr, source: 'ocr' } : { text: '', source: 'empty' }
  if (pdf.length < 160 && ocr.length > pdf.length * 2) {
    return { text: ocr, source: 'ocr' }
  }
  return { text: pdf, source: 'pdf' }
}

/** 按需解析单页（不依赖整本索引） */
export async function extractSinglePage(
  pdf: PDFDocumentProxy,
  pageIndex: number,
  ocrOverlay?: OcrPageOverlay,
): Promise<DocPageText> {
  let pdfText = ''
  try {
    const page = await pdf.getPage(pageIndex + 1)
    pdfText = await extractPdfPageText(page)
  } catch {
    pdfText = ''
  }
  const ocrText = ocrOverlay ? textFromOcrOverlay(ocrOverlay) : ''
  const { text, source } = pickPageText(pdfText, ocrText)
  return { pageIndex, text, source }
}

const SENTENCE_MARKS = new Set(['。', '！', '？', '；', '.', '!', '?', ';', '\n', '：', ':'])

function splitPageIntoChunks(pageIndex: number, text: string): DocChunk[] {
  const clean = normalizeText(text)
  if (!clean) return []
  if (clean.length <= CHUNK_TARGET) {
    return [{ id: `p${pageIndex + 1}-0`, pageIndex, text: clean }]
  }

  const chunks: DocChunk[] = []
  let start = 0
  let index = 0
  while (start < clean.length) {
    const hardEnd = Math.min(clean.length, start + CHUNK_TARGET)
    let end = hardEnd
    if (hardEnd < clean.length) {
      const minEnd = start + Math.floor(CHUNK_TARGET * 0.55)
      for (let i = hardEnd; i >= minEnd; i--) {
        if (SENTENCE_MARKS.has(clean[i])) {
          end = i + 1
          break
        }
      }
      // 再尝试在空格/换行处断开
      if (end === hardEnd) {
        for (let i = hardEnd; i >= minEnd; i--) {
          if (clean[i] === ' ') {
            end = i
            break
          }
        }
      }
    }
    const part = clean.slice(start, end).trim()
    if (part) chunks.push({ id: `p${pageIndex + 1}-${index}`, pageIndex, text: part })
    index++
    if (end >= clean.length) break
    start = Math.max(start + 1, end - CHUNK_OVERLAP)
  }
  return chunks
}

export function ocrSignature(overlays: OcrPageOverlay[]): string {
  return overlays
    .map((o) => `${o.pageIndex}:${o.words.length}:${o.text.length}`)
    .sort()
    .join('|')
}

/** 判断页面是否已有足够可读文字（否则应先 OCR） */
export function isPageTextReadable(text: string): boolean {
  return text.replace(/\s+/g, '').length >= 8
}

export type BuildDocIndexInput = {
  pdf: PDFDocumentProxy
  ocrOverlays: OcrPageOverlay[]
  signature: string
  signal?: AbortSignal
  onProgress?: (done: number, total: number) => void
  /**
   * 抽字失败时的 OCR 回调。返回新 overlay；构建过程中先写入本地 map，
   * 全部结束后通过 onOcrOverlays 一次性回传，避免中途改签名打断索引。
   */
  ocrEmptyPage?: (pageIndex: number) => Promise<OcrPageOverlay | null>
  onOcrOverlays?: (overlays: OcrPageOverlay[]) => void
}

function abortError(): DOMException {
  return new DOMException('Aborted', 'AbortError')
}

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

export async function buildDocIndex(input: BuildDocIndexInput): Promise<DocIndex> {
  const {
    pdf,
    ocrOverlays,
    signature,
    signal,
    onProgress,
    ocrEmptyPage,
    onOcrOverlays,
  } = input
  const ocrMap = new Map(ocrOverlays.map((o) => [o.pageIndex, o]))
  const newlyOcrd: OcrPageOverlay[] = []
  const pages: DocPageText[] = []
  const chunks: DocChunk[] = []
  let totalChars = 0
  let tokenEstimate = 0
  let scannedPages = 0

  for (let i = 0; i < pdf.numPages; i++) {
    if (signal?.aborted) throw abortError()
    let page = await extractSinglePage(pdf, i, ocrMap.get(i))
    if (!isPageTextReadable(page.text) && ocrEmptyPage) {
      const overlay = await ocrEmptyPage(i)
      if (overlay) {
        ocrMap.set(i, overlay)
        newlyOcrd.push(overlay)
        const ocrText = textFromOcrOverlay(overlay)
        if (isPageTextReadable(ocrText)) {
          page = { pageIndex: i, text: ocrText, source: 'ocr' }
        } else {
          page = await extractSinglePage(pdf, i, overlay)
        }
      }
    }
    pages.push(page)
    if (!isPageTextReadable(page.text)) scannedPages++
    totalChars += page.text.length
    tokenEstimate += estimateTokens(page.text)
    chunks.push(...splitPageIntoChunks(i, page.text))
    onProgress?.(i + 1, pdf.numPages)
    // 让出主线程，避免长文档解析时界面卡顿
    if (i % 8 === 7) await yieldToUi()
  }

  if (signal?.aborted) throw abortError()
  if (newlyOcrd.length && onOcrOverlays) {
    const merged = [...ocrOverlays]
    for (const overlay of newlyOcrd) {
      const idx = merged.findIndex((o) => o.pageIndex === overlay.pageIndex)
      if (idx >= 0) merged[idx] = overlay
      else merged.push(overlay)
    }
    onOcrOverlays(merged)
  }
  return { signature, pages, chunks, totalChars, tokenEstimate, scannedPages }
}

const indexCache = new WeakMap<PDFDocumentProxy, DocIndex>()

export function getCachedDocIndex(
  pdf: PDFDocumentProxy,
  signature: string,
): DocIndex | null {
  const cached = indexCache.get(pdf)
  return cached && cached.signature === signature ? cached : null
}

export function putCachedDocIndex(pdf: PDFDocumentProxy, index: DocIndex): void {
  indexCache.set(pdf, index)
}

/** 判断文本更像中文还是英文（用于划词翻译的目标语言） */
export function detectTextLocale(text: string): 'zh-CN' | 'en' {
  return cjkRatio(text) > 0.25 ? 'zh-CN' : 'en'
}

export { cjkRatio }
