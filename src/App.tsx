import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { open, save } from '@tauri-apps/plugin-dialog'
import { exists, readFile, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { Toolbar } from './components/Toolbar'
import { Sidebar } from './components/Sidebar'
import { Viewer } from './components/Viewer'
import { OcrSettingsModal } from './components/OcrSettingsModal'
import { renderPageToCanvas } from './components/PageView'
import { loadPdfFromBytes } from './lib/pdf/loader'
import { getOutlineTree } from './lib/pdf/outline'
import { buildOutlineFromOcr, isLikelyScannedPage } from './lib/pdf/ocrToc'
import { buildTriadIndex } from './lib/index/triad'
import type {
  Highlight,
  OcrMode,
  OcrPageOverlay,
  OutlineItem,
  PageAnnotation,
  ProjectFile,
} from './lib/pdf/types'
import {
  fileKeyFromNameAndSize,
  getOcrSettings,
  loadDraft,
  saveDraft,
  saveOcrSettings,
  sidecarPathForPdf,
} from './lib/storage'
import { canvasToBase64Png, runPageOcr, runPdfOcr } from './lib/ocr/client'
import './App.css'

export default function App() {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [fileName, setFileName] = useState<string | null>(null)
  const [fileKey, setFileKey] = useState<string | null>(null)
  const [filePath, setFilePath] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  const [dirty, setDirty] = useState(false)

  const [scale, setScale] = useState(1.1)
  const [currentPage, setCurrentPage] = useState(0)
  const [jumpToken, setJumpToken] = useState(0)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [tab, setTab] = useState<'outline' | 'index'>('outline')

  const [outline, setOutline] = useState<OutlineItem[]>([])
  const [highlights, setHighlights] = useState<Highlight[]>([])
  const [pageAnnotations, setPageAnnotations] = useState<PageAnnotation[]>([])
  const [ocrOverlays, setOcrOverlays] = useState<OcrPageOverlay[]>([])
  const [highlightColor, setHighlightColor] = useState('#ffe566')

  const [ocrSettings, setOcrSettings] = useState(getOcrSettings)
  const [ocrSettingsOpen, setOcrSettingsOpen] = useState(false)
  const [ocrBusy, setOcrBusy] = useState(false)
  const [scannedHint, setScannedHint] = useState(false)

  const scaleTimer = useRef<number | null>(null)
  const [debouncedScale, setDebouncedScale] = useState(scale)

  useEffect(() => {
    if (scaleTimer.current) window.clearTimeout(scaleTimer.current)
    scaleTimer.current = window.setTimeout(() => setDebouncedScale(scale), 120)
    return () => {
      if (scaleTimer.current) window.clearTimeout(scaleTimer.current)
    }
  }, [scale])

  const indexRows = useMemo(
    () => buildTriadIndex(highlights, pageAnnotations),
    [highlights, pageAnnotations],
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
      })),
    )
    setPageAnnotations(project.pageAnnotations || [])
    setOcrOverlays(project.ocrOverlays || [])
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
            setScale(1.1)
            setDebouncedScale(1.1)
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
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        setError(msg.includes('Password') ? '该 PDF 已加密。' : `无法打开：${msg}`)
        setStatus('')
      }
    },
    [applyProject],
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

  const handleSave = useCallback(async () => {
    if (!fileName || !fileKey) return
    const project: ProjectFile = {
      version: 1,
      fileName,
      savedAt: Date.now(),
      outline,
      highlights,
      pageAnnotations,
      ocrOverlays,
      scale: debouncedScale,
      pageIndex: currentPage,
    }
    saveDraft(fileKey, project)

    try {
      let target =
        filePath != null ? sidecarPathForPdf(filePath) : null
      if (!target) {
        const picked = await save({
          defaultPath: fileName.replace(/\.pdf$/i, '') + '.pdfview.json',
          filters: [{ name: 'PDF View 工程', extensions: ['pdfview.json', 'json'] }],
        })
        if (!picked) return
        target = picked
      }
      await writeTextFile(target, JSON.stringify(project, null, 2))
      setDirty(false)
      setStatus(`已保存：${target.split(/[/\\]/).pop()}`)
      window.setTimeout(() => setStatus(''), 2000)
    } catch (e) {
      // 浏览器回退：下载
      try {
        const blob = new Blob([JSON.stringify(project, null, 2)], {
          type: 'application/json',
        })
        const a = document.createElement('a')
        a.href = URL.createObjectURL(blob)
        a.download = fileName.replace(/\.pdf$/i, '') + '.pdfview.json'
        a.click()
        URL.revokeObjectURL(a.href)
        setDirty(false)
        setStatus('已下载工程文件')
        window.setTimeout(() => setStatus(''), 2000)
      } catch {
        setError(e instanceof Error ? e.message : String(e))
      }
    }
  }, [
    fileName,
    fileKey,
    filePath,
    outline,
    highlights,
    pageAnnotations,
    ocrOverlays,
    debouncedScale,
    currentPage,
  ])

  useEffect(() => {
    const onDragOver = (e: DragEvent) => e.preventDefault()
    const onDrop = async (e: DragEvent) => {
      e.preventDefault()
      const file = e.dataTransfer?.files?.[0]
      if (!file || file.type !== 'application/pdf') return
      await openBytes(new Uint8Array(await file.arrayBuffer()), file.name)
    }
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [openBytes])

  // Ctrl+S 保存
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void handleSave()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleSave])

  const gotoPage = useCallback((pageIndex: number) => {
    setCurrentPage(pageIndex)
    setJumpToken((t) => t + 1)
  }, [])

  const onPageChange = useCallback(
    (pageIndex: number) => {
      setCurrentPage(pageIndex)
      if (fileKey && fileName) {
        persistDraft({ pageIndex, scale: debouncedScale })
      }
    },
    [fileKey, fileName, persistDraft, debouncedScale],
  )

  const onAddHighlight = useCallback(
    (pageIndex: number, text: string, rects: Highlight['rects']) => {
      if (!fileKey) return
      const note = window.prompt('为高亮添加批注（可留空）', '') ?? ''
      const hl: Highlight = {
        id: crypto.randomUUID(),
        pageIndex,
        color: highlightColor + '99',
        text,
        note: note.trim(),
        rects,
        createdAt: Date.now(),
      }
      const next = [...highlights, hl]
      setHighlights(next)
      markDirty()
      persistDraft({ highlights: next })
      setTab('index')
    },
    [fileKey, highlightColor, highlights, markDirty, persistDraft],
  )

  const onPageNote = useCallback(() => {
    if (!fileKey) return
    const body = window.prompt(`第 ${currentPage + 1} 页批注`, '') ?? ''
    if (!body.trim()) return
    const note: PageAnnotation = {
      id: crypto.randomUUID(),
      pageIndex: currentPage,
      body: body.trim(),
      createdAt: Date.now(),
    }
    const next = [...pageAnnotations, note]
    setPageAnnotations(next)
    markDirty()
    persistDraft({ pageAnnotations: next })
    setTab('index')
  }, [fileKey, currentPage, pageAnnotations, markDirty, persistDraft])

  const runOcrOnPage = useCallback(
    async (pageIndex: number, overlays: OcrPageOverlay[]) => {
      if (!pdf) throw new Error('无文档')
      const canvas = await renderPageToCanvas(pdf, pageIndex, 2)
      const overlay = await runPageOcr({
        imageBase64: canvasToBase64Png(canvas),
        mode: ocrSettings.mode,
        language: ocrSettings.language,
        apiUrl: ocrSettings.apiUrl,
        apiKey: ocrSettings.apiKey,
        pageIndex,
        tier: 'small',
      })
      // 渲染 scale=2，坐标换回 PDF 点（约 72dpi 空间）
      const words = overlay.words.map((w) => ({
        ...w,
        x0: w.x0 / 2,
        y0: w.y0 / 2,
        x1: w.x1 / 2,
        y1: w.y1 / 2,
      }))
      const nextOverlay = { ...overlay, words }
      return [...overlays.filter((o) => o.pageIndex !== pageIndex), nextOverlay]
    },
    [pdf, ocrSettings],
  )

  const ensureOnlineConfigured = useCallback(() => {
    if (ocrSettings.mode !== 'online') return true
    if (ocrSettings.apiUrl.trim()) return true
    setError('联网 OCR 需要先配置 API 地址')
    setOcrSettingsOpen(true)
    return false
  }, [ocrSettings.mode, ocrSettings.apiUrl])

  const onOcrPage = useCallback(async () => {
    if (!pdf || !fileKey) return
    if (!ensureOnlineConfigured()) return
    setOcrBusy(true)
    setError(null)
    setStatus(
      ocrSettings.mode === 'online'
        ? `联网 OCR 第 ${currentPage + 1} 页…`
        : `PP-OCR 第 ${currentPage + 1} 页…`,
    )
    try {
      const nextOverlays = await runOcrOnPage(currentPage, ocrOverlays)
      setOcrOverlays(nextOverlays)
      const ocrOutline = buildOutlineFromOcr(nextOverlays)
      const nextOutline = ocrOutline.length ? mergeOutlines(outline, ocrOutline) : outline
      setOutline(nextOutline)
      markDirty()
      persistDraft({ ocrOverlays: nextOverlays, outline: nextOutline })
      setStatus(ocrSettings.mode === 'online' ? '联网 OCR 完成' : 'OCR 完成（PP-OCRv6）')
      setTab('outline')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setOcrBusy(false)
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
  ])

  const onOcrAll = useCallback(async () => {
    if (!pdf || !fileKey) return
    if (!ensureOnlineConfigured()) return
    setOcrBusy(true)
    setError(null)
    try {
      // 有本地路径：全书 OCR + 不可见文字层，再重新打开 .ocr.pdf
      if (filePath && ocrSettings.mode === 'offline') {
        setStatus('PP-OCR 全书（写文字层）…本地无模型时会从 BOS 下载，请耐心等待')
        const result = await runPdfOcr({
          pdfPath: filePath,
          tier: 'small',
          writeTextLayer: true,
        })
        if (result.outline?.length) {
          setOutline(mergeOutlines(outline, result.outline))
        }
        if (result.pages?.length) {
          setOcrOverlays(result.pages)
        }
        markDirty()
        persistDraft({
          outline: result.outline?.length ? mergeOutlines(outline, result.outline) : outline,
          ocrOverlays: result.pages || ocrOverlays,
        })
        const bytes = await readFile(result.outputPath)
        const name = result.outputPath.split(/[/\\]/).pop() || 'document.ocr.pdf'
        await openBytes(bytes, name, result.outputPath)
        setStatus(`已生成可检索 PDF：${name}`)
        setTab('outline')
        return
      }

      // 无路径或联网：逐页叠加层
      let overlays = [...ocrOverlays]
      for (let i = 0; i < pdf.numPages; i++) {
        setStatus(`OCR ${i + 1}/${pdf.numPages}…`)
        overlays = await runOcrOnPage(i, overlays)
        setOcrOverlays([...overlays])
      }
      const ocrOutline = buildOutlineFromOcr(overlays)
      const nextOutline = ocrOutline.length ? mergeOutlines(outline, ocrOutline) : outline
      setOutline(nextOutline)
      markDirty()
      persistDraft({ ocrOverlays: overlays, outline: nextOutline })
      setStatus(`OCR 全书完成，目录 ${nextOutline.length} 条`)
      setTab('outline')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setOcrBusy(false)
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
  ])

  const pageCount = pdf?.numPages ?? 0

  return (
    <div className="app">
      <Toolbar
        fileName={fileName}
        pageCount={pageCount}
        currentPage={currentPage}
        scale={scale}
        highlightColor={highlightColor}
        ocrBusy={ocrBusy}
        ocrMode={ocrSettings.mode}
        dirty={dirty}
        onOpen={handleOpen}
        onSave={handleSave}
        onPageInput={(p) => gotoPage(Math.min(Math.max(0, p), Math.max(0, pageCount - 1)))}
        onZoom={setScale}
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
        onHighlightColor={setHighlightColor}
        onOcrPage={onOcrPage}
        onOcrAll={onOcrAll}
        onPageNote={onPageNote}
        onOcrMode={(mode: OcrMode) => {
          const next = { ...ocrSettings, mode }
          setOcrSettings(next)
          saveOcrSettings(next)
          if (mode === 'online' && !next.apiUrl.trim()) {
            setOcrSettingsOpen(true)
            setError('联网 OCR 需填写 API 地址')
          }
        }}
        onOcrSettings={() => setOcrSettingsOpen(true)}
      />

      <OcrSettingsModal
        open={ocrSettingsOpen}
        mode={ocrSettings.mode}
        apiUrl={ocrSettings.apiUrl}
        apiKey={ocrSettings.apiKey}
        language={ocrSettings.language}
        onClose={() => setOcrSettingsOpen(false)}
        onSave={(next) => {
          setOcrSettings(next)
          saveOcrSettings(next)
        }}
      />

      <div className="main">
        <Sidebar
          open={sidebarOpen}
          tab={tab}
          onTab={setTab}
          outline={outline}
          indexRows={indexRows}
          highlights={highlights}
          pageAnnotations={pageAnnotations}
          onGotoPage={gotoPage}
          scannedHint={scannedHint}
          onEditHighlightNote={(id) => {
            const h = highlights.find((x) => x.id === id)
            if (!h) return
            const note = window.prompt('编辑高亮批注', h.note) ?? h.note
            const next = highlights.map((x) =>
              x.id === id ? { ...x, note: note.trim() } : x,
            )
            setHighlights(next)
            markDirty()
            persistDraft({ highlights: next })
          }}
          onRemoveHighlight={(id) => {
            const next = highlights.filter((h) => h.id !== id)
            setHighlights(next)
            markDirty()
            persistDraft({ highlights: next })
          }}
          onEditPageNote={(id) => {
            const a = pageAnnotations.find((x) => x.id === id)
            if (!a) return
            const body = window.prompt('编辑页批注', a.body) ?? a.body
            if (!body.trim()) return
            const next = pageAnnotations.map((x) =>
              x.id === id ? { ...x, body: body.trim() } : x,
            )
            setPageAnnotations(next)
            markDirty()
            persistDraft({ pageAnnotations: next })
          }}
          onRemovePageNote={(id) => {
            const next = pageAnnotations.filter((a) => a.id !== id)
            setPageAnnotations(next)
            markDirty()
            persistDraft({ pageAnnotations: next })
          }}
        />

        <div className="content">
          {error && (
            <div className="banner error">
              {error}
              <button type="button" className="btn tiny" onClick={() => setError(null)}>
                关闭
              </button>
            </div>
          )}
          {status && <div className="banner info">{status}</div>}
          {pdf ? (
            <Viewer
              pdf={pdf}
              scale={debouncedScale}
              currentPage={currentPage}
              jumpToken={jumpToken}
              highlights={highlights}
              ocrOverlays={ocrOverlays}
              highlightColor={highlightColor + '99'}
              onPageChange={onPageChange}
              onAddHighlight={onAddHighlight}
            />
          ) : (
            <div className="empty-state">
              <h1>PDF View</h1>
              <p>OCR · 高亮 · 批注 · 三向索引 · 保存</p>
              <button type="button" className="btn primary lg" onClick={handleOpen}>
                打开 PDF
              </button>
            </div>
          )}
        </div>
      </div>
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
