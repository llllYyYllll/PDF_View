import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { DocIndex, OcrPageOverlay } from '../pdf/types'
import {
  buildDocIndex,
  extractSinglePage,
  getCachedDocIndex,
  isPageTextReadable,
  ocrSignature,
  putCachedDocIndex,
} from './document'

export type DocIndexStatus = 'idle' | 'building' | 'ready' | 'error'

export type DocIndexState = {
  status: DocIndexStatus
  done: number
  total: number
  error: string | null
}

function idleState(total: number): DocIndexState {
  return { status: 'idle', done: 0, total, error: null }
}

function mergeOverlays(
  base: OcrPageOverlay[],
  extra: OcrPageOverlay[],
): OcrPageOverlay[] {
  if (!extra.length) return base
  const map = new Map(base.map((o) => [o.pageIndex, o]))
  for (const o of extra) map.set(o.pageIndex, o)
  return [...map.values()].sort((a, b) => a.pageIndex - b.pageIndex)
}

export function useDocIndex(input: {
  pdf: PDFDocumentProxy | null
  fileKey: string | null
  ocrOverlays: OcrPageOverlay[]
  enabled: boolean
  /** 某页抽不出字时调用；返回 OCR 结果，不要在回调里改 React 签名相关状态 */
  ocrEmptyPage?: (pageIndex: number) => Promise<OcrPageOverlay | null>
  /** 索引/读页过程中新产生的 OCR，由外部一次性写入状态 */
  onOcrOverlaysCommitted?: (overlays: OcrPageOverlay[]) => void
}) {
  const {
    pdf,
    fileKey,
    ocrOverlays,
    enabled,
    ocrEmptyPage,
    onOcrOverlaysCommitted,
  } = input
  const [index, setIndex] = useState<DocIndex | null>(null)
  const [state, setState] = useState<DocIndexState>(() =>
    idleState(pdf?.numPages ?? 0),
  )
  const indexRef = useRef<DocIndex | null>(null)
  const promiseRef = useRef<Promise<DocIndex | null> | null>(null)
  const promiseSignatureRef = useRef<string>('')
  const abortRef = useRef<AbortController | null>(null)
  const signatureRef = useRef('')
  const pageCacheRef = useRef(new Map<string, string>())
  const overlaysRef = useRef(ocrOverlays)
  overlaysRef.current = ocrOverlays
  const ocrEmptyPageRef = useRef(ocrEmptyPage)
  ocrEmptyPageRef.current = ocrEmptyPage
  const commitRef = useRef(onOcrOverlaysCommitted)
  commitRef.current = onOcrOverlaysCommitted

  const signature = useMemo(() => {
    if (!pdf || !fileKey) return ''
    return `${fileKey}::${pdf.numPages}::${ocrSignature(ocrOverlays)}`
  }, [pdf, fileKey, ocrOverlays])

  signatureRef.current = signature

  const applyIndex = useCallback((next: DocIndex | null) => {
    indexRef.current = next
    setIndex(next)
    if (next) {
      setState({
        status: 'ready',
        done: next.pages.length,
        total: next.pages.length,
        error: null,
      })
    }
  }, [])

  useEffect(() => {
    abortRef.current?.abort()
    abortRef.current = null
    promiseRef.current = null
    promiseSignatureRef.current = ''
    pageCacheRef.current.clear()
    if (!pdf || !signature) {
      indexRef.current = null
      setIndex(null)
      setState(idleState(0))
      return
    }
    const cached = getCachedDocIndex(pdf, signature)
    indexRef.current = cached
    setIndex(cached)
    setState(
      cached
        ? {
            status: 'ready',
            done: cached.pages.length,
            total: cached.pages.length,
            error: null,
          }
        : idleState(pdf.numPages),
    )
  }, [pdf, signature])

  const ensureIndex = useCallback(
    async (options?: { ocrEmptyPages?: boolean }): Promise<DocIndex | null> => {
      if (!pdf || !signature) return null
      const cached = getCachedDocIndex(pdf, signature)
      if (cached) {
        // 已有索引但要求补 OCR，且仍有空页时继续
        const needOcr =
          options?.ocrEmptyPages &&
          ocrEmptyPageRef.current &&
          cached.pages.some((p) => !isPageTextReadable(p.text))
        if (!needOcr) {
          if (indexRef.current !== cached) applyIndex(cached)
          return cached
        }
      }
      if (
        promiseRef.current &&
        promiseSignatureRef.current === signature &&
        !options?.ocrEmptyPages
      ) {
        return promiseRef.current
      }

      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      setState({ status: 'building', done: 0, total: pdf.numPages, error: null })

      const startOverlays = overlaysRef.current
      const startSignature = signature
      const allowOcr = !!options?.ocrEmptyPages && !!ocrEmptyPageRef.current

      const task = (async () => {
        try {
          let committed: OcrPageOverlay[] | null = null
          const next = await buildDocIndex({
            pdf,
            ocrOverlays: startOverlays,
            signature: startSignature,
            signal: controller.signal,
            onProgress: (done, total) => {
              if (signatureRef.current !== startSignature && !committed) return
              setState({ status: 'building', done, total, error: null })
            },
            ocrEmptyPage: allowOcr
              ? async (pageIndex) => ocrEmptyPageRef.current!(pageIndex)
              : undefined,
            onOcrOverlays: (merged) => {
              committed = merged
            },
          })
          if (controller.signal.aborted) return null

          if (committed) {
            commitRef.current?.(committed)
            const nextSignature = fileKey
              ? `${fileKey}::${pdf.numPages}::${ocrSignature(committed)}`
              : startSignature
            const indexed = { ...next, signature: nextSignature }
            putCachedDocIndex(pdf, indexed)
            applyIndex(indexed)
            return indexed
          }

          if (signatureRef.current !== startSignature) return null
          putCachedDocIndex(pdf, next)
          applyIndex(next)
          return next
        } catch (error) {
          if ((error as { name?: string })?.name === 'AbortError') return null
          if (signatureRef.current !== startSignature) return null
          setState({
            status: 'error',
            done: 0,
            total: pdf.numPages,
            error: error instanceof Error ? error.message : String(error),
          })
          return null
        } finally {
          if (abortRef.current === controller) {
            abortRef.current = null
            promiseRef.current = null
            promiseSignatureRef.current = ''
          }
        }
      })()
      promiseRef.current = task
      promiseSignatureRef.current = signature
      return task
    },
    [applyIndex, fileKey, pdf, signature],
  )

  useEffect(() => {
    if (!enabled || !pdf || !signature) return
    if (indexRef.current?.signature === signature) return
    // 打开面板时只建文本索引，不对空白页自动全书 OCR
    void ensureIndex()
  }, [enabled, ensureIndex, pdf, signature])

  const cancel = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    promiseRef.current = null
    promiseSignatureRef.current = ''
    pageCacheRef.current.clear()
    setState(idleState(pdf?.numPages ?? 0))
  }, [pdf])

  /** 先抽字；不够可读则 OCR，再返回文本 */
  const ensurePageReadable = useCallback(
    async (pageIndex: number): Promise<string> => {
      const current = indexRef.current
      if (current) {
        const page = current.pages.find((p) => p.pageIndex === pageIndex)
        if (page && isPageTextReadable(page.text)) return page.text
      }
      if (!pdf) return ''

      const cacheKey = `${signatureRef.current}:${pageIndex}`
      const cachedText = pageCacheRef.current.get(cacheKey)
      if (cachedText !== undefined && isPageTextReadable(cachedText)) {
        return cachedText
      }

      const overlays = overlaysRef.current
      const existing = overlays.find((o) => o.pageIndex === pageIndex)
      const extracted = await extractSinglePage(pdf, pageIndex, existing)
      if (isPageTextReadable(extracted.text)) {
        pageCacheRef.current.set(cacheKey, extracted.text)
        return extracted.text
      }

      const ocrFn = ocrEmptyPageRef.current
      if (!ocrFn) {
        pageCacheRef.current.set(cacheKey, extracted.text)
        return extracted.text
      }

      const overlay = await ocrFn(pageIndex)
      if (!overlay) {
        pageCacheRef.current.set(cacheKey, extracted.text)
        return extracted.text
      }

      const merged = mergeOverlays(overlaysRef.current, [overlay])
      overlaysRef.current = merged
      commitRef.current?.(merged)

      const again = await extractSinglePage(pdf, pageIndex, overlay)
      const text = isPageTextReadable(again.text)
        ? again.text
        : again.text || overlay.text || extracted.text
      pageCacheRef.current.set(cacheKey, text)
      // 同步刷新内存索引中的该页，避免继续用空页
      if (indexRef.current) {
        const pages = indexRef.current.pages.map((p) =>
          p.pageIndex === pageIndex
            ? {
                pageIndex,
                text,
                source: 'ocr' as const,
              }
            : p,
        )
        const nextIndex = { ...indexRef.current, pages }
        indexRef.current = nextIndex
        setIndex(nextIndex)
      }
      return text
    },
    [pdf],
  )

  const pageText = useCallback(
    async (pageIndex: number): Promise<string> => {
      return ensurePageReadable(pageIndex)
    },
    [ensurePageReadable],
  )

  return {
    index,
    state,
    signature,
    ensureIndex,
    cancel,
    pageText,
    ensurePageReadable,
  }
}
