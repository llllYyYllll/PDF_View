import type { AiChatMessage, AiChatSession } from '../pdf/types'

const PREFIX = 'pdfview:v3:aiChat:'
const MAX_MESSAGES = 100
const MAX_CHARS = 240_000

function keyFor(fileKey: string): string {
  return `${PREFIX}${fileKey}`
}

function normalizeMessage(raw: unknown): AiChatMessage | null {
  if (!raw || typeof raw !== 'object') return null
  const msg = raw as Partial<AiChatMessage>
  if (msg.role !== 'user' && msg.role !== 'assistant') return null
  if (typeof msg.content !== 'string') return null
  return {
    id: typeof msg.id === 'string' ? msg.id : crypto.randomUUID(),
    role: msg.role,
    content: msg.content,
    llmText: typeof msg.llmText === 'string' ? msg.llmText : undefined,
    createdAt: typeof msg.createdAt === 'number' ? msg.createdAt : Date.now(),
    task: msg.task,
    provider: msg.provider,
    model: typeof msg.model === 'string' ? msg.model : undefined,
    thinking: typeof msg.thinking === 'string' ? msg.thinking : undefined,
    pagesUsed: Array.isArray(msg.pagesUsed)
      ? msg.pagesUsed.filter((n): n is number => typeof n === 'number')
      : undefined,
    contextMode: msg.contextMode,
    contextTokens:
      typeof msg.contextTokens === 'number' ? msg.contextTokens : undefined,
    fallback: msg.fallback,
    pageIndex: typeof msg.pageIndex === 'number' ? msg.pageIndex : undefined,
    selection:
      msg.selection &&
      typeof msg.selection.text === 'string' &&
      typeof msg.selection.pageIndex === 'number'
        ? { text: msg.selection.text, pageIndex: msg.selection.pageIndex }
        : undefined,
    error: typeof msg.error === 'string' ? msg.error : undefined,
  }
}

export function loadChat(fileKey: string): AiChatMessage[] {
  try {
    const raw = localStorage.getItem(keyFor(fileKey))
    if (!raw) return []
    const session = JSON.parse(raw) as Partial<AiChatSession>
    if (!Array.isArray(session.messages)) return []
    return session.messages
      .map(normalizeMessage)
      .filter((m): m is AiChatMessage => m !== null)
  } catch {
    return []
  }
}

function trimMessages(messages: AiChatMessage[]): AiChatMessage[] {
  let list = messages.slice(-MAX_MESSAGES)
  let chars = list.reduce((sum, m) => sum + m.content.length, 0)
  while (list.length > 2 && chars > MAX_CHARS) {
    const removed = list.shift()
    chars -= removed?.content.length ?? 0
  }
  while (list.length && list[0].role !== 'user') list.shift()
  return list
}

export function saveChat(fileKey: string, messages: AiChatMessage[]): void {
  try {
    const trimmed = trimMessages(messages)
    const session: AiChatSession = {
      fileKey,
      messages: trimmed,
      updatedAt: Date.now(),
    }
    localStorage.setItem(keyFor(fileKey), JSON.stringify(session))
  } catch {
    // 配额不足或隐私模式：忽略，聊天气泡仍在内存中
  }
}

export function clearChat(fileKey: string): void {
  try {
    localStorage.removeItem(keyFor(fileKey))
  } catch {
    /* ignore */
  }
}
