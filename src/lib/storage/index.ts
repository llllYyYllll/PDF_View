import { isAppLocale } from '../i18n'
import {
  createBuiltinProviders,
  defaultAiSettings,
  defaultStudySettings,
  isAiProviderKind,
} from '../ai/providers'
import type {
  AiProviderEntry,
  AiSettings,
  AiStudySettings,
  AppSettings,
  HighlightPaletteItem,
  OcrMode,
  OcrSettings,
  OcrTier,
  ProjectFile,
} from '../pdf/types'

const PREFIX = 'pdfview:v2:'
const SETTINGS = `${PREFIX}ocrSettings`
const APP_SETTINGS = `${PREFIX}appSettings`
const PALETTE = `${PREFIX}highlightPalette`
const AI_SETTINGS = `${PREFIX}aiSettings`

export const DEFAULT_AI_SETTINGS: AiSettings = defaultAiSettings()

/** DeepSeek 于 2026-07-24 下线 deepseek-chat / deepseek-reasoner，映射到现行模型 */
const RETIRED_DEEPSEEK_MODELS: Record<string, string> = {
  'deepseek-chat': 'deepseek-flash',
  'deepseek-reasoner': 'deepseek-flash',
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
}

function migrateDeepSeekModel(id: string, model: string): string {
  if (id !== 'deepseek') return model
  return RETIRED_DEEPSEEK_MODELS[model] ?? model
}

function normalizeEntry(raw: Partial<AiProviderEntry>, fallback: AiProviderEntry): AiProviderEntry {
  const id = typeof raw.id === 'string' && raw.id ? raw.id : fallback.id
  const modelRaw = typeof raw.model === 'string' ? raw.model : fallback.model
  return {
    id,
    kind: isAiProviderKind(raw.kind) ? raw.kind : fallback.kind,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : fallback.name,
    subtitle:
      typeof raw.subtitle === 'string' ? raw.subtitle : fallback.subtitle,
    builtin: typeof raw.builtin === 'boolean' ? raw.builtin : fallback.builtin,
    apiBase: typeof raw.apiBase === 'string' ? raw.apiBase : fallback.apiBase,
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : fallback.apiKey,
    model: migrateDeepSeekModel(id, modelRaw),
    cliPath: typeof raw.cliPath === 'string' ? raw.cliPath : fallback.cliPath,
    cliArgs: typeof raw.cliArgs === 'string' ? raw.cliArgs : fallback.cliArgs,
  }
}

function mergeWithBuiltins(saved: AiProviderEntry[]): AiProviderEntry[] {
  const builtins = createBuiltinProviders()
  const byId = new Map(saved.map((p) => [p.id, p]))
  const merged: AiProviderEntry[] = builtins.map((b) => {
    const prev = byId.get(b.id)
    if (!prev) return b
    return normalizeEntry({ ...b, ...prev, builtin: true, name: b.name, subtitle: b.subtitle }, b)
  })
  for (const p of saved) {
    if (p.builtin) continue
    if (builtins.some((b) => b.id === p.id)) continue
    merged.push(
      normalizeEntry(p, {
        id: p.id,
        kind: 'openai',
        name: 'Custom Provider',
        subtitle: 'OpenAI-compatible endpoint',
        builtin: false,
        apiBase: '',
        apiKey: '',
        model: '',
        cliPath: '',
        cliArgs: '',
      }),
    )
  }
  return merged
}

/** 兼容旧版扁平 AiSettings */
function migrateLegacyAiSettings(raw: Record<string, unknown>): AiSettings | null {
  if (!('provider' in raw) || Array.isArray(raw.providers)) return null
  const kind = isAiProviderKind(raw.provider) ? raw.provider : 'openai'
  const base = defaultAiSettings()
  const providers = base.providers.map((p) => {
    if (p.id !== kind && !(kind === 'openai' && p.id === 'openai')) return p
    if (p.kind !== kind) return p
    return {
      ...p,
      apiBase: typeof raw.apiBase === 'string' && raw.apiBase ? raw.apiBase : p.apiBase,
      apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : p.apiKey,
      model: typeof raw.model === 'string' && raw.model ? raw.model : p.model,
      cliPath: typeof raw.cliPath === 'string' ? raw.cliPath : p.cliPath,
      cliArgs: typeof raw.cliArgs === 'string' ? raw.cliArgs : p.cliArgs,
    }
  })
  const active =
    providers.find((p) => p.kind === kind && p.builtin)?.id ??
    providers.find((p) => p.kind === kind)?.id ??
    'openai'
  return { activeId: active, providers, study: defaultStudySettings() }
}

