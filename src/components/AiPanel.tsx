import { useCallback, useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { MarkdownMessage } from './MarkdownMessage'
import {
  aiConfigIssue,
  buildTaskDisplay,
  buildTaskUserText,
  clearChat,
  clearDocCoach,
  getActiveProvider,
  isCliKind,
  loadChat,
  loadDocCoach,
  parseHighlightSuggestions,
  renderPageImage,
  runStudyChat,
  saveChat,
  saveDocCoach,
  starterQuestions,
  useDocIndex,
  type AiDocCoach,
  type AiHighlightSuggestion,
} from '../lib/ai'
import type { MessageKey } from '../lib/i18n'
import { useI18n } from '../lib/i18n/I18nContext'
import type {
  AiActionRequest,
  AiChatMessage,
  AiSelectionContext,
  AiSettings,
  AiTask,
  Highlight,
  HighlightPaletteItem,
  OcrPageOverlay,
  PageAnnotation,
} from '../lib/pdf/types'
import type { PageOutlineNode } from '../lib/index/pageOutline'

type Props = {
  open: boolean
  settings: AiSettings
  fileKey: string | null
  fileName: string | null
  pdf: PDFDocumentProxy | null
  currentPage: number
  pageCount: number
  highlights: Highlight[]
  highlightPalette: HighlightPaletteItem[]
  pageAnnotations: PageAnnotation[]
  pageOutline: PageOutlineNode[]
  ocrOverlays: OcrPageOverlay[]
  /** 抽字失败时 OCR；不要在回调里直接 setState 改签名 */
  ocrEmptyPage?: (pageIndex: number) => Promise<OcrPageOverlay | null>
  onOcrOverlaysCommitted?: (overlays: OcrPageOverlay[]) => void
  selection: AiSelectionContext | null
  action: AiActionRequest | null
  onConsumeAction: () => void
  onClearSelection: () => void
  onClose: () => void
  onOpenSettings: () => void
  onWritePageNote: (body: string, pageIndex: number) => void
  onApplyHighlights: (suggestions: AiHighlightSuggestion[]) => Promise<void>
  onGotoPage: (pageIndex: number) => void
}

type ExecuteOptions = {
  selection?: AiSelectionContext | null
  displayText?: string
  userText?: string
  attachImage?: boolean
  appendUser?: boolean
  history?: AiChatMessage[]
  pageIndex?: number
}

const SELECTION_TASKS: AiTask[] = [
  'summarize-selection',
  'explain-selection',
  'translate-selection',
]

const INDEX_TASKS: AiTask[] = [
  'summarize-doc',
  'prepare-coach',
  'quiz',
  'flashcards',
  'mindmap',
  'summarize-highlights',
  'structured-notes',
  'organize-outline',
]

const QUICK_ACTIONS: { task: AiTask; key: MessageKey }[] = [
  { task: 'summarize-page', key: 'ai.quick.summarizePage' },
  { task: 'quiz', key: 'ai.quick.quiz' },
  { task: 'flashcards', key: 'ai.quick.flashcards' },
  { task: 'mindmap', key: 'ai.quick.mindmap' },
  { task: 'summarize-doc', key: 'ai.quick.docSummary' },
  { task: 'summarize-highlights', key: 'ai.quick.highlights' },
  { task: 'suggest-highlights', key: 'ai.quick.suggestHighlights' },
]

const STUDY_TOOLS: { task: AiTask; key: MessageKey }[] = [
  { task: 'summarize-page', key: 'ai.quick.summarizePage' },
  { task: 'summarize-doc', key: 'ai.quick.docSummary' },
  { task: 'summarize-highlights', key: 'ai.quick.highlights' },
  { task: 'suggest-highlights', key: 'ai.quick.suggestHighlights' },
  { task: 'structured-notes', key: 'ai.quick.notes' },
  { task: 'organize-outline', key: 'ai.quick.outline' },
  { task: 'quiz', key: 'ai.quick.quiz' },
  { task: 'flashcards', key: 'ai.quick.flashcards' },
  { task: 'mindmap', key: 'ai.quick.mindmap' },
  { task: 'explain-selection', key: 'ai.quick.explain' },
  { task: 'translate-selection', key: 'ai.quick.translate' },
  { task: 'summarize-selection', key: 'ai.quick.summarizeSelection' },
  { task: 'vision-page', key: 'ai.quick.vision' },
]

function isSelectionTask(task: AiTask): boolean {
  return SELECTION_TASKS.includes(task)
}

function requiresIndex(task: AiTask): boolean {
  return INDEX_TASKS.includes(task)
}

function abortError(): DOMException {
  return new DOMException('Aborted', 'AbortError')
}

function contextLabel(
  mode: AiChatMessage['contextMode'],
  t: (key: MessageKey) => string,
): string {
  switch (mode) {
    case 'full':
      return t('ai.context.full')
    case 'retrieval':
      return t('ai.context.retrieval')
    case 'page':
      return t('ai.context.page')
    case 'selection':
      return t('ai.context.selection')
    default:
      return t('ai.context.none')
  }
}

function fallbackLabel(
  fallback: AiChatMessage['fallback'],
  t: (key: MessageKey) => string,
): string {
  switch (fallback) {
    case 'too-large':
      return t('ai.fallback.too-large')
    case 'not-indexed':
      return t('ai.fallback.not-indexed')
    case 'scanned':
      return t('ai.fallback.scanned')
    case 'cli-limit':
      return t('ai.fallback.cli-limit')
    case 'no-text':
      return t('ai.fallback.no-text')
    default:
      return ''
  }
}

function stageText(
  stage: 'index' | 'image' | 'context' | 'ocr' | null,
  t: (key: MessageKey) => string,
): string {
  if (stage === 'index') return t('ai.indexWait')
  if (stage === 'ocr') return t('ai.stage.ocr')
  if (stage === 'image') return t('ai.stage.image')
  if (stage === 'context') return t('ai.stage.context')
  return ''
}

export function AiPanel({
  open,
  settings,
  fileKey,
  fileName,
  pdf,
  currentPage,
  pageCount,
  highlights,
  highlightPalette,
  pageAnnotations,
  pageOutline,
  ocrOverlays,
  ocrEmptyPage,
  onOcrOverlaysCommitted,
  selection,
  action,
  onConsumeAction,
  onClearSelection,
  onClose,
  onOpenSettings,
  onWritePageNote,
  onApplyHighlights,
  onGotoPage,
}: Props) {
  const { t, locale } = useI18n()
  const [messages, setMessages] = useState<AiChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState<
    'index' | 'image' | 'context' | 'ocr' | null
  >(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [toolsOpen, setToolsOpen] = useState(false)
  const [applyingHighlightsId, setApplyingHighlightsId] = useState<string | null>(
    null,
  )
  const [coach, setCoach] = useState<AiDocCoach | null>(null)
  const [coachBusy, setCoachBusy] = useState(false)
  const [attachImage, setAttachImage] = useState(false)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const abortRef = useRef<AbortController | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const stickRef = useRef(true)
  const loadedRef = useRef<string | null>(null)
  const handledActionRef = useRef<number | null>(null)
  const messagesRef = useRef<AiChatMessage[]>([])
  const executeRef = useRef<
    (task: AiTask, options?: ExecuteOptions) => Promise<string | null>
  >(async () => null)

  const provider = getActiveProvider(settings)
  const providerIssue = aiConfigIssue(provider, locale)
  const providerIsCli = isCliKind(provider.kind)
  const ocrEmptyPageWithNotice = useCallback(
    async (pageIndex: number) => {
      if (!ocrEmptyPage) return null
      setStage('ocr')
      setNotice(
        t('ai.ocr.page', { page: pageIndex + 1 }),
      )
      try {
        return await ocrEmptyPage(pageIndex)
      } finally {
        // stage 由外层流程继续推进
      }
    },
    [ocrEmptyPage, t],
  )

  const { index, state: indexState, ensureIndex, cancel: cancelIndex, pageText } =
    useDocIndex({
      pdf,
      fileKey,
      ocrOverlays,
      enabled: open,
      ocrEmptyPage: ocrEmptyPageWithNotice,
      onOcrOverlaysCommitted,
    })

  messagesRef.current = messages

  useEffect(() => {
    if (!open) {
      // 关闭面板时立即落盘，避免 500ms 防抖保存被清理掉
      if (
        fileKey &&
        settings.study.keepHistory &&
        loadedRef.current === fileKey
      ) {
        saveChat(fileKey, messagesRef.current)
      }
      abortRef.current?.abort()
      abortRef.current = null
      setBusy(false)
      setStage(null)
      return
    }
    abortRef.current?.abort()
    abortRef.current = null
    setBusy(false)
    setStage(null)
    setError(null)
    setNotice(null)
    setToolsOpen(false)
    setAttachImage(false)
    setDraft('')
    // App 在切换文件时会把 action id 归零；重置已处理标记，避免吞掉新文件的第 1 个动作
    handledActionRef.current = null
    const loaded =
      fileKey && settings.study.keepHistory ? loadChat(fileKey) : []
    setMessages(loaded)
    loadedRef.current = fileKey
    setCoach(fileKey ? loadDocCoach(fileKey) : null)
    setCoachBusy(false)
    const timer = window.setTimeout(() => textareaRef.current?.focus(), 30)
    return () => window.clearTimeout(timer)
    // 只在切换文件或重新打开面板时加载；keepHistory 的后续变化不重载
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileKey, open])

  useEffect(() => {
    if (!fileKey || !settings.study.keepHistory || busy) return
    if (loadedRef.current !== fileKey) return
    const timer = window.setTimeout(() => {
      if (loadedRef.current !== fileKey) return
      saveChat(fileKey, messagesRef.current)
    }, 500)
    return () => window.clearTimeout(timer)
  }, [messages, busy, fileKey, settings.study.keepHistory])

  useEffect(() => {
    if (!stickRef.current || !open) return
    const list = listRef.current
    if (list) list.scrollTop = list.scrollHeight
  }, [messages, open, busy])

  const updateAssistant = (
    id: string,
    patch: Partial<AiChatMessage>,
  ) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === id ? { ...m, ...patch } : m)),
    )
  }

  const copyText = async (text: string, id: string) => {
    if (!text.trim()) return
    try {
      await navigator.clipboard.writeText(text)
      setCopiedId(id)
      window.setTimeout(() => setCopiedId(null), 1500)
    } catch {
      /* ignore */
    }
  }

  const execute = async (
    task: AiTask,
    options: ExecuteOptions = {},
  ): Promise<string | null> => {
    if (!fileKey || !fileName || abortRef.current) return null
    if (providerIssue) {
      setError(providerIssue)
      return null
    }
    const sel = options.selection ?? null
    if (isSelectionTask(task) && !sel?.text.trim()) {
      setNotice(t('ai.selectFirst'))
      return null
    }

    const promptText =
      options.userText ??
      (task === 'chat'
        ? draft.trim()
        : buildTaskUserText(task, locale, {
            currentPage,
            selection: sel ?? undefined,
            paletteLabels: highlightPalette.map((p) => p.label),
          }))
    let userText = promptText
    const selectedText = sel?.text.trim() ?? ''
    // 划词后直接在对话框提问时，也把选中原文带给模型
    if (task === 'chat' && selectedText && !userText.includes(selectedText)) {
      const header =
        locale === 'en'
          ? `[Selected text / p${sel!.pageIndex + 1}]`
          : `【选中文本 / p${sel!.pageIndex + 1}】`
      userText = `${userText}\n\n${header}\n${selectedText}`
    }
    if (!userText.trim()) return null
    const displayText =
      options.displayText ??
      (task === 'chat'
        ? promptText
        : buildTaskDisplay(task, locale, {
            currentPage,
            selection: sel ?? undefined,
            paletteLabels: highlightPalette.map((p) => p.label),
          }))

    const ac = new AbortController()
    abortRef.current = ac
    setBusy(true)
    setError(null)
    setNotice(null)
    setStage(null)

    // 重新生成旧回答时沿用当时的页面；划词任务优先用选中页
    const contextPage =
      options.pageIndex ??
      (selectedText ? sel!.pageIndex : currentPage)
    const assistantId = crypto.randomUUID()
    const baseHistory = options.history ?? messages
    const history = baseHistory.filter(
      (m) => !(m.role === 'assistant' && m.error && !m.content.trim()),
    )

    if (options.appendUser !== false) {
      const userMessage: AiChatMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        content: displayText,
        llmText: userText,
        createdAt: Date.now(),
        task,
        pageIndex: contextPage,
        selection: sel ?? undefined,
      }
      setMessages((prev) => [...prev, userMessage])
    }
    const assistantMessage: AiChatMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
      task,
      pageIndex: contextPage,
    }
    setMessages((prev) => [...prev, assistantMessage])

    try {
      let activeIndex = index
      if (requiresIndex(task)) {
        setStage('index')
        // 全书类任务：空白页自动 OCR 后再索引，避免扫描件「读不到」
        activeIndex = await ensureIndex({ ocrEmptyPages: true })
        if (ac.signal.aborted) throw abortError()
      }

      setStage('context')
      // 当前页 / 选中页：无文字则先 OCR 再给模型
      setNotice(null)
      const currentPageText = await pageText(contextPage)
      const selectionWithPage = sel
        ? { ...sel, pageText: await pageText(sel.pageIndex) }
        : null
      if (ac.signal.aborted) throw abortError()
      setStage('context')

      let image = undefined as
        | { mediaType: 'image/jpeg' | 'image/png' | 'image/webp'; data: string }
        | undefined
      const wantsImage =
        options.attachImage || task === 'vision-page' || attachImage
      if (wantsImage && pdf) {
        if (providerIsCli) {
          setNotice(t('ai.visionUnsupported'))
        } else {
          setStage('image')
          try {
            image = await renderPageImage(pdf, contextPage)
          } catch {
            setNotice(t('ai.imageFailed'))
          }
          if (ac.signal.aborted) throw abortError()
        }
      }

      const result = await runStudyChat({
        settings,
        locale,
        task,
        userText,
        history,
        context: {
          fileName,
          pageCount,
          currentPage: contextPage,
          pageOutline,
          highlights,
          pageAnnotations,
          pages: activeIndex?.pages ?? [],
          chunks: activeIndex?.chunks ?? [],
          currentPageText,
        },
        selection: selectionWithPage,
        image,
        signal: ac.signal,
        onDelta: (piece) => {
          if (ac.signal.aborted) return null
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, content: m.content + piece }
                : m,
            ),
          )
        },
        onThinking: (piece) => {
          if (ac.signal.aborted) return null
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, thinking: (m.thinking || '') + piece }
                : m,
            ),
          )
        },
        onMeta: (meta) => {
          if (ac.signal.aborted) return null
          updateAssistant(assistantId, {
            pagesUsed: meta.pagesUsed,
            contextMode: meta.mode,
            contextTokens: meta.contextTokens,
            fallback: meta.fallback,
            pageIndex: contextPage,
          })
        },
      })
      if (ac.signal.aborted) return null
      updateAssistant(assistantId, {
        content: result.text,
        thinking: result.thinking || undefined,
        provider: result.provider,
        model: result.model,
        pagesUsed: result.meta.pagesUsed,
        contextMode: result.meta.mode,
        contextTokens: result.meta.contextTokens,
        fallback: result.meta.fallback,
        pageIndex: contextPage,
        error: undefined,
      })
      setStage(null)
      return result.text
    } catch (e) {
      if ((e as { name?: string })?.name === 'AbortError' || ac.signal.aborted) {
        if (abortRef.current && abortRef.current !== ac) return null
        setMessages((prev) =>
          prev.filter(
            (m) => !(m.id === assistantId && !m.content.trim()),
          ),
        )
        setNotice(t('ai.stopped'))
        setStage(null)
        return null
      }
      const text = e instanceof Error ? e.message : String(e)
      updateAssistant(assistantId, { error: text })
      setError(text)
      setStage(null)
      return null
    } finally {
      if (abortRef.current === ac) {
        abortRef.current = null
        setBusy(false)
        setStage(null)
      }
    }
  }

  executeRef.current = execute

  useEffect(() => {
    if (!open || !action) return
    if (handledActionRef.current === action.id) return
    handledActionRef.current = action.id
    onConsumeAction()
    void executeRef.current(action.task, {
      selection: action.selection ?? null,
      attachImage: action.task === 'vision-page',
    })
    // action 是一次性触发；execute 通过 ref 取最新闭包
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action, open])

  const persistCoach = (next: AiDocCoach) => {
    saveDocCoach(next)
    setCoach(next)
  }

  const startQuickCoach = () => {
    if (!fileKey || !fileName || providerIssue) return
    const now = Date.now()
    const briefing =
      locale === 'en'
        ? `I'm your study coach for **${fileName}**. Ask questions, request page notes, or run **Suggest highlights** when you want key passages marked.`
        : `我是「**${fileName}**」的专属学习助手。你可以随时提问答疑；需要落盘时用「写入页批注」；要划重点时用「建议高亮」再一键应用。`
    persistCoach({
      fileKey,
      fileName,
      mode: 'quick',
      ready: true,
      briefing,
      createdAt: coach?.createdAt ?? now,
      updatedAt: now,
    })
    if (messages.length === 0) {
      const welcome: AiChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: briefing,
        createdAt: now,
        task: 'prepare-coach',
        pageIndex: currentPage,
      }
      setMessages([welcome])
    }
  }

  const startDeepCoach = async () => {
    if (!fileKey || !fileName || providerIssue || coachBusy || busy) return
    setCoachBusy(true)
    setError(null)
    setNotice(t('ai.coach.deepProgress'))
    try {
      setStage('index')
      const built = await ensureIndex({ ocrEmptyPages: true })
      if (!built) {
        throw new Error(
          locale === 'en'
            ? 'Could not index this PDF. Check OCR settings for scanned pages.'
            : '无法建立全书索引。扫描页请确认 OCR（离线或联网）已可用。',
        )
      }
      setStage('context')
      const briefingText = await execute('prepare-coach', {
        appendUser: true,
        displayText: t('ai.coach.deepDisplay'),
      })
      const briefing =
        briefingText?.trim() ||
        (locale === 'en'
          ? `Study coach for ${fileName} is ready (full-document index built).`
          : `「${fileName}」学习助手已就绪（已完成全书索引）。`)
      const now = Date.now()
      persistCoach({
        fileKey,
        fileName,
        mode: 'deep',
        ready: true,
        briefing,
        createdAt: coach?.createdAt ?? now,
        updatedAt: now,
      })
      setNotice(t('ai.coach.deepReady'))
    } catch (e) {
      if ((e as { name?: string })?.name !== 'AbortError') {
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      setCoachBusy(false)
      setStage(null)
    }
  }

  const skipCoach = () => {
    if (!fileKey || !fileName) return
    const now = Date.now()
    persistCoach({
      fileKey,
      fileName,
      mode: 'skipped',
      ready: false,
      briefing: '',
      createdAt: coach?.createdAt ?? now,
      updatedAt: now,
    })
  }

  const rebuildCoach = () => {
    if (!fileKey) return
    clearDocCoach(fileKey)
    setCoach(null)
  }

  const stop = () => {
    abortRef.current?.abort()
    abortRef.current = null
    setBusy(false)
    setCoachBusy(false)
    setStage(null)
  }

  const sendChat = () => {
    const text = draft.trim()
    if (!text || abortRef.current || providerIssue) return
    setDraft('')
    void execute('chat', {
      userText: text,
      displayText: text,
      selection,
    })
  }

  const runTool = (task: AiTask) => {
    if (isSelectionTask(task) && !selection) {
      setNotice(t('ai.selectFirst'))
      return
    }
    void execute(task, {
      selection: isSelectionTask(task) ? selection : null,
      attachImage: task === 'vision-page',
    })
    setToolsOpen(false)
  }

  const clearConversation = () => {
    if (!messages.length) return
    if (!window.confirm(t('ai.clearConfirm'))) return
    abortRef.current?.abort()
    abortRef.current = null
    setBusy(false)
    setMessages([])
    if (fileKey) clearChat(fileKey)
    setError(null)
    setNotice(null)
  }

  const exportConversation = () => {
    if (!messages.length) return
    const body = messages
      .map(
        (m) =>
          `${m.role === 'user' ? t('ai.userLabel') : t('ai.assistantLabel')}:\n${m.content}`,
      )
      .join('\n\n---\n\n')
    void copyText(body, '__all__')
    setNotice(t('ai.exported'))
  }

  const regenerate = (assistantIndex: number) => {
    if (busy) return
    let userIndex = assistantIndex - 1
    while (userIndex >= 0 && messages[userIndex].role !== 'user') userIndex--
    if (userIndex < 0) return
    const user = messages[userIndex]
    if (isSelectionTask(user.task ?? 'chat') && !user.selection) {
      setNotice(t('ai.selectFirst'))
      return
    }
    const history = messages.slice(0, userIndex)
    setMessages(messages.slice(0, userIndex + 1))
    void execute(user.task ?? 'chat', {
      userText: user.llmText || user.content,
      displayText: user.content,
      selection: user.selection ?? null,
      history,
      appendUser: false,
      pageIndex: user.pageIndex,
      attachImage: user.task === 'vision-page',
    })
  }

  if (!open) return null

  const indexPercent =
    indexState.total > 0
      ? Math.min(100, Math.round((indexState.done / indexState.total) * 100))
      : 0
  const indexLabel =
    indexState.status === 'building'
      ? t('ai.index.building', {
          done: indexState.done,
          total: indexState.total,
        })
      : indexState.status === 'ready'
        ? t('ai.index.ready', {
            pages: index?.pages.length ?? indexState.total,
          })
        : indexState.status === 'error'
          ? t('ai.index.error')
          : t('ai.index.idle')
  const currentStage = stageText(stage, t)

  const toolsDisabled = busy || coachBusy || !!providerIssue || !fileName
  const showCoachSetup = !!fileName && !providerIssue && !coach

  return (
    <aside className="ai-panel" aria-label={t('ai.coach.title')}>
      <header className="ai-panel-head">
        <div className="ai-panel-title">
          <h2>{t('ai.coach.title')}</h2>
          <span className="ai-panel-subtitle">
            {fileName
              ? t('ai.coach.forFile', { name: fileName })
              : t('ai.coach.noFile')}
            {provider.model ? ` · ${provider.model}` : ` · ${provider.name}`}
          </span>
        </div>
        <div className="ai-panel-head-actions">
          <button
            type="button"
            className="btn tiny"
            onClick={exportConversation}
            disabled={!messages.length}
            title={t('ai.export')}
          >
            {t('ai.copy')}
          </button>
          <button
            type="button"
            className="btn tiny"
            onClick={clearConversation}
            disabled={!messages.length}
            title={t('ai.clearChat')}
          >
            {t('ai.clearChat')}
          </button>
          <button
            type="button"
            className="btn icon-btn"
            onClick={onOpenSettings}
            title={t('ai.openSettings')}
            aria-label={t('ai.openSettings')}
          >
            ⚙
          </button>
          <button
            type="button"
            className="btn icon-btn"
            onClick={onClose}
            title={t('ai.close')}
            aria-label={t('ai.close')}
          >
            ✕
          </button>
        </div>
      </header>

      <div className="ai-context-bar">
        <span
          className={`ai-status-dot is-${indexState.status}`}
          aria-hidden
        />
        <span className="ai-context-text">{indexLabel}</span>
        {indexState.status === 'building' ? (
          <button
            type="button"
            className="btn tiny"
            onClick={cancelIndex}
          >
            {t('ai.index.cancel')}
          </button>
        ) : null}
      </div>
      {indexState.status === 'building' ? (
        <div className="ai-progress" aria-hidden>
          <span style={{ width: `${indexPercent}%` }} />
        </div>
      ) : null}
      {indexState.status === 'ready' && (index?.scannedPages ?? 0) > 0 ? (
        <p className="ai-index-hint">
          {t('ai.index.scanned', { count: index?.scannedPages ?? 0 })}
        </p>
      ) : null}

      {providerIssue ? (
        <div className="ai-provider-warning">
          <div>
            <strong>{t('ai.providerIssue')}</strong>
            <span>{providerIssue}</span>
          </div>
          <button type="button" className="btn tiny" onClick={onOpenSettings}>
            {t('ai.configure')}
          </button>
        </div>
      ) : null}

      {coach?.ready && !showCoachSetup ? (
        <div className="ai-coach-actions is-bar">
          <button
            type="button"
            className="ai-coach-action"
            disabled={toolsDisabled}
            onClick={() => runTool('suggest-highlights')}
          >
            {t('ai.coach.action.highlight')}
          </button>
          <button
            type="button"
            className="ai-coach-action"
            disabled={toolsDisabled}
            onClick={() => runTool('structured-notes')}
          >
            {t('ai.coach.action.notes')}
          </button>
          <button
            type="button"
            className="ai-coach-action"
            disabled={toolsDisabled}
            onClick={() => {
              setDraft(t('ai.coach.action.askDraft'))
              textareaRef.current?.focus()
            }}
          >
            {t('ai.coach.action.ask')}
          </button>
          <button
            type="button"
            className="btn tiny"
            onClick={rebuildCoach}
            title={t('ai.coach.rebuild')}
          >
            {t('ai.coach.rebuild')}
          </button>
        </div>
      ) : null}

      <div
        className="ai-messages"
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget
          stickRef.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 90
        }}
      >
        {!fileName ? (
          <p className="ai-empty">{t('ai.empty')}</p>
        ) : showCoachSetup ? (
          <div className="ai-coach-setup">
            <h3>{t('ai.coach.setupTitle')}</h3>
            <p className="ai-empty-hint">
              {t('ai.coach.setupDesc', { name: fileName })}
            </p>
            <div className="ai-coach-options">
              <button
                type="button"
                className="ai-coach-option"
                disabled={coachBusy || busy}
                onClick={() => void startDeepCoach()}
              >
                <strong>{t('ai.coach.deep.name')}</strong>
                <span>{t('ai.coach.deep.desc')}</span>
              </button>
              <button
                type="button"
                className="ai-coach-option"
                disabled={coachBusy || busy}
                onClick={startQuickCoach}
              >
                <strong>{t('ai.coach.quick.name')}</strong>
                <span>{t('ai.coach.quick.desc')}</span>
              </button>
            </div>
            <button
              type="button"
              className="btn tiny"
              disabled={coachBusy || busy}
              onClick={skipCoach}
            >
              {t('ai.coach.skip')}
            </button>
            {coachBusy ? (
              <p className="ai-empty-hint">{t('ai.coach.deepProgress')}</p>
            ) : null}
          </div>
        ) : messages.length === 0 ? (
          <div className="ai-empty-state">
            {coach?.ready ? (
              <>
                {coach.briefing ? (
                  <div className="ai-coach-briefing">
                    <MarkdownMessage
                      content={coach.briefing}
                      onGotoPage={onGotoPage}
                    />
                  </div>
                ) : (
                  <>
                    <p className="ai-empty">{t('ai.coach.readyTitle')}</p>
                    <p className="ai-empty-hint">{t('ai.emptyHint')}</p>
                  </>
                )}
                <div className="ai-coach-actions">
                  <button
                    type="button"
                    className="ai-coach-action"
                    disabled={toolsDisabled}
                    onClick={() => runTool('suggest-highlights')}
                  >
                    {t('ai.coach.action.highlight')}
                  </button>
                  <button
                    type="button"
                    className="ai-coach-action"
                    disabled={toolsDisabled}
                    onClick={() => runTool('structured-notes')}
                  >
                    {t('ai.coach.action.notes')}
                  </button>
                  <button
                    type="button"
                    className="ai-coach-action"
                    disabled={toolsDisabled}
                    onClick={() => {
                      setDraft(t('ai.coach.action.askDraft'))
                      textareaRef.current?.focus()
                    }}
                  >
                    {t('ai.coach.action.ask')}
                  </button>
                </div>
                <div className="ai-starters">
                  <p className="ai-starters-title">{t('ai.starterTitle')}</p>
                  {starterQuestions(locale).map((question) => (
                    <button
                      key={question}
                      type="button"
                      className="ai-starter"
                      onClick={() => {
                        setDraft(question)
                        textareaRef.current?.focus()
                      }}
                    >
                      {question}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  className="btn tiny"
                  onClick={rebuildCoach}
                >
                  {t('ai.coach.rebuild')}
                </button>
              </>
            ) : (
              <>
                <p className="ai-empty">{t('ai.coach.skippedTitle')}</p>
                <p className="ai-empty-hint">{t('ai.coach.skippedDesc')}</p>
                <button
                  type="button"
                  className="btn tiny primary"
                  onClick={rebuildCoach}
                >
                  {t('ai.coach.rebuild')}
                </button>
              </>
            )}
          </div>
        ) : (
          messages.map((message, messageIndex) => {
            const isLast = messageIndex === messages.length - 1
            if (message.role === 'user') {
              return (
                <div key={message.id} className="ai-msg ai-msg-user">
                  <div className="ai-user-bubble">{message.content}</div>
                  {message.pageIndex != null ? (
                    <button
                      type="button"
                      className="ai-page-inline"
                      onClick={() => onGotoPage(message.pageIndex!)}
                    >
                      p{message.pageIndex + 1}
                    </button>
                  ) : null}
                </div>
              )
            }
            const highlightSuggestions = message.content
              ? parseHighlightSuggestions(message.content)
              : []
            return (
              <div key={message.id} className="ai-msg ai-msg-assistant">
                <div className="ai-msg-head">
                  <span className="ai-msg-role">{t('ai.assistantLabel')}</span>
                  <span className="ai-msg-model">
                    {message.model || provider.name}
                  </span>
                </div>
                {message.thinking ? (
                  <details className="ai-thinking">
                    <summary>{t('ai.thinking')}</summary>
                    <div className="ai-thinking-body">
                      {message.thinking}
                    </div>
                  </details>
                ) : null}
                {message.content ? (
                  <MarkdownMessage
                    content={message.content}
                    onGotoPage={onGotoPage}
                  />
                ) : null}
                {busy && isLast && !message.content && !message.error ? (
                  <div className="ai-typing" aria-label={t('ai.running')}>
                    <span />
                    <span />
                    <span />
                  </div>
                ) : null}
                {message.error ? (
                  <div className="ai-msg-error">
                    <strong>{t('ai.messageError')}</strong>
                    <span>{message.error}</span>
                  </div>
                ) : null}
                {message.pagesUsed && message.pagesUsed.length ? (
                  <div className="ai-msg-pages">
                    <span>{t('ai.context.pages')}</span>
                    {message.pagesUsed.map((page) => (
                      <button
                        key={page}
                        type="button"
                        className="ai-page-chip"
                        onClick={() => onGotoPage(page)}
                      >
                        p{page + 1}
                      </button>
                    ))}
                  </div>
                ) : null}
                {message.contextMode ? (
                  <div className="ai-msg-context">
                    <span>
                      {t('ai.answerFrom', {
                        mode: contextLabel(message.contextMode, t),
                      })}
                    </span>
                    {message.contextTokens
                      ? ` · ${t('ai.context.tokens', {
                          tokens: message.contextTokens.toLocaleString(),
                        })}`
                      : ''}
                    {message.fallback
                      ? ` · ${fallbackLabel(message.fallback, t)}`
                      : ''}
                  </div>
                ) : null}
                {message.content ? (
                  <div className="ai-msg-actions">
                    <button
                      type="button"
                      className="btn tiny"
                      onClick={() => void copyText(message.content, message.id)}
                    >
                      {copiedId === message.id ? t('ai.copied') : t('ai.copy')}
                    </button>
                    <button
                      type="button"
                      className="btn tiny"
                      onClick={() =>
                        onWritePageNote(
                          message.content,
                          message.pageIndex ?? currentPage,
                        )
                      }
                    >
                      {t('ai.writeNoteAtPage', {
                        page: (message.pageIndex ?? currentPage) + 1,
                      })}
                    </button>
                    {highlightSuggestions.length > 0 ? (
                      <button
                        type="button"
                        className="btn tiny primary"
                        disabled={applyingHighlightsId === message.id || busy}
                        onClick={() => {
                          setApplyingHighlightsId(message.id)
                          void onApplyHighlights(highlightSuggestions).finally(
                            () => {
                              setApplyingHighlightsId(null)
                            },
                          )
                        }}
                      >
                        {applyingHighlightsId === message.id
                          ? t('ai.applyingHighlights')
                          : t('ai.applyHighlights', {
                              count: highlightSuggestions.length,
                            })}
                      </button>
                    ) : null}
                    {isLast && !busy ? (
                      <button
                        type="button"
                        className="btn tiny"
                        onClick={() => regenerate(messageIndex)}
                      >
                        {t('ai.regenerate')}
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            )
          })
        )}
      </div>

      <div className="ai-composer">
        {selection ? (
          <div className="ai-selection-chip">
            <span className="ai-selection-label">
              {t('ai.selection', { page: selection.pageIndex + 1 })}
            </span>
            <span className="ai-selection-text">{selection.text}</span>
            <button
              type="button"
              className="ai-chip-close"
              onClick={onClearSelection}
              title={t('ai.clearSelection')}
              aria-label={t('ai.clearSelection')}
            >
              ✕
            </button>
          </div>
        ) : null}
        {attachImage ? (
          <div className="ai-attach-chip">
            <span>{t('ai.attachImageOn')}</span>
            <button
              type="button"
              className="ai-chip-close"
              onClick={() => setAttachImage(false)}
              aria-label={t('ai.attachImage')}
            >
              ✕
            </button>
          </div>
        ) : null}
        <textarea
          ref={textareaRef}
          className="ai-prompt"
          rows={2}
          value={draft}
          disabled={!fileName}
          placeholder={t('ai.prompt.placeholder')}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (
              e.key === 'Enter' &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault()
              sendChat()
            }
          }}
        />
        <div className="ai-composer-tools">
          <button
            type="button"
            className={`btn tiny${attachImage ? ' primary' : ''}`}
            disabled={!pdf || providerIsCli}
            onClick={() => setAttachImage((v) => !v)}
            title={
              providerIsCli
                ? t('ai.visionUnsupported')
                : t('ai.attachImageHint')
            }
          >
            {attachImage ? t('ai.attachImageOn') : t('ai.attachImage')}
          </button>
          <button
            type="button"
            className={`btn tiny${toolsOpen ? ' primary' : ''}`}
            disabled={!fileName}
            onClick={() => setToolsOpen((v) => !v)}
          >
            {toolsOpen ? t('ai.toolsHide') : t('ai.tools')}
          </button>
        </div>

        {toolsOpen ? (
          <div className="ai-tool-grid">
            {STUDY_TOOLS.map((tool) => {
              const needsSelection = isSelectionTask(tool.task)
              const disabled =
                toolsDisabled ||
                (needsSelection && !selection) ||
                (tool.task === 'vision-page' && providerIsCli)
              return (
                <button
                  key={tool.task}
                  type="button"
                  className="ai-tool-btn"
                  disabled={disabled}
                  onClick={() => runTool(tool.task)}
                >
                  {t(tool.key)}
                </button>
              )
            })}
          </div>
        ) : null}

        {currentStage ? <p className="ai-status">{currentStage}</p> : null}
        {notice ? <p className="ai-status">{notice}</p> : null}
        {error ? (
          <div className="ai-error-inline">
            <span>{error}</span>
            <button
              type="button"
              className="btn tiny"
              onClick={() => setError(null)}
            >
              {t('ai.close')}
            </button>
          </div>
        ) : null}

        <div className="ai-composer-row">
          <div className="ai-quick-row">
            {QUICK_ACTIONS.slice(0, 5).map((item) => (
              <button
                key={item.task}
                type="button"
                className="ai-quick-btn"
                disabled={toolsDisabled}
                onClick={() => runTool(item.task)}
              >
                {t(item.key)}
              </button>
            ))}
          </div>
          {busy ? (
            <button type="button" className="btn primary" onClick={stop}>
              {t('ai.stop')}
            </button>
          ) : (
            <button
              type="button"
              className="btn primary"
              disabled={!draft.trim() || !fileName || !!providerIssue}
              onClick={sendChat}
            >
              {t('ai.send')}
            </button>
          )}
        </div>
      </div>
    </aside>
  )
}
