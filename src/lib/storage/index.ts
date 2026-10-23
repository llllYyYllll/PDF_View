import type { OcrMode, ProjectFile } from '../pdf/types'

const PREFIX = 'pdfview:v2:'
const SETTINGS = `${PREFIX}ocrSettings`

function readJson<T>(k: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(k)
    if (!raw) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function writeJson(k: string, value: unknown) {
  localStorage.setItem(k, JSON.stringify(value))
}

export function fileKeyFromNameAndSize(fileName: string, size: number): string {
  return `${fileName}::${size}`
}

/** 自动草稿（防丢）；正式保存走 .pdfview.json 文件 */
export function loadDraft(fileKey: string): ProjectFile | null {
  return readJson(key(fileKey), null)
}

export function saveDraft(fileKey: string, project: ProjectFile) {
  writeJson(key(fileKey), project)
}

function key(fileKey: string) {
  return `${PREFIX}draft:${fileKey}`
}

export function sidecarPathForPdf(pdfPath: string): string {
  return pdfPath.replace(/\.pdf$/i, '') + '.pdfview.json'
}

export function getOcrSettings(): {
  mode: OcrMode
  apiUrl: string
  apiKey: string
  language: string
} {
  return readJson(SETTINGS, {
    mode: 'offline' as const,
    apiUrl: '',
    apiKey: '',
    language: 'chi_sim+eng',
  })
}

export function saveOcrSettings(settings: {
  mode: OcrMode
  apiUrl: string
  apiKey: string
  language: string
}) {
  writeJson(SETTINGS, settings)
}