function normalizeStudy(raw: unknown): AiStudySettings {
  const fallback = defaultStudySettings()
  if (!raw || typeof raw !== 'object') return fallback
  const study = raw as Partial<AiStudySettings>
  const contextMode =
    study.contextMode === 'auto' ||
    study.contextMode === 'full' ||
    study.contextMode === 'retrieval'
      ? study.contextMode
      : fallback.contextMode
  const replyLocale =
    study.replyLocale === 'auto' ||
    study.replyLocale === 'zh-CN' ||
    study.replyLocale === 'en'
      ? study.replyLocale
      : fallback.replyLocale
  const maxContextChars =
    typeof study.maxContextChars === 'number' &&
    Number.isFinite(study.maxContextChars)
      ? Math.min(600_000, Math.max(20_000, Math.round(study.maxContextChars)))
      : fallback.maxContextChars
  const customSystemPrompt =
    typeof study.customSystemPrompt === 'string'
      ? study.customSystemPrompt.slice(0, 20_000)
      : fallback.customSystemPrompt
  return {
    contextMode,
    replyLocale,
    maxContextChars,
    keepHistory:
      typeof study.keepHistory === 'boolean'
        ? study.keepHistory
        : fallback.keepHistory,
    includeAnnotations:
      typeof study.includeAnnotations === 'boolean'
        ? study.includeAnnotations
        : fallback.includeAnnotations,
    customSystemPrompt,
  }
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  theme: 'dark',
  locale: 'zh-CN',
  defaultScale: 1.1,
  sidebarOpen: true,
  sidebarWidth: 260,
  aiPanelWidth: 420,
  smoothAnimations: true,
  customCss: '',
}

const SIDEBAR_WIDTH_MIN = 180
const SIDEBAR_WIDTH_MAX = 560
const AI_PANEL_WIDTH_MIN = 280
const AI_PANEL_WIDTH_MAX = 720

function clampPanelWidth(n: unknown, min: number, max: number, fallback: number) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

const CUSTOM_CSS_STYLE_ID = 'pdfview-custom-css'
const CUSTOM_CSS_MAX_CHARS = 80_000

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

export const DEFAULT_OCR_SETTINGS: OcrSettings = {
  mode: 'offline',
  apiUrl: '',
  apiKey: '',
  language: 'chi_sim+eng',
  tier: 'small',
}

function normalizeOcrTier(raw: unknown): OcrTier {
  return raw === 'tiny' || raw === 'small' || raw === 'medium'
    ? raw
    : DEFAULT_OCR_SETTINGS.tier
}

export function getOcrSettings(): OcrSettings {
  const raw = readJson<Partial<OcrSettings>>(SETTINGS, {})
  const mode: OcrMode =
    raw.mode === 'online' || raw.mode === 'offline'
      ? raw.mode
      : DEFAULT_OCR_SETTINGS.mode
  return {
    mode,
    apiUrl: typeof raw.apiUrl === 'string' ? raw.apiUrl : DEFAULT_OCR_SETTINGS.apiUrl,
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : DEFAULT_OCR_SETTINGS.apiKey,
    language:
      typeof raw.language === 'string' && raw.language.trim()
        ? raw.language
        : DEFAULT_OCR_SETTINGS.language,
    tier: normalizeOcrTier(raw.tier),
  }
}

export function saveOcrSettings(settings: OcrSettings) {
  writeJson(SETTINGS, {
    ...settings,
    tier: normalizeOcrTier(settings.tier),
  })
}

/** 内置默认高亮色板（颜色 + 含义） */
export const DEFAULT_HIGHLIGHT_PALETTE: HighlightPaletteItem[] = [
  { id: 'default-yellow', color: '#ffe566', label: '重点' },
  { id: 'default-blue', color: '#7eb6ff', label: '定义' },
  { id: 'default-orange', color: '#ffb347', label: '疑问' },
  { id: 'default-pink', color: '#ff8fab', label: '注意' },
  { id: 'default-purple', color: '#c9a0ff', label: '补充' },
]

function normalizePalette(list: unknown): HighlightPaletteItem[] {
  if (!Array.isArray(list)) return []
  return list.filter(
    (x): x is HighlightPaletteItem =>
      !!x &&
      typeof x === 'object' &&
      typeof (x as HighlightPaletteItem).id === 'string' &&
      typeof (x as HighlightPaletteItem).color === 'string' &&
      typeof (x as HighlightPaletteItem).label === 'string',
  )
}

/** 用户自定义高亮色板；未配置或为空时回退内置默认 */
export function getHighlightPalette(): HighlightPaletteItem[] {
  try {
    const raw = localStorage.getItem(PALETTE)
    if (raw == null) {
      return DEFAULT_HIGHLIGHT_PALETTE.map((x) => ({ ...x }))
    }
    const list = normalizePalette(JSON.parse(raw)).filter(
      (x) => x.id !== 'default-green',
    )
    return list.length > 0
      ? list
      : DEFAULT_HIGHLIGHT_PALETTE.map((x) => ({ ...x }))
  } catch {
    return DEFAULT_HIGHLIGHT_PALETTE.map((x) => ({ ...x }))
  }
}

export function saveHighlightPalette(items: HighlightPaletteItem[]) {
  writeJson(PALETTE, items)
}

