import type {
  AiChatMessage,
  AiProvider,
  AiSelectionContext,
  AiStudySettings,
  AiTask,
  AppLocale,
  DocChunk,
  DocPageText,
  Highlight,
  PageAnnotation,
} from '../pdf/types'
import type { PageOutlineNode } from '../index/pageOutline'
import type { LlmContent, LlmImage, LlmMessage } from './llm'
import { estimateTokens } from './document'
import { retrieveChunks } from './retrieval'
import { systemPrompt } from './prompts'

export type StudyContextMode = 'full' | 'retrieval' | 'page' | 'selection' | 'none'

export type StudyContextInput = {
  task: AiTask
  /** 本轮真正发给模型的问题 / 任务指令 */
  userText: string
  history: AiChatMessage[]
  locale: AppLocale
  study: AiStudySettings
  provider: AiProvider
  fileName: string | null
  pageCount: number
  currentPage: number
  pageOutline: PageOutlineNode[]
  highlights: Highlight[]
  pageAnnotations: PageAnnotation[]
  pages: DocPageText[]
  chunks: DocChunk[]
  /** 当前页文本（索引尚未完成时的兜底） */
  currentPageText: string
  selection?: (AiSelectionContext & { pageText?: string }) | null
  image?: LlmImage
}

export type StudyPromptMeta = {
  mode: StudyContextMode
  pagesUsed: number[]
  contextChars: number
  contextTokens: number
  indexedPages: number
  totalPages: number
  fallback?: 'too-large' | 'not-indexed' | 'scanned' | 'cli-limit' | 'no-text'
  historyMessages: number
}

export type StudyPrompt = {
  system: string
  /** 稳定的文档上下文，放在 system 中以便 Anthropic prompt caching 命中 */
  cachedContext: string
  messages: LlmMessage[]
  meta: StudyPromptMeta
}

const DOC_WIDE_TASKS: AiTask[] = [
  'summarize-doc',
  'prepare-coach',
  'quiz',
  'flashcards',
  'mindmap',
]
const ANNOTATION_TASKS: AiTask[] = [
  'summarize-highlights',
  'structured-notes',
  'organize-outline',
]
const PAGE_TASKS: AiTask[] = [
  'summarize-page',
  'vision-page',
  'suggest-highlights',
]
const SELECTION_TASKS: AiTask[] = [
  'summarize-selection',
  'explain-selection',
  'translate-selection',
]

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function effectiveBudget(study: AiStudySettings): number {
  // CLI 通道（Claude Code / Codex）也走 stdin，不再受 Windows 参数长度限制
  return clamp(study.maxContextChars, 20_000, 600_000)
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}

function buildMetadata(input: StudyContextInput): string {
  const en = input.locale === 'en'
  const lines: string[] = []
  lines.push(en ? '# Document information' : '# 文档信息')
  lines.push(`${en ? '- File' : '- 文件名'}：${input.fileName || (en ? '(untitled)' : '（未命名）')}`)
  lines.push(`${en ? '- Pages' : '- 总页数'}：${input.pageCount}`)

  const readable = input.pages.filter((p) => p.text.trim()).length
  if (input.pages.length) {
    lines.push(
      `${en ? '- Pages with readable text' : '- 可读文本页'}：${readable}/${input.pageCount}`,
    )
  } else if (input.currentPageText.trim()) {
    lines.push(
      `${en ? '- Pages with readable text' : '- 可读文本页'}：≥1/${input.pageCount}`,
    )
  }

  const titled = input.pageOutline
    .filter((p) => p.customTitle.trim())
    .slice(0, 100)
  if (titled.length) {
    lines.push('', en ? '# Outline / page titles' : '# 目录 / 页标题')
    for (const page of titled) {
      lines.push(`- p${page.pageIndex + 1}: ${truncate(page.customTitle, 120)}`)
    }
  }

  if (input.study.includeAnnotations) {
    const sortedHighlights = [...input.highlights].sort(
      (a, b) => a.pageIndex - b.pageIndex || a.createdAt - b.createdAt,
    )
    if (sortedHighlights.length) {
      lines.push('', en ? "# My highlights" : '# 我的高亮')
      for (const h of sortedHighlights.slice(0, 100)) {
        const label = (h.colorLabel || '').trim()
        const text = truncate(h.outlineTitle || h.text, 180)
        const note = (h.note || '').trim()
        lines.push(
          `- p${h.pageIndex + 1}${label ? ` [${label}]` : ''}: ${text}${
            note ? ` | ${en ? 'note' : '批注'}: ${truncate(note, 120)}` : ''
          }`,
        )
      }
    }

    const sortedNotes = [...input.pageAnnotations].sort(
      (a, b) => a.pageIndex - b.pageIndex || a.createdAt - b.createdAt,
    )
    if (sortedNotes.length) {
      lines.push('', en ? '# My page notes' : '# 我的页批注')
      for (const note of sortedNotes.slice(0, 60)) {
        lines.push(`- p${note.pageIndex + 1}: ${truncate(note.body, 220)}`)
      }
    }
  }

  let text = lines.join('\n')
  const cap = 18_000
  if (text.length > cap) {
    text = `${text.slice(0, cap)}\n${en ? '…(truncated)' : '…（已截断）'}`
  }
  return text
}

