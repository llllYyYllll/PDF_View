import type { DocChunk } from '../pdf/types'

/**
 * 轻量本地检索：BM25 + 中文 bigram 分词。
 * 不依赖任何外部 embedding 服务，离线可用；在「全文放不下」时提供可引用的相关段落。
 */

const EN_STOP = new Set(
  `a an and are as at be been but by can could do does did for from had has have he her him his how i if in into is it its may might more most must my no not of on or our out she should so some such than that the their them then there these they this those through to under up us was we were what when where which who why will with would you your about after before over just also only very much many any all each other same own few both either neither because while during within without upon among between across per via etc`.split(
    /\s+/,
  ),
)

const ZH_STOP = new Set([
  '的', '了', '是', '在', '和', '与', '及', '或', '等', '中', '对', '为', '从', '到',
  '由', '于', '其', '这', '那', '有', '也', '就', '不', '我', '你', '他', '她', '它',
  '们', '个', '上', '下', '里', '被', '把', '让', '给', '而', '并', '但', '很', '更',
  '最', '会', '能', '可', '要', '请', '将', '用', '以', '之', '者', '所', '呢', '吗',
  '啊', '吧', '哦', '嗯', '着', '过', '还', '又', '却', '才', '只', '比', '如', '此',
  '一', '二', '三', '四', '五', '六', '七', '八', '九', '十',
  '一个', '这个', '那个', '可以', '如果', '因为', '所以', '但是', '以及', '并且',
  '或者', '对于', '关于', '通过', '进行', '我们', '你们', '他们', '什么', '怎么',
  '如何', '为什么', '哪些', '请问', '请帮', '帮我', '一下', '一些', '这些', '那些',
  '不是', '没有', '就是', '还是', '然后', '而且', '其中', '之间', '上面', '下面',
  '时候', '现在', '已经', '需要', '应该', '可能', '一般', '例如', '比如', '根据',
  '文档', '内容', '问题', '回答', '说明', '解释', '总结', '分析', '整理', '梳理',
  '列出', '给出', '以下', '如下', '上述', '相关', '主要', '重要', '基本', '具体',
  '一种', '一种', '每个', '各种', '不同', '相同', '使用', '实现', '具有', '包括',
])

const CJK_RUN = /[㐀-䶿一-鿿豈-﫿]+/g
const LATIN_WORD = /[a-z][a-z0-9_'-]*|\d+(?:\.\d+)?/g

function tokenize(text: string): string[] {
  const lower = text.toLowerCase()
  const tokens: string[] = []

  for (const match of lower.matchAll(LATIN_WORD)) {
    const word = match[0]
    if (word.length > 1 && !EN_STOP.has(word)) tokens.push(word)
  }

  for (const match of lower.matchAll(CJK_RUN)) {
    const run = match[0]
    if (run.length === 1) {
      if (!ZH_STOP.has(run)) tokens.push(run)
      continue
    }
    for (let i = 0; i < run.length; i++) {
      const ch = run[i]
      const bi = i + 1 < run.length ? run.slice(i, i + 2) : ''
      if (!ZH_STOP.has(ch)) tokens.push(ch)
      if (bi && !ZH_STOP.has(bi)) {
        // bigram 更有区分度，权重加倍
        tokens.push(bi)
        tokens.push(bi)
      }
    }
  }

  return tokens
}

function countTokens(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1)
  return counts
}

type PreparedCorpus = {
  docTokens: string[][]
  df: Map<string, number>
  avgdl: number
}

const corpusCache = new WeakMap<DocChunk[], PreparedCorpus>()

function prepareCorpus(chunks: DocChunk[]): PreparedCorpus {
  const cached = corpusCache.get(chunks)
  if (cached) return cached

  const docTokens = chunks.map((chunk) => tokenize(chunk.text))
  const df = new Map<string, number>()
  let totalLength = 0
  for (const tokens of docTokens) {
    totalLength += tokens.length
    for (const token of new Set(tokens)) df.set(token, (df.get(token) || 0) + 1)
  }
  const prepared: PreparedCorpus = {
    docTokens,
    df,
    avgdl: docTokens.length ? totalLength / docTokens.length : 0,
  }
  corpusCache.set(chunks, prepared)
  return prepared
}

export type RetrievalOptions = {
  topK?: number
  /** 同一页最多返回几段，避免上下文被单页占满 */
  maxPerPage?: number
  /** 当前页/选中页加权 */
  boostPages?: number[]
}

export type RetrievalResult = {
  chunk: DocChunk
  score: number
}

export function retrieveChunks(
  query: string,
  chunks: DocChunk[],
  options: RetrievalOptions = {},
): RetrievalResult[] {
  const { topK = 8, maxPerPage = 2, boostPages = [] } = options
  const queryTokens = [...new Set(tokenize(query))]
  if (!queryTokens.length || !chunks.length) return []

  const { docTokens, df, avgdl } = prepareCorpus(chunks)
  const queryCounts = countTokens(queryTokens)
  const N = chunks.length
  const k1 = 1.2
  const b = 0.75
  const boost = new Set(boostPages)

  const scored: RetrievalResult[] = chunks.map((chunk, index) => {
    const tokens = docTokens[index]
    const tf = countTokens(tokens)
    const dl = tokens.length
    let score = 0
    for (const [term, qCount] of queryCounts) {
      const freq = tf.get(term)
      if (!freq) continue
      const docFreq = df.get(term) || 0
      const idf = Math.log(1 + (N - docFreq + 0.5) / (docFreq + 0.5))
      const denom = freq + k1 * (1 - b + (b * dl) / (avgdl || 1))
      score += idf * ((freq * (k1 + 1)) / (denom || 1)) * qCount
    }
    if (score > 0 && boost.has(chunk.pageIndex)) score *= 1.18
    return { chunk, score }
  })

  scored.sort((a, b2) => b2.score - a.score)
  const picked: RetrievalResult[] = []
  const perPage = new Map<number, number>()
  const skipped: RetrievalResult[] = []

  for (const item of scored) {
    if (item.score <= 0) break
    const used = perPage.get(item.chunk.pageIndex) || 0
    if (used >= maxPerPage) {
      skipped.push(item)
      continue
    }
    picked.push(item)
    perPage.set(item.chunk.pageIndex, used + 1)
    if (picked.length >= topK) break
  }

  if (picked.length < topK) {
    for (const item of skipped) {
      picked.push(item)
      if (picked.length >= topK) break
    }
  }

  return picked
}