/** 将色板恢复为内置默认 */
export function resetHighlightPalette(): HighlightPaletteItem[] {
  const next = DEFAULT_HIGHLIGHT_PALETTE.map((x) => ({ ...x }))
  saveHighlightPalette(next)
  return next
}

export function getAppSettings(): AppSettings {
  const raw = readJson<Partial<AppSettings>>(APP_SETTINGS, {})
  const theme = raw.theme === 'light' || raw.theme === 'dark' ? raw.theme : DEFAULT_APP_SETTINGS.theme
  const locale = isAppLocale(raw.locale) ? raw.locale : DEFAULT_APP_SETTINGS.locale
  const defaultScale =
    typeof raw.defaultScale === 'number' && raw.defaultScale >= 0.5 && raw.defaultScale <= 3
      ? raw.defaultScale
      : DEFAULT_APP_SETTINGS.defaultScale
  const sidebarOpen =
    typeof raw.sidebarOpen === 'boolean' ? raw.sidebarOpen : DEFAULT_APP_SETTINGS.sidebarOpen
  const sidebarWidth = clampPanelWidth(
    raw.sidebarWidth,
    SIDEBAR_WIDTH_MIN,
    SIDEBAR_WIDTH_MAX,
    DEFAULT_APP_SETTINGS.sidebarWidth,
  )
  const aiPanelWidth = clampPanelWidth(
    raw.aiPanelWidth,
    AI_PANEL_WIDTH_MIN,
    AI_PANEL_WIDTH_MAX,
    DEFAULT_APP_SETTINGS.aiPanelWidth,
  )
  const smoothAnimations =
    typeof raw.smoothAnimations === 'boolean'
      ? raw.smoothAnimations
      : DEFAULT_APP_SETTINGS.smoothAnimations
  const customCss =
    typeof raw.customCss === 'string'
      ? raw.customCss.slice(0, CUSTOM_CSS_MAX_CHARS)
      : DEFAULT_APP_SETTINGS.customCss
  return {
    theme,
    locale,
    defaultScale,
    sidebarOpen,
    sidebarWidth,
    aiPanelWidth,
    smoothAnimations,
    customCss,
  }
}

export function saveAppSettings(settings: AppSettings) {
  writeJson(APP_SETTINGS, {
    ...settings,
    customCss: settings.customCss.slice(0, CUSTOM_CSS_MAX_CHARS),
  })
}

export function applyTheme(theme: AppSettings['theme']) {
  document.documentElement.setAttribute('data-theme', theme)
}

export function applySmoothAnimations(enabled: boolean) {
  document.documentElement.setAttribute('data-motion', enabled ? 'on' : 'off')
}

/** 将用户自定义 CSS 注入到 document（用 textContent，避免 HTML 注入） */
export function applyCustomCss(css: string) {
  let el = document.getElementById(CUSTOM_CSS_STYLE_ID) as HTMLStyleElement | null
  if (!el) {
    el = document.createElement('style')
    el.id = CUSTOM_CSS_STYLE_ID
    document.head.appendChild(el)
  }
  el.textContent = css.slice(0, CUSTOM_CSS_MAX_CHARS)
}

export function getAiSettings(): AiSettings {
  const raw = readJson<Record<string, unknown>>(AI_SETTINGS, {})
  const migrated = migrateLegacyAiSettings(raw)
  if (migrated) {
    saveAiSettings(migrated)
    return migrated
  }

  const savedList = Array.isArray(raw.providers)
    ? (raw.providers as Partial<AiProviderEntry>[])
        .filter((p) => p && typeof p === 'object')
        .map((p) =>
          normalizeEntry(p, {
            id: typeof p.id === 'string' ? p.id : `custom-${Math.random().toString(36).slice(2)}`,
            kind: 'openai',
            name: 'Custom Provider',
            subtitle: '',
            builtin: false,
            apiBase: '',
            apiKey: '',
            model: '',
            cliPath: '',
            cliArgs: '',
          }),
        )
    : []

  const providers = mergeWithBuiltins(savedList)
  const activeId =
    typeof raw.activeId === 'string' && providers.some((p) => p.id === raw.activeId)
      ? raw.activeId
      : (providers.find((p) => p.id === 'claude-code')?.id ??
        providers[0]?.id ??
        'claude-code')

  const settings: AiSettings = {
    activeId,
    providers,
    study: normalizeStudy(raw.study),
  }

  // 若已把下线模型映射到新名称，写回本地，避免设置页仍显示旧值
  const deepseek = providers.find((p) => p.id === 'deepseek')
  const prevDeepseek = savedList.find((p) => p.id === 'deepseek')
  if (
    deepseek &&
    prevDeepseek &&
    typeof prevDeepseek.model === 'string' &&
    prevDeepseek.model !== deepseek.model
  ) {
    saveAiSettings(settings)
  }

  return settings
}

export function saveAiSettings(settings: AiSettings) {
  writeJson(AI_SETTINGS, settings)
}