function pageTextAt(input: StudyContextInput, pageIndex: number): string {
  if (pageIndex < 0 || pageIndex >= input.pageCount) return ''
  return (
    input.pages.find((p) => p.pageIndex === pageIndex)?.text ||
    (pageIndex === input.currentPage ? input.currentPageText : '')
  )
}

function formatPages(entries: { pageIndex: number; text: string }[]): string {
  return entries
    .filter((entry) => entry.text.trim())
    .map((entry) => `### p${entry.pageIndex + 1}\n${entry.text.trim()}`)
    .join('\n\n')
}

function buildPageContext(
  input: StudyContextInput,
  includeNeighbors: boolean,
  maxChars: number,
  includeSelectionText = true,
): { text: string; pages: number[] } {
  const en = input.locale === 'en'
  const targets = new Set<number>([input.currentPage])
  if (includeNeighbors) {
    for (const delta of [-1, 1]) {
      const p = input.currentPage + delta
      if (p >= 0 && p < input.pageCount) targets.add(p)
    }
  }
  if (input.selection) targets.add(input.selection.pageIndex)

  const entries = [...targets]
    .sort((a, b) => a - b)
    .map((pageIndex) => ({
      pageIndex,
      text:
        pageTextAt(input, pageIndex) ||
        (pageIndex === input.selection?.pageIndex ? input.selection?.pageText || '' : ''),
    }))

  let remaining = maxChars
  const used: { pageIndex: number; text: string }[] = []
  for (const entry of entries) {
    if (remaining <= 0) break
    const text = entry.text.slice(0, remaining)
    if (text.trim()) {
      used.push({ pageIndex: entry.pageIndex, text })
      remaining -= text.length
    }
  }

  const parts: string[] = []
  if (includeSelectionText && input.selection?.text.trim()) {
    parts.push(
      `${en ? '## Selected text' : '## 选中文本'} (p${input.selection.pageIndex + 1})\n${input.selection.text.trim()}`,
    )
  }
  const pageBlock = formatPages(used)
  if (pageBlock) {
    parts.push(
      `${en ? '## Page text' : '## 页面文本'}\n${pageBlock}`,
    )
  }
  return {
    text: parts.join('\n\n'),
    pages: used.map((entry) => entry.pageIndex),
  }
}

function buildRetrievalContext(
  input: StudyContextInput,
  query: string,
  maxChars: number,
): { text: string; pages: number[] } {
  const en = input.locale === 'en'
  const boostPages = [input.currentPage]
  if (input.selection) boostPages.push(input.selection.pageIndex)

  const hits = retrieveChunks(query, input.chunks, {
    topK: 10,
    maxPerPage: 2,
    boostPages,
  })

  const seen = new Set<string>()
  const entries: { pageIndex: number; text: string }[] = []
  let usedChars = 0
  for (const hit of hits) {
    if (seen.has(hit.chunk.id)) continue
    seen.add(hit.chunk.id)
    const room = maxChars - usedChars
    if (room <= 200) break
    const text = hit.chunk.text.slice(0, room)
    entries.push({ pageIndex: hit.chunk.pageIndex, text })
    usedChars += text.length
  }

  // 检索不到时退回当前页与相邻页
  if (!entries.length) {
    return buildPageContext(input, true, maxChars)
  }

  entries.sort(
    (a, b) => a.pageIndex - b.pageIndex || a.text.localeCompare(b.text),
  )
  return {
    text: `${en ? '## Retrieved passages most relevant to this request' : '## 与本问题最相关的检索段落'}\n\n${formatPages(entries)}`,
    pages: [...new Set(entries.map((entry) => entry.pageIndex))],
  }
}

