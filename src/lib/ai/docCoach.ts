/** 针对单个 PDF 的学习助手档案（本机持久化） */

export type AiCoachMode = 'quick' | 'deep' | 'skipped'

export type AiDocCoach = {
  fileKey: string
  fileName: string
  mode: AiCoachMode
  /** 是否已完成构建（quick/deep） */
  ready: boolean
  /** 深度/快速模式下生成的学习简报 */
  briefing: string
  createdAt: number
  updatedAt: number
}

const PREFIX = 'pdfview:v3:aiCoach:'

function keyFor(fileKey: string): string {
  return `${PREFIX}${fileKey}`
}

export function loadDocCoach(fileKey: string): AiDocCoach | null {
  try {
    const raw = localStorage.getItem(keyFor(fileKey))
    if (!raw) return null
    const data = JSON.parse(raw) as Partial<AiDocCoach>
    if (typeof data.fileKey !== 'string') return null
    if (data.mode !== 'quick' && data.mode !== 'deep' && data.mode !== 'skipped') {
      return null
    }
    return {
      fileKey: data.fileKey,
      fileName: typeof data.fileName === 'string' ? data.fileName : '',
      mode: data.mode,
      ready: data.ready === true,
      briefing: typeof data.briefing === 'string' ? data.briefing : '',
      createdAt: typeof data.createdAt === 'number' ? data.createdAt : Date.now(),
      updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : Date.now(),
    }
  } catch {
    return null
  }
}

export function saveDocCoach(coach: AiDocCoach): void {
  try {
    localStorage.setItem(keyFor(coach.fileKey), JSON.stringify(coach))
  } catch {
    /* ignore quota */
  }
}

export function clearDocCoach(fileKey: string): void {
  try {
    localStorage.removeItem(keyFor(fileKey))
  } catch {
    /* ignore */
  }
}
