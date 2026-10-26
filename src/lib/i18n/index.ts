import {
  type AppLocale,
  type MessageKey,
  LOCALE_OPTIONS,
  MESSAGES,
} from './messages'

export type { AppLocale, MessageKey }
export { LOCALE_OPTIONS, MESSAGES }

export function isAppLocale(v: unknown): v is AppLocale {
  return v === 'zh-CN' || v === 'en'
}

export function translate(
  locale: AppLocale,
  key: MessageKey,
  vars?: Record<string, string | number>,
): string {
  const table = MESSAGES[locale] || MESSAGES['zh-CN']
  let text = table[key] ?? MESSAGES['zh-CN'][key] ?? key
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      text = text.replaceAll(`{{${k}}}`, String(v))
    }
  }
  return text
}

export function applyDocumentLocale(locale: AppLocale) {
  document.documentElement.lang = locale === 'zh-CN' ? 'zh-CN' : 'en'
}