function buildSampledContext(
  input: StudyContextInput,
  maxChars: number,
): { text: string; pages: number[] } {
  const en = input.locale === 'en'
  const readablePages = input.pages.filter((p) => p.text.trim())
  if (!readablePages.length) {
    return buildPageContext(input, true, Math.min(maxChars, 16_000))
  }

  const maxSamples = 18
  const step = Math.max(1, Math.floor(readablePages.length / maxSamples))
  const sampled = readablePages
    .filter((_, index) => index % step === 0)
    .slice(0, maxSamples)

  const perPage = Math.max(500, Math.floor(maxChars / Math.max(1, sampled.length)))
  const entries = sampled.map((page) => ({
    pageIndex: page.pageIndex,
    text: page.text.slice(0, Math.min(perPage, 1800)),
  }))

  return {
    text:
      `${en ? '## Note' : '## 说明'}\n` +
      (en
        ? 'The document is too long to include in full, so the following is an evenly sampled overview. Mention that the answer is based on a sample.\n\n'
        : '文档过长，无法完整放入上下文；以下为按页均匀采样的概览，请在回答中说明结论基于采样。\n\n') +
      formatPages(entries),
    pages: entries.map((entry) => entry.pageIndex),
  }
}

function buildAnnotationQuery(input: StudyContextInput): string {
  const en = input.locale === 'en'
  const parts: string[] = [input.userText]
  if (input.study.includeAnnotations) {
    for (const h of input.highlights.slice(0, 40)) {
      parts.push(h.outlineTitle || h.text, h.note)
    }
    for (const note of input.pageAnnotations.slice(0, 30)) parts.push(note.body)
  }
  if (en) parts.push('key concepts conclusions definitions')
  else parts.push('核心概念 结论 定义 要点')
  return parts.filter(Boolean).join('\n')
}

function trimHistory(
  history: AiChatMessage[],
  maxChars: number,
): LlmMessage[] {
  const out: LlmMessage[] = []
  let used = 0
  for (let i = history.length - 1; i >= 0 && out.length < 20; i--) {
    const msg = history[i]
    if (msg.role === 'assistant' && msg.error && !msg.content.trim()) continue
    const text =
      msg.role === 'user' ? (msg.llmText || msg.content) : msg.content
    if (!text.trim()) continue
    if (out.length > 0 && used + text.length > maxChars) break
    out.push({ role: msg.role, content: [{ type: 'text', text }] })
    used += text.length
  }
  out.reverse()
  // 历史必须从 user 开始；末尾通常是 assistant，后面会接本轮 user 消息
  while (out.length && out[0].role !== 'user') out.shift()
  return out
}

function isDocWide(task: AiTask): boolean {
  return DOC_WIDE_TASKS.includes(task)
}

