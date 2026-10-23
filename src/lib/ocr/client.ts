import { invoke } from '@tauri-apps/api/core'
import type { OcrMode, OcrPageOverlay, OcrWord, OutlineItem } from '../pdf/types'

export type OcrBackendStatus = {
  python: string
  offlineReady: boolean
  onlineReady: boolean
  engine?: string
}

export type OcrPdfResult = {
  mode: string
  engine?: string
  outputPath: string
  outline: OutlineItem[]
  pages: OcrPageOverlay[]
  text: string
  words: OcrWord[]
}

export async function detectOcrBackends(): Promise<OcrBackendStatus> {
  try {
    return await invoke<OcrBackendStatus>('detect_ocr_backends')
  } catch {
    return { python: 'python', offlineReady: false, onlineReady: true }
  }
}

export async function runPageOcr(options: {
  imageBase64: string
  mode: OcrMode
  language: string
  apiUrl: string
  apiKey: string
  pageIndex: number
  tier?: string
}): Promise<OcrPageOverlay & { titles?: { title: string; level: number }[] }> {
  const result = await invoke<{
    text: string
    words: OcrWord[]
    mode: string
    titles?: { title: string; level: number }[]
  }>('run_ocr', {
    request: {
      imageBase64: options.imageBase64,
      mode: options.mode,
      language: options.language,
      apiUrl: options.apiUrl || null,
      apiKey: options.apiKey || null,
      tier: options.tier || 'small',
    },
  })

  return {
    pageIndex: options.pageIndex,
    text: result.text,
    words: result.words,
    mode: (result.mode as OcrMode) || options.mode,
    titles: result.titles,
  }
}

/** 全书 OCR：写入不可见文字层并生成目录，返回新 PDF 路径 */
export async function runPdfOcr(options: {
  pdfPath: string
  outputPath?: string
  tier?: string
  writeTextLayer?: boolean
}): Promise<OcrPdfResult> {
  return invoke<OcrPdfResult>('run_ocr', {
    request: {
      action: 'ocr_pdf',
      mode: 'offline',
      pdfPath: options.pdfPath,
      outputPath: options.outputPath || null,
      tier: options.tier || 'small',
      writeTextLayer: options.writeTextLayer !== false,
    },
  })
}

export function canvasToBase64Png(canvas: HTMLCanvasElement): string {
  const dataUrl = canvas.toDataURL('image/png')
  return dataUrl.replace(/^data:image\/png;base64,/, '')
}
