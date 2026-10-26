import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type SetStateAction,
} from 'react'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { open } from '@tauri-apps/plugin-dialog'
import { exists, readFile, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { Toolbar } from './components/Toolbar'
import { Sidebar } from './components/Sidebar'
import { Viewer } from './components/Viewer'
import { HighlightPaletteModal } from './components/HighlightPaletteModal'
import { PageNoteModal } from './components/PageNoteModal'
import { SettingsModal } from './components/SettingsModal'
import { AiPanel } from './components/AiPanel'
import { PanelResizeHandle } from './components/PanelResizeHandle'
import {
  HighlightColorMenu,
  type PendingHighlight,
} from './components/HighlightColorMenu'
import { renderPageToCanvas } from './components/PageView'
import { loadPdfFromBytes } from './lib/pdf/loader'
import { getOutlineTree } from './lib/pdf/outline'
import { buildOutlineFromOcr, isLikelyScannedPage } from './lib/pdf/ocrToc'
import { buildTriadIndex } from './lib/index/triad'
import { buildPageOutline } from './lib/index/pageOutline'
import { cloneDocEdit, createDocHistory } from './lib/history/docHistory'
import { locateQuoteOnPage } from './lib/pdf/locateText'
import type { AiHighlightSuggestion } from './lib/ai'
import type {
  AiActionRequest,
  AiSelectionContext,
  AiTask,
  Highlight,
  HighlightPaletteItem,
  OcrPageOverlay,
  OutlineItem,
  PageAnnotation,
  PageTitleMap,
  ProjectFile,
} from './lib/pdf/types'
import {
  applyCustomCss,
  applySmoothAnimations,
  applyTheme,
  fileKeyFromNameAndSize,
  getAiSettings,
  getAppSettings,
  getHighlightPalette,
  getOcrSettings,
  loadDraft,
  resetHighlightPalette,
  saveAiSettings,
  saveAppSettings,
  saveDraft,
  saveHighlightPalette,
  saveOcrSettings,
  sidecarPathForPdf,
} from './lib/storage'
import { applyDocumentLocale } from './lib/i18n'
import { I18nProvider, useI18n } from './lib/i18n/I18nContext'
import {
  cancelOcr,
  canvasToBase64Jpeg,
  formatOcrProgressStatus,
  isOcrCancelledError,
  runPageOcr,
  runPdfOcr,
  yieldToUi,
  type OcrProgressEvent,
} from './lib/ocr/client'
import './App.css'

function isPdfPath(path: string) {
  return /\.pdf$/i.test(path)
}

/** OCR 渲染倍率：够识别即可；过高会导致全书 OCR 时主线程编码卡死 */
const OCR_RENDER_SCALE = 1.5

const SIDEBAR_WIDTH_MIN = 180
const SIDEBAR_WIDTH_MAX = 560
const AI_PANEL_WIDTH_MIN = 280
const AI_PANEL_WIDTH_MAX = 720
const CONTENT_WIDTH_MIN = 280
/** 拖到此宽度以下松开即收起面板 */
const PANEL_COLLAPSE_THRESHOLD = 120

function isPdfFile(file: File) {
  return (
    file.type === 'application/pdf' ||
    file.type === 'application/x-pdf' ||
    isPdfPath(file.name)
  )
}

function isTauriRuntime() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

export default function App() {
  const [appSettings, setAppSettings] = useState(getAppSettings)

  useEffect(() => {
    applyDocumentLocale(appSettings.locale)
  }, [appSettings.locale])

  return (
    <I18nProvider locale={appSettings.locale}>
      <AppShell appSettings={appSettings} setAppSettings={setAppSettings} />
    </I18nProvider>
  )
}

function AppShell({
  appSettings,
  setAppSettings,
}: {
  appSettings: ReturnType<typeof getAppSettings>
  setAppSettings: Dispatch<SetStateAction<ReturnType<typeof getAppSettings>>>
}) {
  const { t } = useI18n()
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [fileName, setFileName] = useState<string | null>(null)
  const [fileKey, setFileKey] = useState<string | null>(null)
  const [filePath, setFilePath] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  const [dirty, setDirty] = useState(false)

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsNav, setSettingsNav] = useState<
    'appearance' | 'reading' | 'highlight' | 'ocr' | 'ai' | 'css'
  >('appearance')
  const [aiOpen, setAiOpen] = useState(false)
  const [aiSettings, setAiSettings] = useState(getAiSettings)
  const [lastSelection, setLastSelection] = useState<AiSelectionContext | null>(
    null,
  )
  const [aiAction, setAiAction] = useState<AiActionRequest | null>(null)
  const aiActionIdRef = useRef(0)
  const [scale, setScale] = useState(() => appSettings.defaultScale)
  const [currentPage, setCurrentPage] = useState(0)
  const [jumpToken, setJumpToken] = useState(0)
  const [sidebarOpen, setSidebarOpen] = useState(() => appSettings.sidebarOpen)
  const [tab, setTab] = useState<'outline' | 'index'>('outline')

  const [outline, setOutline] = useState<OutlineItem[]>([])
  const [highlights, setHighlights] = useState<Highlight[]>([])
  const [pageAnnotations, setPageAnnotations] = useState<PageAnnotation[]>([])
  const [ocrOverlays, setOcrOverlays] = useState<OcrPageOverlay[]>([])
  const [pageTitles, setPageTitles] = useState<PageTitleMap>({})
  const [highlightPalette, setHighlightPalette] = useState(getHighlightPalette)
  const [highlightColor, setHighlightColor] = useState(
    () => getHighlightPalette()[0]?.color || '#ffe566',
  )
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [openPageNoteId, setOpenPageNoteId] = useState<string | null>(null)

  const [ocrSettings, setOcrSettings] = useState(getOcrSettings)
  const [ocrBusy, setOcrBusy] = useState(false)
  const [ocrProgress, setOcrProgress] = useState<OcrProgressEvent | null>(null)
  const ocrCancelRequestedRef = useRef(false)
  const [scannedHint, setScannedHint] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [pendingHighlight, setPendingHighlight] = useState<PendingHighlight | null>(null)

  const scaleTimer = useRef<number | null>(null)
  const [debouncedScale, setDebouncedScale] = useState(scale)
  const mainRef = useRef<HTMLDivElement | null>(null)
  const [sidebarWidth, setSidebarWidth] = useState(
    () => appSettings.sidebarWidth,
  )
  const [aiPanelWidth, setAiPanelWidth] = useState(
    () => appSettings.aiPanelWidth,
  )
  const historyRef = useRef(createDocHistory())
  const docEditRef = useRef({
    highlights,
    pageAnnotations,
    outline,
    ocrOverlays,
    pageTitles,
  })
  docEditRef.current = {
    highlights,
    pageAnnotations,
    outline,
    ocrOverlays,
    pageTitles,
  }
  const noteHistArmedRef = useRef(true)
  const noteHistTimerRef = useRef<number | null>(null)

  useEffect(() => {
    applyTheme(appSettings.theme)
  }, [appSettings.theme])

  useEffect(() => {
    applySmoothAnimations(appSettings.smoothAnimations)
  }, [appSettings.smoothAnimations])

  useEffect(() => {
    applyCustomCss(appSettings.customCss)
  }, [appSettings.customCss])

  useEffect(() => {
    setSidebarWidth(appSettings.sidebarWidth)
  }, [appSettings.sidebarWidth])

  useEffect(() => {
    setAiPanelWidth(appSettings.aiPanelWidth)
  }, [appSettings.aiPanelWidth])

  const persistLayoutWidths = useCallback(
    (partial: { sidebarWidth?: number; aiPanelWidth?: number }) => {
      setAppSettings((prev) => {
        const next = { ...prev, ...partial }
        saveAppSettings(next)
        return next
      })
    },
    [setAppSettings],
  )

  const sidebarResizeMax = useCallback(() => {
    const mainW = mainRef.current?.clientWidth ?? window.innerWidth
    const aiW = aiOpen ? aiPanelWidth : 0
    return Math.max(
      SIDEBAR_WIDTH_MIN,
      Math.min(SIDEBAR_WIDTH_MAX, mainW - CONTENT_WIDTH_MIN - aiW),
    )
  }, [aiOpen, aiPanelWidth])

  const aiPanelResizeMax = useCallback(() => {
    const mainW = mainRef.current?.clientWidth ?? window.innerWidth
    const sideW = sidebarOpen ? sidebarWidth : 0
    return Math.max(
      AI_PANEL_WIDTH_MIN,
      Math.min(AI_PANEL_WIDTH_MAX, mainW - CONTENT_WIDTH_MIN - sideW),
    )
  }, [sidebarOpen, sidebarWidth])

  useEffect(() => {
    if (!isTauriRuntime()) return
    let cancelled = false
    let unlisten: (() => void) | undefined
    void import('@tauri-apps/api/event')
      .then(({ listen }) =>
        listen<OcrProgressEvent>('ocr-progress', (event) => {
          const payload = event.payload
          setOcrProgress(payload)
          setStatus(formatOcrProgressStatus(payload))
        }),
      )
      .then((fn) => {
        if (cancelled) fn()
        else unlisten = fn
      })
      .catch(() => {
        /* 非桌面端忽略 */
      })
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])

  useEffect(() => {
    if (scaleTimer.current) window.clearTimeout(scaleTimer.current)
    scaleTimer.current = window.setTimeout(() => setDebouncedScale(scale), 120)
    return () => {
      if (scaleTimer.current) window.clearTimeout(scaleTimer.current)
    }
  }, [scale])

  const pushHistory = useCallback(() => {
    historyRef.current.push(docEditRef.current)
  }, [])

  const applyDocEdit = useCallback(
    (state: ReturnType<typeof cloneDocEdit>, label: string) => {
      setHighlights(state.highlights)
      setPageAnnotations(state.pageAnnotations)
      setOutline(state.outline)
      setOcrOverlays(state.ocrOverlays)
      setPageTitles(state.pageTitles || {})
      setDirty(true)
      if (fileKey && fileName) {
        saveDraft(fileKey, {
          version: 1,
          fileName,
          savedAt: Date.now(),
          outline: state.outline,
          highlights: state.highlights,
          pageAnnotations: state.pageAnnotations,
          ocrOverlays: state.ocrOverlays,
          pageTitles: state.pageTitles,
          scale: debouncedScale,
          pageIndex: currentPage,
        })
      }
      setStatus(label)
      window.setTimeout(() => setStatus(''), 1200)
    },
    [fileKey, fileName, debouncedScale, currentPage],
  )

  const undo = useCallback(() => {
    const prev = historyRef.current.undo(docEditRef.current)
    if (!prev) return
    noteHistArmedRef.current = true
    applyDocEdit(prev, '已撤销')
  }, [applyDocEdit])

  const redo = useCallback(() => {
    const next = historyRef.current.redo(docEditRef.current)
    if (!next) return
    noteHistArmedRef.current = true
    applyDocEdit(next, '已重做')
  }, [applyDocEdit])

  const indexRows = useMemo(
    () => buildTriadIndex(highlights, pageAnnotations),
    [highlights, pageAnnotations],
  )

  const pageCount = pdf?.numPages ?? 0

  const pageOutline = useMemo(
    () =>
      buildPageOutline(
        pageCount,
        outline,
        highlights,
        pageAnnotations,
        highlightPalette,
        pageTitles,
      ),
    [pageCount, outline, highlights, pageAnnotations, highlightPalette, pageTitles],
  )

  const markDirty = useCallback(() => setDirty(true), [])

  const persistDraft = useCallback(
    (partial?: Partial<ProjectFile>) => {
      if (!fileKey || !fileName) return
      const project: ProjectFile = {
        version: 1,
        fileName,
        savedAt: Date.now(),
        outline: partial?.outline ?? outline,
        highlights: partial?.highlights ?? highlights,
        pageAnnotations: partial?.pageAnnotations ?? pageAnnotations,
        ocrOverlays: partial?.ocrOverlays ?? ocrOverlays,
        pageTitles: partial?.pageTitles ?? pageTitles,
        scale: partial?.scale ?? debouncedScale,
        pageIndex: partial?.pageIndex ?? currentPage,
      }
      saveDraft(fileKey, project)
    },
    [
      fileKey,
      fileName,
      outline,
      highlights,
      pageAnnotations,
      ocrOverlays,
      pageTitles,
      debouncedScale,
      currentPage,
    ],
  )

  const applyProject = useCallback((project: ProjectFile) => {
    setOutline(project.outline || [])
    setHighlights(
      (project.highlights || []).map((h) => ({
        ...h,
        note: h.note ?? '',
        // 旧数据可能带 #RRGGBBAA，去掉 alpha，避免叠色把字洗淡
        color: (h.color || '').slice(0, 7) || h.color,
      })),
    )
    setPageAnnotations(project.pageAnnotations || [])
    setOcrOverlays(project.ocrOverlays || [])
    setPageTitles(project.pageTitles || {})
    if (project.scale) {
      setScale(project.scale)
      setDebouncedScale(project.scale)
    }
    if (typeof project.pageIndex === 'number') {
      setCurrentPage(project.pageIndex)
      setJumpToken((t) => t + 1)
    }
  }, [])

  const openBytes = useCallback(
    async (bytes: Uint8Array, name: string, path?: string) => {
      setError(null)
      setStatus('打开中…')
      setDirty(false)
      historyRef.current.clear()
      noteHistArmedRef.current = true
      setPendingHighlight(null)
      setOpenPageNoteId(null)
      try {
        const doc = await loadPdfFromBytes(bytes)
        const key = fileKeyFromNameAndSize(name, bytes.byteLength)
        setPdf(doc)
        setFileName(name)
        setFileKey(key)
        setFilePath(path || null)

        let loaded = false
        if (path) {
          const side = sidecarPathForPdf(path)
          try {
            if (await exists(side)) {
              const raw = await readTextFile(side)
              applyProject(JSON.parse(raw) as ProjectFile)
              loaded = true
              setStatus('已加载工程文件')
            }
          } catch {
            /* ignore sidecar errors */
          }
        }
        if (!loaded) {
          const draft = loadDraft(key)
          if (draft) {
            applyProject(draft)
            loaded = true
          } else {
            setHighlights([])
            setPageAnnotations([])
            setOcrOverlays([])
            setPageTitles({})
            setScale(appSettings.defaultScale)
            setDebouncedScale(appSettings.defaultScale)
            setCurrentPage(0)
            setJumpToken((t) => t + 1)
            const tree = await getOutlineTree(doc)
            setOutline(tree)
          }
        }

        // 轻量探测：只看第 1 页文本量，判断是否扫描件
        try {
          const page = await doc.getPage(1)
          const tc = await page.getTextContent()
          const text = tc.items.map((it) => ('str' in it ? it.str : '')).join('')
          setScannedHint(isLikelyScannedPage(text) && !(await getOutlineTree(doc)).length)
        } catch {
          setScannedHint(false)
        }

        setStatus('')
        // 打开文档后进入学习助手，引导构建本 PDF 专属助手
        setAiOpen(true)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        setError(msg.includes('Password') ? '该 PDF 已加密。' : `无法打开：${msg}`)
        setStatus('')
      }
    },
    [applyProject, appSettings.defaultScale],
  )

  const handleOpen = useCallback(async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      })
      if (!selected || Array.isArray(selected)) return
      const path = selected
      const bytes = await readFile(path)
      const name = path.split(/[/\\]/).pop() || 'document.pdf'
      await openBytes(bytes, name, path)
    } catch (e) {
      if (String(e).includes('Tauri') || String(e).includes('invoke')) {
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = 'application/pdf'
        input.onchange = async () => {
          const file = input.files?.[0]
          if (!file) return
          await openBytes(new Uint8Array(await file.arrayBuffer()), file.name)
        }
        input.click()
        return
      }
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [openBytes])

  const buildProject = useCallback((): ProjectFile | null => {
    if (!fileName || !fileKey) return null
    return {
      version: 1,
      fileName,
      savedAt: Date.now(),
      outline,
      highlights,
      pageAnnotations,
      ocrOverlays,
      pageTitles,
      scale: debouncedScale,
      pageIndex: currentPage,
    }
  }, [
    fileName,
    fileKey,
    outline,
    highlights,
    pageAnnotations,
    ocrOverlays,
    pageTitles,
    debouncedScale,
    currentPage,
  ])

  /** 自动保存：本地草稿始终写；有 PDF 路径时同步旁路工程文件 */
  const autoSave = useCallback(async () => {
    const project = buildProject()
    if (!project || !fileKey) return
    saveDraft(fileKey, project)
    if (!filePath) {
      setDirty(false)
      return
    }
    try {
      const target = sidecarPathForPdf(filePath)
      await writeTextFile(target, JSON.stringify(project, null, 2))
      setDirty(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [buildProject, fileKey, filePath])

  const handleSave = useCallback(async () => {
    await autoSave()
  }, [autoSave])

  const onRenamePage = useCallback(
    (pageIndex: number, title: string) => {
      const key = String(pageIndex)
      const next: PageTitleMap = { ...pageTitles }
      if (title) next[key] = title
      else delete next[key]
      if ((pageTitles[key] || '') === (next[key] || '')) return
      pushHistory()
      setPageTitles(next)
      markDirty()
      persistDraft({ pageTitles: next })
    },
    [pageTitles, pushHistory, markDirty, persistDraft],
  )

  const openPdfPath = useCallback(
    async (path: string) => {
      if (!isPdfPath(path)) {
        setError('请拖入 PDF 文件')
        return
      }
      try {
        const bytes = await readFile(path)
        const name = path.split(/[/\\]/).pop() || 'document.pdf'
        await openBytes(bytes, name, path)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    },
    [openBytes],
  )

  // Tauri 桌面端：系统拖放由 WebView 拦截，必须用 onDragDropEvent；浏览器则用 HTML5 drop
  useEffect(() => {
    let unlistenTauri: (() => void) | undefined
    let cancelled = false

    if (isTauriRuntime()) {
      void getCurrentWebview()
        .onDragDropEvent((event) => {
          const { type } = event.payload
          if (type === 'enter' || type === 'over') {
            setDragOver(true)
            return
          }
          if (type === 'leave') {
            setDragOver(false)
            return
          }
          if (type === 'drop') {
            setDragOver(false)
            const path = event.payload.paths.find(isPdfPath)
            if (!path) {
              setError('请拖入 PDF 文件')
              return
            }
            void openPdfPath(path)
          }
        })
        .then((unlisten) => {
          if (cancelled) unlisten()
          else unlistenTauri = unlisten
        })
        .catch(() => {
          /* 非 Tauri 或 API 不可用时忽略 */
        })

      return () => {
        cancelled = true
        unlistenTauri?.()
      }
    }

    const onDragOver = (e: DragEvent) => {
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
      setDragOver(true)
    }
    const onDragLeave = (e: DragEvent) => {
      if (e.relatedTarget == null) setDragOver(false)
    }
    const onDrop = async (e: DragEvent) => {
      e.preventDefault()
      setDragOver(false)
      const file = Array.from(e.dataTransfer?.files ?? []).find(isPdfFile)
      if (!file) {
        setError('请拖入 PDF 文件')
        return
      }
      await openBytes(new Uint8Array(await file.arrayBuffer()), file.name)
    }
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [openBytes, openPdfPath])

  // 有改动时自动保存（草稿 + 旁路工程文件）
  useEffect(() => {
    if (!dirty) return
    const timer = window.setTimeout(() => {
      void autoSave()
    }, 600)
    return () => window.clearTimeout(timer)
  }, [dirty, autoSave, outline, highlights, pageAnnotations, ocrOverlays, pageTitles, debouncedScale, currentPage])

  // Ctrl+S 立即保存；Ctrl+Z 撤销；Ctrl+Y / Ctrl+Shift+Z 重做
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      const key = e.key.toLowerCase()
      if (key === 's') {
        e.preventDefault()
        void handleSave()
        return
      }
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault()
        undo()
        return
      }
      if (key === 'y' || (key === 'z' && e.shiftKey)) {
        e.preventDefault()
        redo()
        return
      }
      if (key === 'j') {
        e.preventDefault()
        setAiOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleSave, undo, redo])

  const gotoPage = useCallback((pageIndex: number) => {
    setCurrentPage(pageIndex)
    setJumpToken((t) => t + 1)
  }, [])

  useEffect(() => {
    setLastSelection(null)
    setAiAction(null)
    aiActionIdRef.current = 0
  }, [fileKey])

  const askAiAboutSelection = useCallback(
    (task: AiTask, selection: AiSelectionContext) => {
      aiActionIdRef.current += 1
      setLastSelection(selection)
      setPendingHighlight(null)
      setAiAction({ id: aiActionIdRef.current, task, selection })
      setAiOpen(true)
      window.getSelection()?.removeAllRanges()
    },
    [],
  )

  const onPageChange = useCallback(
    (pageIndex: number) => {
      setCurrentPage(pageIndex)
      if (fileKey && fileName) {
        persistDraft({ pageIndex, scale: debouncedScale })
      }
    },
    [fileKey, fileName, persistDraft, debouncedScale],
  )

  const onTextSelected = useCallback(
    (
      pageIndex: number,
      text: string,
      rects: Highlight['rects'],
      clientX: number,
      clientY: number,
    ) => {
      if (!fileKey) return
      setLastSelection({ text, pageIndex })
      setPendingHighlight({ pageIndex, text, rects, clientX, clientY })
    },
    [fileKey],
  )

  const commitHighlight = useCallback(
    (item: HighlightPaletteItem) => {
      if (!fileKey || !pendingHighlight) return
      pushHistory()
      const base = item.color.length >= 7 ? item.color.slice(0, 7) : item.color
      const hl: Highlight = {
        id: crypto.randomUUID(),
        pageIndex: pendingHighlight.pageIndex,
        color: base,
        colorLabel: item.label.trim(),
        text: pendingHighlight.text,
        note: '',
        rects: pendingHighlight.rects,
        createdAt: Date.now(),
      }
      const next = [...highlights, hl]
      setHighlights(next)
      setHighlightColor(base)
      markDirty()
      persistDraft({ highlights: next })
      setTab('outline')
      setPendingHighlight(null)
      window.getSelection()?.removeAllRanges()
    },
    [fileKey, pendingHighlight, highlights, markDirty, persistDraft, pushHistory],
  )

  const updatePalette = useCallback((items: HighlightPaletteItem[]) => {
    setHighlightPalette(items)
    saveHighlightPalette(items)
    if (items.length && !items.some((x) => x.color.toLowerCase() === highlightColor.toLowerCase())) {
      setHighlightColor(items[0].color)
    }
  }, [highlightColor])

  const onUpdateHighlightNote = useCallback(
    (id: string, note: string) => {
      const cur = highlights.find((h) => h.id === id)
      if (!cur || cur.note === note) return
      // 连续输入只记一次历史，停顿后再记
      if (noteHistArmedRef.current) {
        pushHistory()
        noteHistArmedRef.current = false
      }
      if (noteHistTimerRef.current) window.clearTimeout(noteHistTimerRef.current)
      noteHistTimerRef.current = window.setTimeout(() => {
        noteHistArmedRef.current = true
      }, 600)
      const next = highlights.map((h) => (h.id === id ? { ...h, note } : h))
      setHighlights(next)
      markDirty()
      persistDraft({ highlights: next })
    },
    [highlights, markDirty, persistDraft, pushHistory],
  )

  const onRemoveHighlight = useCallback(
    (id: string) => {
      pushHistory()
      const next = highlights.filter((h) => h.id !== id)
      setHighlights(next)
      markDirty()
      persistDraft({ highlights: next })
    },
    [highlights, markDirty, persistDraft, pushHistory],
  )

  const onRenameHighlight = useCallback(
    (id: string, title: string) => {
      const cur = highlights.find((h) => h.id === id)
      if (!cur) return
      const nextTitle = title.trim()
      const prev = (cur.outlineTitle || '').trim()
      if (prev === nextTitle) return
      // 清空或与选中原文相同 → 回退为默认选中内容
      const outlineTitle =
        !nextTitle || nextTitle === cur.text.trim() ? undefined : nextTitle
      if ((cur.outlineTitle || undefined) === outlineTitle) return
      pushHistory()
      const next = highlights.map((h) =>
        h.id === id ? { ...h, outlineTitle } : h,
      )
      setHighlights(next)
      markDirty()
      persistDraft({ highlights: next })
    },
    [highlights, markDirty, persistDraft, pushHistory],
  )

  const runOcrOnPage = useCallback(
    async (pageIndex: number, overlays: OcrPageOverlay[]) => {
      if (!pdf) throw new Error('无文档')
      const canvas = await renderPageToCanvas(pdf, pageIndex, OCR_RENDER_SCALE)
      await yieldToUi()
      const imageBase64 = await canvasToBase64Jpeg(canvas, 0.82)
      // 释放 canvas 像素，减轻内存压力
      canvas.width = 0
      canvas.height = 0
      await yieldToUi()
      const overlay = await runPageOcr({
        imageBase64,
        mode: ocrSettings.mode,
        language: ocrSettings.language,
        apiUrl: ocrSettings.apiUrl,
        apiKey: ocrSettings.apiKey,
        pageIndex,
        tier: ocrSettings.tier,
      })
      const words = overlay.words.map((w) => ({
        ...w,
        x0: w.x0 / OCR_RENDER_SCALE,
        y0: w.y0 / OCR_RENDER_SCALE,
        x1: w.x1 / OCR_RENDER_SCALE,
        y1: w.y1 / OCR_RENDER_SCALE,
      }))
      const nextOverlay = { ...overlay, words }
      return [...overlays.filter((o) => o.pageIndex !== pageIndex), nextOverlay]
    },
    [pdf, ocrSettings],
  )

  /** 仅 OCR 一页并返回 overlay，不写 React 状态（供 AI 读页/建索引时调用） */
  const ocrEmptyPageForAi = useCallback(
    async (pageIndex: number): Promise<OcrPageOverlay | null> => {
      if (!pdf) return null
      if (ocrSettings.mode === 'online' && !ocrSettings.apiUrl.trim()) {
        throw new Error(t('ai.ocr.needOnlineConfig'))
      }
      const canvas = await renderPageToCanvas(pdf, pageIndex, OCR_RENDER_SCALE)
      await yieldToUi()
      const imageBase64 = await canvasToBase64Jpeg(canvas, 0.82)
      canvas.width = 0
      canvas.height = 0
      const overlay = await runPageOcr({
        imageBase64,
        mode: ocrSettings.mode,
        language: ocrSettings.language,
        apiUrl: ocrSettings.apiUrl,
        apiKey: ocrSettings.apiKey,
        pageIndex,
        tier: ocrSettings.tier,
      })
      const words = overlay.words.map((w) => ({
        ...w,
        x0: w.x0 / OCR_RENDER_SCALE,
        y0: w.y0 / OCR_RENDER_SCALE,
        x1: w.x1 / OCR_RENDER_SCALE,
        y1: w.y1 / OCR_RENDER_SCALE,
      }))
      return { ...overlay, words }
    },
    [pdf, ocrSettings, t],
  )

  const commitAiOcrOverlays = useCallback(
    (overlays: OcrPageOverlay[]) => {
      if (!fileKey) return
      const ocrOutline = buildOutlineFromOcr(overlays)
      const nextOutline = ocrOutline.length
        ? mergeOutlines(outline, ocrOutline)
        : outline
      setOcrOverlays(overlays)
      if (ocrOutline.length) setOutline(nextOutline)
      markDirty()
      persistDraft(
        ocrOutline.length
          ? { ocrOverlays: overlays, outline: nextOutline }
          : { ocrOverlays: overlays },
      )
    },
    [fileKey, outline, markDirty, persistDraft],
  )

  const ensureOnlineConfigured = useCallback(() => {
    if (ocrSettings.mode !== 'online') return true
    if (ocrSettings.apiUrl.trim()) return true
    setError(t('error.onlineOcr'))
    setSettingsOpen(true)
    return false
  }, [ocrSettings.mode, ocrSettings.apiUrl, t])

  const onOcrPage = useCallback(async () => {
    if (!pdf || !fileKey) return
    if (!ensureOnlineConfigured()) return
    ocrCancelRequestedRef.current = false
    setOcrBusy(true)
    setOcrProgress({ done: 0, total: 0, stage: 'page' })
    setError(null)
    setStatus(
      ocrSettings.mode === 'online'
        ? `联网 OCR 第 ${currentPage + 1} 页…`
        : `PP-OCR 第 ${currentPage + 1} 页…`,
    )
    try {
      const nextOverlays = await runOcrOnPage(currentPage, ocrOverlays)
      if (ocrCancelRequestedRef.current) throw new Error('OCR 已取消')
      const ocrOutline = buildOutlineFromOcr(nextOverlays)
      const nextOutline = ocrOutline.length ? mergeOutlines(outline, ocrOutline) : outline
      pushHistory()
      setOcrOverlays(nextOverlays)
      setOutline(nextOutline)
      markDirty()
      persistDraft({ ocrOverlays: nextOverlays, outline: nextOutline })
      setStatus(ocrSettings.mode === 'online' ? '联网 OCR 完成' : 'OCR 完成（PP-OCRv6）')
      setTab('outline')
    } catch (e) {
      if (isOcrCancelledError(e) || ocrCancelRequestedRef.current) {
        setStatus('OCR 已取消')
        setError(null)
      } else {
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      setOcrBusy(false)
      setOcrProgress(null)
      ocrCancelRequestedRef.current = false
      window.setTimeout(() => setStatus(''), 2000)
    }
  }, [
    pdf,
    fileKey,
    currentPage,
    ocrOverlays,
    outline,
    ocrSettings.mode,
    ensureOnlineConfigured,
    runOcrOnPage,
    markDirty,
    persistDraft,
    pushHistory,
  ])

  const onCancelOcr = useCallback(() => {
    if (!ocrBusy) return
    ocrCancelRequestedRef.current = true
    setStatus('正在取消 OCR…')
    void cancelOcr()
  }, [ocrBusy])

  const onOcrAll = useCallback(async () => {
    if (!pdf || !fileKey) return
    if (!ensureOnlineConfigured()) return
    ocrCancelRequestedRef.current = false
    setOcrBusy(true)
    setOcrProgress({ done: 0, total: 0, stage: 'loading_model' })
    setError(null)
    try {
      // 有本地路径：全书 OCR + 不可见文字层，再重新打开 .ocr.pdf
      if (filePath && ocrSettings.mode === 'offline') {
        setStatus(
          'PP-OCR 全书（写文字层）…本地无模型时会从 BOS 下载，请耐心等待',
        )
        await yieldToUi(32)
        if (ocrCancelRequestedRef.current) throw new Error('OCR 已取消')
        const result = await runPdfOcr({
          pdfPath: filePath,
          tier: ocrSettings.tier,
          writeTextLayer: true,
        })
        if (ocrCancelRequestedRef.current) throw new Error('OCR 已取消')
        if (result.outline?.length) {
          setOutline(mergeOutlines(outline, result.outline))
        }
        if (result.pages?.length) {
          setOcrOverlays(result.pages)
        }
        markDirty()
        persistDraft({
          outline: result.outline?.length
            ? mergeOutlines(outline, result.outline)
            : outline,
          ocrOverlays: result.pages || ocrOverlays,
        })
        const bytes = await readFile(result.outputPath)
        const name =
          result.outputPath.split(/[/\\]/).pop() || 'document.ocr.pdf'
        await openBytes(bytes, name, result.outputPath)
        setStatus(`已生成可检索 PDF：${name}`)
        setTab('outline')
        return
      }

      // 无路径或联网：逐页叠加层（中途不写 overlays，避免每页整页重绘卡住）
      pushHistory()
      let overlays = [...ocrOverlays]
      const total = pdf.numPages
      setOcrProgress({ done: 0, total, stage: 'page' })
      for (let i = 0; i < total; i++) {
        if (ocrCancelRequestedRef.current) throw new Error('OCR 已取消')
        setOcrProgress({ done: i, total, stage: 'page' })
        setStatus(`OCR ${i + 1}/${total}…`)
        await yieldToUi(16)
        overlays = await runOcrOnPage(i, overlays)
        setOcrProgress({ done: i + 1, total, stage: 'page' })
        // 每 5 页或最后一页再刷一次进度态，不刷新叠加层
        if (i === total - 1 || (i + 1) % 5 === 0) {
          await yieldToUi(16)
        }
      }
      const ocrOutline = buildOutlineFromOcr(overlays)
      const nextOutline = ocrOutline.length
        ? mergeOutlines(outline, ocrOutline)
        : outline
      setOcrOverlays(overlays)
      setOutline(nextOutline)
      markDirty()
      persistDraft({ ocrOverlays: overlays, outline: nextOutline })
      setStatus(`OCR 全书完成，目录 ${nextOutline.length} 条`)
      setTab('outline')
    } catch (e) {
      if (isOcrCancelledError(e) || ocrCancelRequestedRef.current) {
        setStatus('OCR 已取消')
        setError(null)
      } else {
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      setOcrBusy(false)
      setOcrProgress(null)
      ocrCancelRequestedRef.current = false
      window.setTimeout(() => setStatus(''), 3000)
    }
  }, [
    pdf,
    fileKey,
    filePath,
    ocrSettings.mode,
    ocrOverlays,
    outline,
    ensureOnlineConfigured,
    runOcrOnPage,
    markDirty,
    persistDraft,
    openBytes,
    pushHistory,
  ])

  return (
    <div
      className={`app${dragOver ? ' drag-over' : ''}`}
      data-sidebar-collapsing={
        sidebarOpen && sidebarWidth < PANEL_COLLAPSE_THRESHOLD ? '1' : undefined
      }
      data-ai-collapsing={
        aiOpen && aiPanelWidth < PANEL_COLLAPSE_THRESHOLD ? '1' : undefined
      }
      style={
        {
          '--sidebar-width': `${sidebarWidth}px`,
          '--ai-panel-width': `${aiPanelWidth}px`,
        } as CSSProperties
      }
    >
      {dragOver && (
        <div className="drop-overlay" aria-hidden>
          <div className="drop-overlay-card">{t('app.drop')}</div>
        </div>
      )}
      {pendingHighlight && (
        <HighlightColorMenu
          pending={pendingHighlight}
          palette={highlightPalette}
          onPick={(item) => commitHighlight(item)}
          onCancel={() => {
            setPendingHighlight(null)
            window.getSelection()?.removeAllRanges()
          }}
          onManage={() => {
            setPendingHighlight(null)
            window.getSelection()?.removeAllRanges()
            setPaletteOpen(true)
          }}
          onAiAsk={askAiAboutSelection}
        />
      )}
      <Toolbar
        aiOpen={aiOpen}
        sidebarOpen={sidebarOpen}
        fileName={fileName}
        pageCount={pageCount}
        currentPage={currentPage}
        scale={scale}
        ocrBusy={ocrBusy}
        ocrModeLabel={
          ocrSettings.mode === 'online'
            ? t('ocr.mode.online')
            : `${t('ocr.mode.offline')} · ${ocrSettings.tier}`
        }
        onPageInput={(p) => gotoPage(Math.min(Math.max(0, p), Math.max(0, pageCount - 1)))}
        onZoom={setScale}
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
        onOcrPage={onOcrPage}
        onOcrAll={onOcrAll}
        onAi={() => setAiOpen((v) => !v)}
        onSettings={() => {
          setSettingsNav('appearance')
          setSettingsOpen(true)
        }}
      />

      <HighlightPaletteModal
        open={paletteOpen}
        items={highlightPalette}
        onClose={() => setPaletteOpen(false)}
        onChange={updatePalette}
        onResetDefaults={() => {
          const next = resetHighlightPalette()
          setHighlightPalette(next)
          if (next[0]) setHighlightColor(next[0].color)
        }}
      />

      <SettingsModal
        open={settingsOpen}
        settings={appSettings}
        ocr={ocrSettings}
        ai={aiSettings}
        initialNav={settingsNav}
        onClose={() => setSettingsOpen(false)}
        onChange={(next) => {
          setAppSettings(next)
          saveAppSettings(next)
        }}
        onOcrChange={(next) => {
          setOcrSettings(next)
          saveOcrSettings(next)
          if (next.mode === 'online' && !next.apiUrl.trim()) {
            setError(t('settings.ocr.needUrl'))
          }
        }}
        onAiChange={(next) => {
          setAiSettings(next)
          saveAiSettings(next)
        }}
        onOpenPalette={() => setPaletteOpen(true)}
      />

      <div className="main" ref={mainRef}>
        <Sidebar
          open={sidebarOpen}
          tab={tab}
          onTab={setTab}
          pageOutline={pageOutline}
          indexRows={indexRows}
          hasDocument={!!pdf}
          onGotoPage={gotoPage}
          onRenamePage={onRenamePage}
          onRenameHighlight={onRenameHighlight}
          scannedHint={scannedHint}
          onEditHighlightNote={(id) => {
            const h = highlights.find((x) => x.id === id)
            if (!h) return
            const note = window.prompt('编辑高亮批注', h.note) ?? h.note
            onUpdateHighlightNote(id, note.trim())
          }}
          onRemoveHighlight={onRemoveHighlight}
          onOpenPageNote={(id) => {
            setOpenPageNoteId(id)
            const a = pageAnnotations.find((x) => x.id === id)
            if (a) gotoPage(a.pageIndex)
          }}
          onRemovePageNote={(id) => {
            pushHistory()
            const next = pageAnnotations.filter((a) => a.id !== id)
            setPageAnnotations(next)
            markDirty()
            persistDraft({ pageAnnotations: next })
            if (openPageNoteId === id) setOpenPageNoteId(null)
          }}
        />
        {sidebarOpen && (
          <PanelResizeHandle
            edge="e"
            value={sidebarWidth}
            min={0}
            max={sidebarResizeMax()}
            label="调整侧栏宽度"
            onChange={setSidebarWidth}
            onCommit={(w) => {
              if (w < PANEL_COLLAPSE_THRESHOLD) {
                setSidebarOpen(false)
                setSidebarWidth(appSettings.sidebarWidth)
                return
              }
              const next = Math.max(SIDEBAR_WIDTH_MIN, w)
              setSidebarWidth(next)
              persistLayoutWidths({ sidebarWidth: next })
            }}
          />
        )}

        <div className="content">
          {error && (
            <div className="banner error">
              {error}
              <button type="button" className="btn tiny" onClick={() => setError(null)}>
                {t('app.close')}
              </button>
            </div>
          )}
          {status && (
            <div className="banner info">
              <div className="banner-main">
                <div className="banner-text">{status}</div>
                {ocrBusy && ocrProgress && (
                  <div
                    className={`ocr-progress${
                      !ocrProgress.total ? ' indeterminate' : ''
                    }`}
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={ocrProgress.total || 100}
                    aria-valuenow={
                      ocrProgress.total
                        ? Math.min(ocrProgress.done, ocrProgress.total)
                        : undefined
                    }
                  >
                    <div
                      className="ocr-progress-bar"
                      style={
                        ocrProgress.total > 0
                          ? {
                              width: `${Math.min(
                                100,
                                Math.round(
                                  (ocrProgress.done / ocrProgress.total) * 100,
                                ),
                              )}%`,
                            }
                          : undefined
                      }
                    />
                  </div>
                )}
              </div>
              {ocrBusy && (
                <button
                  type="button"
                  className="btn tiny"
                  onClick={onCancelOcr}
                >
                  取消
                </button>
              )}
            </div>
          )}
          {pdf ? (
            <Viewer
              pdf={pdf}
              scale={debouncedScale}
              currentPage={currentPage}
              jumpToken={jumpToken}
              highlights={highlights}
              ocrOverlays={ocrOverlays}
              highlightColor={highlightColor.slice(0, 7)}
              onPageChange={onPageChange}
              onTextSelected={onTextSelected}
              onUpdateHighlightNote={onUpdateHighlightNote}
              onRemoveHighlight={onRemoveHighlight}
            />
          ) : (
            <div className="empty-state">
              <h1>{t('app.name')}</h1>
              <p>{t('app.empty.tagline')}</p>
              <p className="empty-hint">{t('app.empty.hint')}</p>
              <button type="button" className="btn primary lg" onClick={handleOpen}>
                {t('app.empty.open')}
              </button>
            </div>
          )}
        </div>

        {aiOpen && (
          <PanelResizeHandle
            edge="w"
            value={aiPanelWidth}
            min={0}
            max={aiPanelResizeMax()}
            label="调整 AI 面板宽度"
            onChange={setAiPanelWidth}
            onCommit={(w) => {
              if (w < PANEL_COLLAPSE_THRESHOLD) {
                setAiOpen(false)
                setAiPanelWidth(appSettings.aiPanelWidth)
                return
              }
              const next = Math.max(AI_PANEL_WIDTH_MIN, w)
              setAiPanelWidth(next)
              persistLayoutWidths({ aiPanelWidth: next })
            }}
          />
        )}
        <AiPanel
          open={aiOpen}
          settings={aiSettings}
          fileKey={fileKey}
          fileName={fileName}
          pdf={pdf}
          currentPage={currentPage}
          pageCount={pageCount}
          highlights={highlights}
          highlightPalette={highlightPalette}
          pageAnnotations={pageAnnotations}
          pageOutline={pageOutline}
          ocrOverlays={ocrOverlays}
          ocrEmptyPage={ocrEmptyPageForAi}
          onOcrOverlaysCommitted={commitAiOcrOverlays}
          selection={lastSelection}
          action={aiAction}
          onConsumeAction={() => setAiAction(null)}
          onClearSelection={() => setLastSelection(null)}
          onClose={() => setAiOpen(false)}
          onOpenSettings={() => {
            setSettingsNav('ai')
            setSettingsOpen(true)
          }}
          onApplyHighlights={async (suggestions: AiHighlightSuggestion[]) => {
            if (!pdf || !fileKey || !suggestions.length) return
            pushHistory()
            const next = [...highlights]
            let applied = 0
            let missed = 0
            const fallbackColor =
              highlightPalette[0] ||
              ({ id: 'fallback', color: '#ffe566', label: '重点' } as const)

            for (const tip of suggestions) {
              const pageIndex = Math.min(
                Math.max(0, tip.pageIndex),
                Math.max(0, pageCount - 1),
              )
              const already = next.some(
                (h) =>
                  h.pageIndex === pageIndex &&
                  h.text.replace(/\s+/g, '') === tip.quote.replace(/\s+/g, ''),
              )
              if (already) {
                missed += 1
                continue
              }

              let rects: Highlight['rects'] | null = null
              try {
                const page = await pdf.getPage(pageIndex + 1)
                const ocr = ocrOverlays.find((o) => o.pageIndex === pageIndex)
                rects = await locateQuoteOnPage(page, tip.quote, ocr?.words)
              } catch {
                rects = null
              }
              if (!rects?.length) {
                missed += 1
                continue
              }

              const paletteItem =
                highlightPalette.find(
                  (p) =>
                    p.label.trim().toLowerCase() ===
                    tip.label.trim().toLowerCase(),
                ) || fallbackColor

              next.push({
                id: crypto.randomUUID(),
                pageIndex,
                color: paletteItem.color,
                colorLabel: paletteItem.label,
                text: tip.quote,
                note: tip.note,
                rects,
                createdAt: Date.now(),
              })
              applied += 1
            }

            if (applied > 0) {
              setHighlights(next)
              markDirty()
              persistDraft({ highlights: next })
              setSidebarOpen(true)
              setTab('outline')
              const first = next[next.length - applied]
              if (first) gotoPage(first.pageIndex)
            }

            setStatus(
              t('ai.applyHighlightsResult', {
                applied,
                missed,
              }),
            )
            window.setTimeout(() => setStatus(''), 3500)
          }}
          onWritePageNote={(body, pageIndex) => {
            if (!fileKey || !body.trim()) return
            pushHistory()
            const note: PageAnnotation = {
              id: crypto.randomUUID(),
              pageIndex: Math.min(
                Math.max(0, pageIndex),
                Math.max(0, pageCount - 1),
              ),
              body: body.trim(),
              createdAt: Date.now(),
            }
            const next = [...pageAnnotations, note]
            setPageAnnotations(next)
            markDirty()
            persistDraft({ pageAnnotations: next })
            setSidebarOpen(true)
            setTab('outline')
            setOpenPageNoteId(note.id)
            setStatus(t('ai.savedNote'))
            window.setTimeout(() => setStatus(''), 2000)
          }}
          onGotoPage={gotoPage}
        />
      </div>

      <PageNoteModal
        note={
          openPageNoteId
            ? (pageAnnotations.find((a) => a.id === openPageNoteId) ?? null)
            : null
        }
        onClose={() => setOpenPageNoteId(null)}
        onSave={(id, body) => {
          pushHistory()
          const next = pageAnnotations.map((x) =>
            x.id === id ? { ...x, body } : x,
          )
          setPageAnnotations(next)
          markDirty()
          persistDraft({ pageAnnotations: next })
        }}
        onRemove={(id) => {
          pushHistory()
          const next = pageAnnotations.filter((a) => a.id !== id)
          setPageAnnotations(next)
          markDirty()
          persistDraft({ pageAnnotations: next })
          setOpenPageNoteId(null)
        }}
        onGotoPage={gotoPage}
      />
    </div>
  )
}

function mergeOutlines(base: OutlineItem[], ocr: OutlineItem[]): OutlineItem[] {
  if (!base.length) return ocr
  const seen = new Set(base.map((b) => `${b.pageIndex}|${b.title}`))
  const extra = ocr.filter((o) => !seen.has(`${o.pageIndex}|${o.title}`))
  return [...base, ...extra].sort(
    (a, b) => (a.pageIndex ?? 0) - (b.pageIndex ?? 0),
  )
}