export function buildStudyPrompt(input: StudyContextInput): StudyPrompt {
  const en = input.locale === 'en'
  const budget = effectiveBudget(input.study)
  const pagesWithText = input.pages.filter((p) => p.text.trim())
  const totalChars =
    pagesWithText.reduce((sum, page) => sum + page.text.length, 0) ||
    input.currentPageText.length
  const hasAnyDocText = totalChars > 0

  let mode: StudyContextMode
  let fallback: StudyPromptMeta['fallback']

  if (SELECTION_TASKS.includes(input.task) && input.selection?.text.trim()) {
    mode = 'selection'
  } else if (PAGE_TASKS.includes(input.task)) {
    mode = 'page'
  } else if (!hasAnyDocText) {
    mode = 'none'
    fallback = 'no-text'
  } else if (input.study.contextMode === 'retrieval' && !isDocWide(input.task)) {
    mode = 'retrieval'
  } else if (totalChars <= budget) {
    mode = 'full'
  } else {
    mode = 'retrieval'
    fallback = 'too-large'
  }

  if (!input.pages.length && hasAnyDocText && mode === 'full') {
    // 索引尚未完成：不要假装有全文，退回当前页
    mode = 'page'
    fallback = 'not-indexed'
  }

  if (input.study.contextMode === 'full' && mode === 'retrieval' && !fallback) {
    fallback = 'too-large'
  }

  let contextText = ''
  let pagesUsed: number[] = []

  if (mode === 'full') {
    const entries = pagesWithText.map((page) => ({
      pageIndex: page.pageIndex,
      text: page.text,
    }))
    let remaining = budget
    const trimmed: typeof entries = []
    for (const entry of entries) {
      if (remaining <= 0) break
      const text = entry.text.slice(0, remaining)
      trimmed.push({ pageIndex: entry.pageIndex, text })
      remaining -= text.length
    }
    contextText = `${en ? '# Full document text' : '# 文档全文'}\n\n${formatPages(trimmed)}`
  } else if (mode === 'selection') {
    const selection = input.selection!
    // 选中文本单独放在最前面；页面上下文只补充所在页正文，避免重复
    const pageContext = buildPageContext(input, false, 18_000, false)
    const query = `${input.userText}\n${selection.text}`
    const retrieval =
      input.chunks.length > 0
        ? buildRetrievalContext(input, query, 8_000)
        : { text: '', pages: [] as number[] }
    const blocks = [
      `${en ? '## Selected text' : '## 选中文本'} (p${selection.pageIndex + 1})\n${selection.text}`,
      pageContext.text,
      retrieval.text,
    ].filter((block) => block.trim())
    contextText = blocks.join('\n\n').slice(0, 26_000)
    pagesUsed = [
      selection.pageIndex,
      ...pageContext.pages,
      ...retrieval.pages,
    ]
  } else if (mode === 'page') {
    const pageContext = buildPageContext(input, true, 18_000)
    contextText = pageContext.text
    pagesUsed = pageContext.pages
  } else if (mode === 'retrieval') {
    if (isDocWide(input.task)) {
      const sampled = buildSampledContext(input, Math.min(budget, 40_000))
      contextText = sampled.text
      pagesUsed = sampled.pages
    } else if (ANNOTATION_TASKS.includes(input.task)) {
      const annotationQuery = buildAnnotationQuery(input)
      const retrieval = buildRetrievalContext(
        input,
        annotationQuery,
        Math.min(budget, 30_000),
      )
      contextText = retrieval.text
      pagesUsed = retrieval.pages
    } else {
      const retrieval = buildRetrievalContext(
        input,
        input.userText,
        Math.min(budget, 30_000),
      )
      contextText = retrieval.text
      pagesUsed = retrieval.pages
    }
  }

  if (!pagesWithText.length && input.currentPageText.trim() && mode === 'none') {
    mode = 'page'
    fallback = 'not-indexed'
    const pageContext = buildPageContext(input, true, 12_000)
    contextText = pageContext.text
    pagesUsed = pageContext.pages
  }

  if (!input.pages.length && hasAnyDocText && mode !== 'full') {
    pagesUsed = [...new Set([...pagesUsed, input.currentPage])]
  }

  const metadata = buildMetadata(input)
  const cachedContext = [metadata, contextText].filter((part) => part.trim()).join('\n\n')
  const contextChars = cachedContext.length

  const historyMessages = trimHistory(input.history, 28_000)
  const currentParts: LlmContent[] = []
  if (input.image) {
    currentParts.push({ type: 'image', image: input.image })
  }
  const header = [
    en ? `Current page: p${input.currentPage + 1}` : `当前页：p${input.currentPage + 1}`,
    input.image
      ? en
        ? 'A page image is attached.'
        : '已附带本页图像。'
      : '',
  ]
    .filter(Boolean)
    .join('\n')
  currentParts.push({
    type: 'text',
    text: `${header}\n\n${input.userText.trim()}`,
  })

  const messages: LlmMessage[] = [
    ...historyMessages,
    { role: 'user', content: currentParts },
  ]

  return {
    system: systemPrompt(input.locale, input.study),
    cachedContext,
    messages,
    meta: {
      mode,
      pagesUsed: [...new Set(pagesUsed)].sort((a, b) => a - b),
      contextChars,
      contextTokens: estimateTokens(cachedContext),
      indexedPages: pagesWithText.length,
      totalPages: input.pageCount,
      fallback,
      historyMessages: historyMessages.length,
    },
  }
}
