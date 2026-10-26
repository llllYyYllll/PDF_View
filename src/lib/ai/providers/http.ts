import { Channel, invoke, isTauri } from '@tauri-apps/api/core'
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import type { AppLocale, ResolvedAiConfig } from '../../pdf/types'
import type { LlmImage, LlmMessage, StreamCallbacks } from '../llm'

export type HttpCallOptions = {
  signal?: AbortSignal
  maxTokens?: number
  /** 服务端是否使用流式输出，默认 true */
  stream?: boolean
  /** Anthropic：尝试启用 adaptive thinking（不支持时自动回退） */
  thinking?: boolean
  /**
   * OpenAI 兼容端点的思考开关（DeepSeek 等默认开启）。
   * 短请求（连接测试）应设为 disabled，否则推理会占满 max_tokens 导致正文为空。
   */
  openAiThinking?: 'enabled' | 'disabled'
}

export type ModelInfo = {
  id: string
  label?: string
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

type AiHttpEvent =
  | {
      type: 'headers'
      status: number
      status_text: string
      url: string
      headers: [string, string][]
    }
  | { type: 'chunk'; data: string }
  | { type: 'done' }
  | { type: 'error'; message: string }

type AiHeadersEvent = Extract<AiHttpEvent, { type: 'headers' }>

/** 本会话中已确认“直连可用”的 host，后续不再先撞一次失效的系统代理 */
const directHosts = new Set<string>()

function abortError(): Error {
  try {
    return new DOMException('Aborted', 'AbortError')
  } catch {
    const error = new Error('Aborted')
    error.name = 'AbortError'
    return error
  }
}

function newRequestId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `ai-${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
}

function base64ToBytes(data: string): Uint8Array {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

function fallbackHeaders(init: RequestInit): [string, string][] {
  return Array.from(new Headers(init.headers).entries())
}

function fallbackBody(body: BodyInit | null | undefined): string | null {
  if (body == null) return null
  if (typeof body === 'string') return body
  if (body instanceof URLSearchParams) return body.toString()
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body)
  if (ArrayBuffer.isView(body)) {
    return new TextDecoder().decode(
      new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
    )
  }
  throw new Error('直连回退暂不支持该请求体类型')
}

function errorBrief(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240)
  return message || '未知错误'
}

function isTransportFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /error sending request|failed to fetch|network ?error|connection (refused|reset|closed|aborted)|dns|timed? ?out|tcp connect|tls handshake/i.test(
    message,
  )
}

function networkFailure(errors: Map<'system' | 'direct', unknown>): Error {
  const system = errors.get('system')
  const direct = errors.get('direct')
  const detail = [
    system ? `系统通道：${errorBrief(system)}` : '',
    direct ? `直连：${errorBrief(direct)}` : '',
  ]
    .filter(Boolean)
    .join('；')
  const error = new Error(
    `网络请求失败：系统通道与直连均不可用。${detail ? `${detail}。` : ''}请检查网络连接或系统代理设置。`,
  )
  error.name = 'AiTransportError'
  return error
}

/**
 * 绕过系统代理与环境变量，直接用 Rust 发起请求。
 * 这是 tauri-plugin-http 发送失败后的回退通道，也承担流式响应。
 */
async function directFetch(url: string, init: RequestInit): Promise<Response> {
  const signal = init.signal ?? undefined
  if (signal?.aborted) throw abortError()

  const requestId = newRequestId()
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null
  let started = false
  let failStart!: (error: unknown) => void

  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value
    },
    cancel() {
      void invoke('ai_http_cancel', { requestId }).catch(() => {})
    },
  })

  const headersPromise = new Promise<AiHeadersEvent>((resolve, reject) => {
    failStart = reject

    const fail = (error: unknown) => {
      if (started) {
        try {
          controller?.error(error)
        } catch {
          /* 流已关闭或已取消 */
        }
      } else {
        failStart(error)
      }
    }

    const onAbort = () => {
      void invoke('ai_http_cancel', { requestId }).catch(() => {})
      fail(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    // addEventListener 不会为已经 abort 的信号补发事件
    if (signal?.aborted) onAbort()

    const channel = new Channel<AiHttpEvent>((event) => {
      if (event.type === 'headers') {
        started = true
        resolve(event)
        return
      }
      if (event.type === 'chunk') {
        try {
          controller?.enqueue(base64ToBytes(event.data))
        } catch {
          /* 流已取消 */
        }
        return
      }
      if (event.type === 'done') {
        signal?.removeEventListener('abort', onAbort)
        try {
          controller?.close()
        } catch {
          /* 已关闭 */
        }
        return
      }
      fail(new Error(event.message))
    })

    void invoke('ai_http_stream', {
      request: {
        requestId,
        method: init.method ?? 'GET',
        url,
        headers: fallbackHeaders(init),
        body: fallbackBody(init.body),
        // 失败回退时一定直连；系统代理路径由 tauri-plugin-http 负责
        proxy: { mode: 'direct' },
        connectTimeoutMs: 20_000,
      },
      onEvent: channel,
    }).catch((error: unknown) => {
      fail(error instanceof Error ? error : new Error(String(error)))
    })
  })

  const headers = await headersPromise
  const response = new Response(
    [101, 103, 204, 205, 304].includes(headers.status) ? null : body,
    {
      status: headers.status,
      statusText: headers.status_text,
      headers: headers.headers,
    },
  )
  // Response 构造函数不允许设置 url，这里与插件版保持一致
  Object.defineProperty(response, 'url', {
    value: headers.url,
    writable: false,
  })
  return response
}

/**
 * 桌面端经由 Rust 发起请求，避开 WebView 的 CORS 限制；
 * 纯浏览器调试（npm run dev）时退回原生 fetch。
 *
 * 系统代理（Clash 等）临时不可用时，tauri-plugin-http 只会返回
 * `error sending request`。此时自动改用 Rust 直连通道重试，
 * 用户无需先去关系统代理；直连成功后本会话内记住该 host。
 */
async function aiFetch(url: string, init: RequestInit): Promise<Response> {
  if (!isTauri()) {
    return fetch(url, init)
  }

  let host = ''
  try {
    host = new URL(url).host
  } catch {
    /* 交给下面的请求去报错 */
  }

  const order: ('system' | 'direct')[] =
    host && directHosts.has(host)
      ? ['direct', 'system']
      : ['system', 'direct']
  const errors = new Map<'system' | 'direct', unknown>()

  for (const [index, mode] of order.entries()) {
    try {
      const response =
        mode === 'system'
          ? await tauriFetch(url, init)
          : await directFetch(url, init)
      if (host) {
        if (mode === 'direct') directHosts.add(host)
        else directHosts.delete(host)
      }
      return response
    } catch (error) {
      if (init.signal?.aborted || !isTransportFailure(error)) throw error
      errors.set(mode, error)
      if (index === order.length - 1) {
        throw networkFailure(errors)
      }
    }
  }

  // order 至少有两项，循环内一定会 return 或 throw
  throw networkFailure(errors)
}

function baseFor(config: ResolvedAiConfig, fallback: string): string {
  return trimSlash(config.apiBase.trim() || fallback)
}

function isAzureOpenAi(config: ResolvedAiConfig): boolean {
  return /\.openai\.azure\.com/i.test(config.apiBase)
}

function openAiChatUrl(config: ResolvedAiConfig): string {
  const base = baseFor(config, 'https://api.openai.com/v1')
  if (!isAzureOpenAi(config)) return `${base}/chat/completions`
  // Azure 新版 v1 兼容端点：https://<resource>.openai.azure.com/openai/v1
  // 也兼容用户直接填写 .../openai/deployments/<deployment> 的旧式地址
  if (/\/chat\/completions(?:\?|$)/i.test(base)) return base
  if (/\/openai\/deployments\/[^/]+$/i.test(base)) {
    return `${base}/chat/completions?api-version=2024-10-21`
  }
  if (/\/openai\/v1$/i.test(base)) return `${base}/chat/completions`
  return `${base}/openai/v1/chat/completions`
}

function dataUrl(image: LlmImage): string {
  return `data:${image.mediaType};base64,${image.data}`
}

function contextBlock(system: string, cachedContext: string): string {
  if (!cachedContext.trim()) return system
  return `${system}\n\n<document_context>\n${cachedContext}\n</document_context>`
}

function openAiContent(
  message: LlmMessage,
): string | ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[] {
  const hasImage = message.content.some((part) => part.type === 'image')
  if (!hasImage) {
    return message.content
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
  }
  return message.content.map((part) =>
    part.type === 'text'
      ? { type: 'text' as const, text: part.text }
      : { type: 'image_url' as const, image_url: { url: dataUrl(part.image) } },
  )
}

function toOpenAiMessages(
  system: string,
  cachedContext: string,
  messages: LlmMessage[],
): { role: string; content: unknown }[] {
  return [
    { role: 'system', content: contextBlock(system, cachedContext) },
    ...messages.map((message) => ({
      role: message.role,
      content: openAiContent(message),
    })),
  ]
}

function toAnthropicMessages(
  messages: LlmMessage[],
): { role: 'user' | 'assistant'; content: unknown[] }[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content.map((part) =>
      part.type === 'text'
        ? { type: 'text', text: part.text }
        : {
            type: 'image',
            source: {
              type: 'base64',
              media_type: part.image.mediaType,
              data: part.image.data,
            },
          },
    ),
  }))
}

async function errorFromResponse(res: Response, label: string): Promise<Error> {
  const raw = await res.text().catch(() => '')
  let detail = raw
  try {
    const parsed = JSON.parse(raw) as {
      error?: { message?: string } | string
      message?: string
    }
    if (typeof parsed.error === 'string') detail = parsed.error
    else if (parsed.error?.message) detail = parsed.error.message
    else if (parsed.message) detail = parsed.message
  } catch {
    /* keep raw text */
  }
  const clean = detail.replace(/\s+/g, ' ').trim().slice(0, 500)
  const hint =
    res.status === 401 || res.status === 403
      ? '（API Key 无效或无权限）'
      : res.status === 404
        ? '（接口地址或模型不存在）'
        : res.status === 429
          ? '（请求过于频繁或额度不足）'
          : ''
  return new Error(`${label} ${res.status}${hint}: ${clean || res.statusText}`)
}

type SseHandler = (data: string) => void

async function consumeSse(res: Response, onData: SseHandler): Promise<void> {
  if (!res.body) throw new Error('Streaming is not supported by this provider.')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const handleLine = (rawLine: string) => {
    let line = rawLine
    if (line.endsWith('\r')) line = line.slice(0, -1)
    if (!line || line.startsWith(':') || !line.startsWith('data:')) return
    const data = line.slice(5).trimStart()
    if (!data || data === '[DONE]') return
    onData(data)
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      handleLine(buffer.slice(0, index))
      buffer = buffer.slice(index + 1)
      index = buffer.indexOf('\n')
    }
  }
  buffer += decoder.decode()
  if (buffer.trim()) handleLine(buffer)
}

/** DeepSeek 等端点支持 OpenAI 风格的 thinking 字段 */
function supportsOpenAiThinkingToggle(config: ResolvedAiConfig): boolean {
  return (
    /deepseek/i.test(config.apiBase) || /^deepseek[-_/]/i.test(config.model)
  )
}

function extractOpenAiText(data: unknown): string {
  const parsed = data as {
    choices?: {
      message?: { content?: unknown }
      delta?: { content?: unknown }
    }[]
  }
  const content = parsed.choices?.[0]?.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === 'object' && 'text' in part
          ? String((part as { text?: unknown }).text ?? '')
          : '',
      )
      .join('')
  }
  return ''
}

function extractOpenAiReasoning(data: unknown): string {
  const parsed = data as {
    choices?: {
      message?: { reasoning_content?: unknown; reasoning?: unknown }
    }[]
  }
  const msg = parsed.choices?.[0]?.message
  const raw = msg?.reasoning_content ?? msg?.reasoning
  return typeof raw === 'string' ? raw : ''
}

function emptyResponseError(hadReasoning: boolean): Error {
  return new Error(
    hadReasoning
      ? '模型只返回了思考内容、没有正文（思考模式占满了 token 预算）。请增大 max_tokens，或关闭 thinking。'
      : 'The provider returned an empty response.',
  )
}

async function requestOpenAi(
  config: ResolvedAiConfig,
  body: Record<string, unknown>,
  stream: boolean,
  signal?: AbortSignal,
): Promise<Response> {
  const url = openAiChatUrl(config)
  const key = config.apiKey.trim()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (key) {
    if (isAzureOpenAi(config)) headers['api-key'] = key
    else headers.Authorization = `Bearer ${key}`
  }
  const res = await aiFetch(url, {
    method: 'POST',
    signal,
    headers,
    body: JSON.stringify({ ...body, stream }),
  })
  return res
}

export async function streamOpenAiCompatible(
  config: ResolvedAiConfig,
  system: string,
  cachedContext: string,
  messages: LlmMessage[],
  callbacks: StreamCallbacks,
  options: HttpCallOptions = {},
): Promise<string> {
  const stream = options.stream !== false
  const body: Record<string, unknown> = {
    model: config.model,
    messages: toOpenAiMessages(system, cachedContext, messages),
    max_tokens: options.maxTokens ?? 4096,
  }
  if (
    options.openAiThinking &&
    supportsOpenAiThinkingToggle(config)
  ) {
    body.thinking = { type: options.openAiThinking }
  }
  let res = await requestOpenAi(config, body, stream, options.signal)

  if (!res.ok && (res.status === 400 || res.status === 422)) {
    const raw = await res.clone().text().catch(() => '')
    if (/max_tokens|max_completion_tokens|max completion tokens/i.test(raw)) {
      // GPT-5 / o 系列推理模型要求 max_completion_tokens
      body.max_completion_tokens = body.max_tokens
      delete body.max_tokens
      res = await requestOpenAi(config, body, stream, options.signal)
    } else if (stream && /stream/i.test(raw)) {
      // 少数兼容端点不支持 stream，自动重试一次非流式
      res = await requestOpenAi(config, body, false, options.signal)
    } else if (
      body.thinking &&
      /thinking|reasoning/i.test(raw)
    ) {
      // 端点不认识 thinking 字段时去掉再试
      delete body.thinking
      res = await requestOpenAi(config, body, stream, options.signal)
    }
  }
  if (!res.ok) throw await errorFromResponse(res, 'OpenAI API')

  const retryWithoutThinking = async (hadReasoning: boolean) => {
    if (
      options.openAiThinking === 'disabled' ||
      !supportsOpenAiThinkingToggle(config)
    ) {
      throw emptyResponseError(hadReasoning)
    }
    // 思考占满预算 → 关掉 thinking 再试一次短请求
    return streamOpenAiCompatible(
      config,
      system,
      cachedContext,
      messages,
      callbacks,
      { ...options, openAiThinking: 'disabled' },
    )
  }

  const contentType = res.headers.get('content-type') || ''
  if (!stream || !contentType.includes('event-stream')) {
    const data = (await res.json()) as unknown
    const text = extractOpenAiText(data).trim()
    if (!text) {
      return retryWithoutThinking(!!extractOpenAiReasoning(data).trim())
    }
    callbacks.onDelta(text)
    return text
  }

  let full = ''
  let sawReasoning = false
  try {
    await consumeSse(res, (data) => {
      let parsed: {
        error?: { message?: string }
        choices?: {
          delta?: {
            content?: unknown
            reasoning_content?: string
            reasoning?: string
          }
        }[]
      }
      try {
        parsed = JSON.parse(data)
      } catch {
        return
      }
      if (parsed.error?.message) throw new Error(parsed.error.message)
      const delta = parsed.choices?.[0]?.delta
      if (!delta) return

      const content = delta.content
      let piece = ''
      if (typeof content === 'string') piece = content
      else if (Array.isArray(content)) {
        piece = content
          .map((part) =>
            part && typeof part === 'object' && 'text' in part
              ? String((part as { text?: unknown }).text ?? '')
              : '',
          )
          .join('')
      }
      if (piece) {
        full += piece
        callbacks.onDelta(piece)
      }
      const reasoning = delta.reasoning_content ?? delta.reasoning
      if (typeof reasoning === 'string' && reasoning) {
        sawReasoning = true
        callbacks.onThinking?.(reasoning)
      }
    })
  } catch (error) {
    if (full.trim()) return full
    throw error
  }

  if (!full.trim()) {
    return retryWithoutThinking(sawReasoning)
  }
  return full
}

async function requestAnthropic(
  config: ResolvedAiConfig,
  body: Record<string, unknown>,
  options: HttpCallOptions,
): Promise<Response> {
  // 允许用户填 https://api.anthropic.com 或 .../v1，统一拼成 /v1/messages
  const base = baseFor(config, 'https://api.anthropic.com').replace(/\/v1$/, '')
  const url = `${base}/v1/messages`
  return aiFetch(url, {
    method: 'POST',
    signal: options.signal,
    headers: {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      // 允许在桌面 WebView（浏览器环境）中直接调用 Anthropic API
      'anthropic-dangerous-direct-browser-access': 'true',
      ...(config.apiKey.trim() ? { 'x-api-key': config.apiKey.trim() } : {}),
    },
    body: JSON.stringify(body),
  })
}

async function anthropicRequest(
  config: ResolvedAiConfig,
  system: string,
  cachedContext: string,
  messages: LlmMessage[],
  options: HttpCallOptions,
): Promise<Response> {
  const stream = options.stream !== false
  const systemBlocks: unknown[] = [{ type: 'text', text: system }]
  if (cachedContext.trim()) {
    systemBlocks.push({
      type: 'text',
      text: `<document_context>\n${cachedContext}\n</document_context>`,
      // prompt caching：同一文档的后续追问只按缓存读取计费
      cache_control: { type: 'ephemeral' },
    })
  }
  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: options.maxTokens ?? 8192,
    system: systemBlocks,
    messages: toAnthropicMessages(messages),
  }
  if (stream) body.stream = true
  if (options.thinking) body.thinking = { type: 'adaptive' }

  let res = await requestAnthropic(config, body, options)
  if (!res.ok && options.thinking && (res.status === 400 || res.status === 422)) {
    const raw = await res.clone().text().catch(() => '')
    if (/thinking|adaptive/i.test(raw)) {
      delete body.thinking
      res = await requestAnthropic(config, body, options)
    }
  }
  if (!res.ok && stream) {
    const raw = await res.clone().text().catch(() => '')
    if ((res.status === 400 || res.status === 422) && /stream/i.test(raw)) {
      delete body.stream
      res = await requestAnthropic(config, body, options)
    }
  }
  return res
}

function extractAnthropicText(data: unknown): string {
  const parsed = data as { content?: { type?: string; text?: string }[] }
  return (parsed.content || [])
    .filter((block) => block.type === 'text' && block.text)
    .map((block) => block.text)
    .join('')
}

export async function streamAnthropic(
  config: ResolvedAiConfig,
  system: string,
  cachedContext: string,
  messages: LlmMessage[],
  callbacks: StreamCallbacks,
  options: HttpCallOptions = {},
): Promise<string> {
  const stream = options.stream !== false
  const res = await anthropicRequest(
    config,
    system,
    cachedContext,
    messages,
    options,
  )
  if (!res.ok) throw await errorFromResponse(res, 'Anthropic API')

  const contentType = res.headers.get('content-type') || ''
  if (!stream || !contentType.includes('event-stream')) {
    const data = (await res.json()) as unknown
    const text = extractAnthropicText(data).trim()
    if (!text) throw new Error('Anthropic API returned an empty response.')
    callbacks.onDelta(text)
    return text
  }

  let full = ''
  try {
    await consumeSse(res, (data) => {
      let event: {
        type?: string
        delta?: {
          type?: string
          text?: string
          thinking?: string
          stop_reason?: string
        }
        content_block?: { type?: string; text?: string }
        error?: { message?: string }
      }
      try {
        event = JSON.parse(data)
      } catch {
        return
      }
      if (event.type === 'error') {
        throw new Error(event.error?.message || 'Anthropic stream error')
      }
      if (event.type === 'content_block_delta') {
        const delta = event.delta
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          full += delta.text
          callbacks.onDelta(delta.text)
        } else if (
          delta?.type === 'thinking_delta' &&
          typeof delta.thinking === 'string'
        ) {
          callbacks.onThinking?.(delta.thinking)
        }
      }
      if (
        event.type === 'content_block_start' &&
        event.content_block?.type === 'text' &&
        event.content_block.text
      ) {
        full += event.content_block.text
        callbacks.onDelta(event.content_block.text)
      }
    })
  } catch (error) {
    if (full.trim()) return full
    throw error
  }
  if (!full.trim()) throw new Error('Anthropic API returned an empty response.')
  return full
}

/** 非流式一次性调用（测试连接等短请求） */
export async function completeOpenAiCompatible(
  config: ResolvedAiConfig,
  system: string,
  user: string,
  options: HttpCallOptions = {},
): Promise<string> {
  return streamOpenAiCompatible(
    config,
    system,
    '',
    [{ role: 'user', content: [{ type: 'text', text: user }] }],
    { onDelta: () => {} },
    { ...options, stream: false, maxTokens: options.maxTokens ?? 64 },
  )
}

export async function completeAnthropic(
  config: ResolvedAiConfig,
  system: string,
  user: string,
  options: HttpCallOptions = {},
): Promise<string> {
  return streamAnthropic(
    config,
    system,
    '',
    [{ role: 'user', content: [{ type: 'text', text: user }] }],
    { onDelta: () => {} },
    { ...options, stream: false, maxTokens: options.maxTokens ?? 64 },
  )
}

function looksLikeChatModel(id: string): boolean {
  return !/embed|embedding|whisper|tts|dall-e|moderation|transcribe|rerank|image-generation|audio|realtime/i.test(
    id,
  )
}

export async function fetchModelList(
  config: ResolvedAiConfig,
): Promise<ModelInfo[]> {
  if (config.provider === 'claude-code' || config.provider === 'codex') {
    return []
  }
  if (isAzureOpenAi(config) || /\/openai\/deployments\//i.test(config.apiBase)) {
    throw new Error(
      'Azure OpenAI does not expose a model list here; enter the deployment name manually.',
    )
  }
  const base = baseFor(config, 'https://api.openai.com/v1')
  const anthropic = config.provider === 'anthropic'
  const url = anthropic
    ? `${baseFor(config, 'https://api.anthropic.com').replace(/\/v1$/, '')}/v1/models?limit=100`
    : `${base}/models`
  const res = await aiFetch(url, {
    headers: anthropic
      ? {
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
          ...(config.apiKey.trim() ? { 'x-api-key': config.apiKey.trim() } : {}),
        }
      : config.apiKey.trim()
        ? { Authorization: `Bearer ${config.apiKey.trim()}` }
        : {},
  })
  if (!res.ok) throw await errorFromResponse(res, 'Model list')

  const data = (await res.json()) as {
    data?: { id?: string; display_name?: string; name?: string }[]
    models?: { name?: string; model?: string }[]
  }
  const rows = (data.data ?? data.models ?? []) as {
    id?: string
    display_name?: string
    name?: string
    model?: string
  }[]
  const seen = new Set<string>()
  const models: ModelInfo[] = []
  for (const row of rows) {
    const raw = row.id || row.name || row.model || ''
    const id = raw.replace(/^models\//, '').trim()
    if (!id || seen.has(id) || !looksLikeChatModel(id)) continue
    seen.add(id)
    models.push({
      id,
      label:
        typeof row.display_name === 'string' ? row.display_name : undefined,
    })
  }
  models.sort((a, b) => a.id.localeCompare(b.id))
  return models
}

/** 简短测试调用，返回模型原文 */
export async function testProvider(
  config: ResolvedAiConfig,
  locale: AppLocale,
): Promise<string> {
  const system =
    locale === 'en'
      ? 'You are a connection test. Follow the user instruction exactly.'
      : '你是一个连接测试助手，严格按用户要求回复。'
  const prompt =
    locale === 'en' ? 'Reply with exactly: OK' : '请只回复两个字：正常'
  if (config.provider === 'anthropic') {
    return completeAnthropic(config, system, prompt, { maxTokens: 64 })
  }
  // DeepSeek 等默认开启思考；测试连接时关闭，避免正文被推理占空
  return completeOpenAiCompatible(config, system, prompt, {
    maxTokens: 256,
    openAiThinking: supportsOpenAiThinkingToggle(config)
      ? 'disabled'
      : undefined,
  })
}
