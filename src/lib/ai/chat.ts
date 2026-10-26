import type {
  AiChatMessage,
  AiProvider,
  AiSelectionContext,
  AiSettings,
  AiTask,
  AppLocale,
} from '../pdf/types'
import type { LlmImage } from './llm'
import { messageText } from './llm'
import {
  buildStudyPrompt,
  type StudyContextInput,
  type StudyPromptMeta,
} from './context'
import { isSelectionTask } from './prompts'
import {
  aiConfigIssue,
  getActiveProvider,
  isCliKind,
  resolveAiConfig,
} from './providers'
import { callAiCli } from './providers/cli'
import {
  fetchModelList,
  streamAnthropic,
  streamOpenAiCompatible,
  testProvider,
  type ModelInfo,
} from './providers/http'

export type StudyDocumentInput = Omit<
  StudyContextInput,
  'task' | 'userText' | 'history' | 'locale' | 'study' | 'provider' | 'selection' | 'image'
>

export type RunStudyChatInput = {
  settings: AiSettings
  locale: AppLocale
  task: AiTask
  /** 发给模型的任务指令 / 用户问题 */
  userText: string
  /** 对话历史（不含本轮用户消息） */
  history: AiChatMessage[]
  context: StudyDocumentInput
  selection?: AiSelectionContext | null
  image?: LlmImage
  signal?: AbortSignal
  onDelta: (text: string) => void
  onThinking?: (text: string) => void
  onMeta?: (meta: StudyPromptMeta) => void
}

export type StudyChatResult = {
  text: string
  thinking: string
  provider: AiProvider
  model: string
  meta: StudyPromptMeta
}

function usesThinking(task: AiTask): boolean {
  return (
    task === 'summarize-doc' ||
    task === 'prepare-coach' ||
    task === 'structured-notes' ||
    task === 'organize-outline' ||
    task === 'quiz' ||
    task === 'flashcards' ||
    task === 'mindmap' ||
    task === 'vision-page'
  )
}

function outputBudget(task: AiTask): number {
  // 思考 token 与正文共享 max_tokens，复杂任务给足空间，避免答案被截断
  return usesThinking(task) ? 8192 : 4096
}

function friendlyError(error: unknown, locale: AppLocale): Error {
  if ((error as { name?: string })?.name === 'AbortError') {
    return error instanceof Error ? error : new Error('Aborted')
  }
  // 直连回退已经把系统代理与直连两条错误链拼好，保留细节，避免被下面的
  // 通用网络提示覆盖。
  if ((error as { name?: string })?.name === 'AiTransportError') {
    return error instanceof Error ? error : new Error(String(error))
  }
  const message = error instanceof Error ? error.message : String(error)
  if (
    error instanceof TypeError ||
    /failed to fetch|network ?error|error sending request|connection (refused|reset|closed)|timed? ?out|dns error/i.test(
      message,
    )
  ) {
    return new Error(
      locale === 'en'
        ? 'Network request failed. Check the API Base, network/proxy, and whether the server is reachable.'
        : '网络请求失败。请检查 API Base、网络/代理，以及服务端是否可达。',
    )
  }
  return error instanceof Error ? error : new Error(message)
}

function buildCliPrompt(
  system: string,
  cachedContext: string,
  messages: ReturnType<typeof buildStudyPrompt>['messages'],
  locale: AppLocale,
  hasImage: boolean,
): string {
  const en = locale === 'en'
  const userLabel = en ? 'User' : '用户'
  const assistantLabel = en ? 'Assistant' : '助手'
  const currentText =
    messages.length > 0 ? messageText(messages[messages.length - 1]).trim() : ''
  const history = currentText ? messages.slice(0, -1) : [...messages]

  const tail = [
    currentText ? `${userLabel}:\n${currentText}` : '',
    hasImage
      ? en
        ? '[Note: a page image was requested, but the CLI channel is text-only. Answer from the extracted text.]'
        : '【说明：本轮请求附带了页面图像，但 CLI 通道仅支持文本，请基于提取出的文字回答。】'
      : '',
    en
      ? 'Now answer the last user message. Output only the answer.'
      : '现在请回答最后一条用户消息，只输出回答内容。',
  ].filter(Boolean)

  // 上下文和历史已由 buildStudyPrompt 按预算裁剪；两条 CLI 都走 stdin，
  // 不受 Windows 命令行长度限制，这里不再二次截断。
  const historyParts = history
    .map((message) => {
      const text = messageText(message).trim()
      if (!text) return ''
      return `${message.role === 'user' ? userLabel : assistantLabel}:\n${text}`
    })
    .filter(Boolean)

  const context = cachedContext.trim()
  const parts = [system]
  if (context) {
    parts.push(`<document_context>\n${context}\n</document_context>`)
  }
  parts.push(...historyParts, ...tail)
  return parts.join('\n\n')
}

