/** 与具体 Provider 无关的 LLM 消息格式 */
export type LlmImage = {
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp'
  /** 纯 base64，不含 data: 前缀 */
  data: string
}

export type LlmContent =
  | { type: 'text'; text: string }
  | { type: 'image'; image: LlmImage }

export type LlmMessage = {
  role: 'user' | 'assistant'
  content: LlmContent[]
}

export type StreamCallbacks = {
  signal?: AbortSignal
  /** 正文增量 */
  onDelta: (text: string) => void
  /** 推理模型 / 扩展思考的增量（DeepSeek reasoning_content、Claude thinking） */
  onThinking?: (text: string) => void
}

export function textContent(text: string): LlmContent {
  return { type: 'text', text }
}

export function imageContent(image: LlmImage): LlmContent {
  return { type: 'image', image }
}

/** 提取消息中的纯文本（忽略图片），用于 CLI 等纯文本通道 */
export function messageText(message: LlmMessage): string {
  return message.content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
}
