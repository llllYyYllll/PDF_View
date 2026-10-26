import { invoke } from '@tauri-apps/api/core'
import type { OcrMode, OcrPageOverlay, OcrWord, OutlineItem } from '../pdf/types'

export type OcrBackendStatus = {
  python: string
  offlineReady: boolean
  onlineReady: boolean
  engine?: string
  /** 是否检测到可用的 CUDA GPU（Paddle 编译支持且有设备） */
  gpuAvailable?: boolean
  /** 实际将使用的推理设备，如 cpu / gpu:0 */
  device?: string
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
    return {
      python: 'python',
      offlineReady: false,
      onlineReady: true,
      gpuAvailable: false,
      device: 'cpu',
    }
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

export type OcrProgressEvent = {
  done: number
  total: number
  stage: string
}

/** 终止当前 Python OCR 子进程（全书 / 单页均可） */
export async function cancelOcr(): Promise<void> {
  try {
    await invoke('cancel_ocr')
  } catch {
    /* 无运行中的任务时忽略 */
  }
}

export function isOcrCancelledError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '')
  return /OCR 已取消|OCR 已被取消|cancelled/i.test(msg)
}

export function formatOcrProgressStatus(p: OcrProgressEvent): string {
  const stage = p.stage || ''
  if (stage === 'loading_model') {
    return 'PP-OCR 加载模型中…本地无模型时会从 BOS 下载，请耐心等待'
  }
  if (stage === 'start') {
    return p.total > 0
      ? `PP-OCR 全书准备中（共 ${p.total} 页）…`
      : 'PP-OCR 全书准备中…'
  }
  if (stage === 'saving') {
    return 'PP-OCR 正在写入文字层…'
  }
  if (stage === 'done') {
    return 'PP-OCR 全书完成'
  }
  if (p.total > 0) {
    return `PP-OCR 全书 ${p.done}/${p.total} 页…`
  }
  return 'PP-OCR 全书进行中…'
}

/** 同步 PNG（仅短图）；全书 OCR 请用 canvasToBase64Jpeg */
export function canvasToBase64Png(canvas: HTMLCanvasElement): string {
  const dataUrl = canvas.toDataURL('image/png')
  return dataUrl.replace(/^data:image\/png;base64,/, '')
}

/** 异步 JPEG，体积更小、编码更快，减少 OCR 全书时主线程卡死 */
export function canvasToBase64Jpeg(
  canvas: HTMLCanvasElement,
  quality = 0.82,
): Promise<string> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('无法编码页面图像'))
          return
        }
        const reader = new FileReader()
        reader.onload = () => {
          const dataUrl = String(reader.result || '')
          resolve(dataUrl.replace(/^data:[^;]+;base64,/, ''))
        }
        reader.onerror = () =>
          reject(reader.error ?? new Error('读取页面图像失败'))
        reader.readAsDataURL(blob)
      },
      'image/jpeg',
      quality,
    )
  })
}

export function yieldToUi(ms = 0): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms)
  })
}