export async function runStudyChat(
  input: RunStudyChatInput,
): Promise<StudyChatResult> {
  const {
    settings,
    locale,
    task,
    userText,
    history,
    context,
    selection,
    image,
    signal,
    onDelta,
    onThinking,
    onMeta,
  } = input

  const entry = getActiveProvider(settings)
  const issue = aiConfigIssue(entry, locale)
  if (issue) throw new Error(issue)
  if (isSelectionTask(task) && !selection?.text.trim()) {
    throw new Error(
      locale === 'en'
        ? 'Select some text on the page first.'
        : '请先在页面上选中一段文字。',
    )
  }

  const prompt = buildStudyPrompt({
    ...context,
    task,
    userText,
    history,
    locale,
    study: settings.study,
    provider: entry.kind,
    selection,
    image,
  })
  onMeta?.(prompt.meta)

  const config = resolveAiConfig(settings)
  try {
    if (isCliKind(entry.kind)) {
      const combined = buildCliPrompt(
        prompt.system,
        prompt.cachedContext,
        prompt.messages,
        locale,
        !!image,
      )
      const text = (await callAiCli(config, combined)).trim()
      if (!text) {
        throw new Error(
          locale === 'en' ? 'The model returned an empty response.' : '模型返回了空内容。',
        )
      }
      onDelta(text)
      return {
        text,
        thinking: '',
        provider: config.provider,
        model: config.model,
        meta: prompt.meta,
      }
    }

    let thinking = ''
    const callbacks = {
      signal,
      onDelta,
      onThinking: (piece: string) => {
        thinking += piece
        onThinking?.(piece)
      },
    }
    const options = {
      signal,
      maxTokens: outputBudget(task),
      thinking: usesThinking(task),
    }
    const text = (
      config.provider === 'anthropic'
        ? await streamAnthropic(
            config,
            prompt.system,
            prompt.cachedContext,
            prompt.messages,
            callbacks,
            options,
          )
        : await streamOpenAiCompatible(
            config,
            prompt.system,
            prompt.cachedContext,
            prompt.messages,
            callbacks,
            options,
          )
    ).trim()

    if (!text) {
      throw new Error(
        locale === 'en' ? 'The model returned an empty response.' : '模型返回了空内容。',
      )
    }
    return {
      text,
      thinking,
      provider: config.provider,
      model: config.model,
      meta: prompt.meta,
    }
  } catch (error) {
    throw friendlyError(error, locale)
  }
}

export async function testAiConnection(
  settings: AiSettings,
  locale: AppLocale,
): Promise<string> {
  const entry = getActiveProvider(settings)
  const issue = aiConfigIssue(entry, locale)
  if (issue) throw new Error(issue)
  const config = resolveAiConfig(settings)
  try {
    if (isCliKind(entry.kind)) {
      return await callAiCli(
        config,
        locale === 'en'
          ? 'Reply with exactly one word: OK'
          : '请只回复两个字：正常',
      )
    }
    return await testProvider(config, locale)
  } catch (error) {
    throw friendlyError(error, locale)
  }
}

export async function listAiModels(settings: AiSettings): Promise<ModelInfo[]> {
  const entry = getActiveProvider(settings)
  if (isCliKind(entry.kind)) return []
  return fetchModelList(resolveAiConfig(settings))
}
