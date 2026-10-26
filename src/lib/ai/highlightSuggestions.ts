/** 模型建议的可应用高亮 */
export type AiHighlightSuggestion = {
  /** 0 起 */
  pageIndex: number
  quote: string
  label: string
  note: string
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null
}

function pickString(row: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const v = row[key]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return ''
}

function pickPage(row: Record<string, unknown>): number | null {
  for (const key of ['page', 'pageIndex', 'page_number', 'p']) {
    const v = row[key]
    if (typeof v === 'number' && Number.isFinite(v)) {
      // 模型通常给 1-based；若已是 0 且 quote 很长也仍按 1-based 处理更稳
      const n = Math.round(v)
      if (n <= 0) return 0
      return n - 1
    }
    if (typeof v === 'string' && /^\d+$/.test(v.trim())) {
      const n = Number(v.trim())
      if (n <= 0) return 0
      return n - 1
    }
  }
  return null
}

function normalizeRow(raw: unknown): AiHighlightSuggestion | null {
  const row = asRecord(raw)
  if (!row) return null
  const quote = pickString(row, ['quote', 'text', 'excerpt', 'span', 'content'])
  if (quote.length < 2) return null
  const pageIndex = pickPage(row)
  if (pageIndex == null || pageIndex < 0) return null
  return {
    pageIndex,
    quote,
    label: pickString(row, ['label', 'colorLabel', 'tag', 'type']) || '重点',
    note: pickString(row, ['note', 'reason', 'why', 'comment']),
  }
}

function extractJsonCandidate(content: string): string | null {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced?.[1]) return fenced[1].trim()

  const arrayMatch = content.match(/\[[\s\S]*\]/)
  if (arrayMatch) return arrayMatch[0]

  const objectMatch = content.match(/\{[\s\S]*\}/)
  if (objectMatch) return objectMatch[0]
  return null
}

/** 从助手回复中解析高亮建议（JSON 数组或单对象） */
export function parseHighlightSuggestions(
  content: string,
): AiHighlightSuggestion[] {
  const candidate = extractJsonCandidate(content)
  if (!candidate) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(candidate)
  } catch {
    return []
  }

  const rows = Array.isArray(parsed) ? parsed : [parsed]
  const out: AiHighlightSuggestion[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const item = normalizeRow(row)
    if (!item) continue
    const key = `${item.pageIndex}|${item.quote}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
    if (out.length >= 40) break
  }
  return out
}
