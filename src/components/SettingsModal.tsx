import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type {
  AiSettings,
  AppLocale,
  AppSettings,
  OcrSettings,
  OcrTier,
} from '../lib/pdf/types'
import { LOCALE_OPTIONS } from '../lib/i18n'
import { useI18n } from '../lib/i18n/I18nContext'
import {
  detectOcrBackends,
  type OcrBackendStatus,
} from '../lib/ocr/client'
import { AiProviderSettings } from './AiProviderSettings'
import { CustomCssPanel } from './CustomCssPanel'

type NavId = 'appearance' | 'reading' | 'highlight' | 'ocr' | 'ai' | 'css'

type Props = {
  open: boolean
  settings: AppSettings
  ocr: OcrSettings
  ai: AiSettings
  onClose: () => void
  onChange: (next: AppSettings) => void
  onOcrChange: (next: OcrSettings) => void
  onAiChange: (next: AiSettings) => void
  onOpenPalette: () => void
  initialNav?: NavId
}

function SettingItem({
  name,
  desc,
  children,
}: {
  name: string
  desc?: string
  children: ReactNode
}) {
  return (
    <div className="obs-setting-item">
      <div className="obs-setting-info">
        <div className="obs-setting-name">{name}</div>
        {desc ? <div className="obs-setting-desc">{desc}</div> : null}
      </div>
      <div className="obs-setting-control">{children}</div>
    </div>
  )
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
}) {
  return (
    <button
      type="button"
      className={`obs-toggle${checked ? ' is-on' : ''}`}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
    >
      <span className="obs-toggle-thumb" />
    </button>
  )
}

export function SettingsModal({
  open,
  settings,
  ocr,
  ai,
  onClose,
  onChange,
  onOcrChange,
  onAiChange,
  onOpenPalette,
  initialNav = 'appearance',
}: Props) {
  const { t } = useI18n()
  const [nav, setNav] = useState<NavId>(initialNav)
  const [query, setQuery] = useState('')
  const [ocrBackend, setOcrBackend] = useState<OcrBackendStatus | null>(null)

  useEffect(() => {
    if (open) setNav(initialNav)
  }, [open, initialNav])

  useEffect(() => {
    if (!open || nav !== 'ocr') return
    let cancelled = false
    void detectOcrBackends().then((status) => {
      if (!cancelled) setOcrBackend(status)
    })
    return () => {
      cancelled = true
    }
  }, [open, nav])

  const patch = (partial: Partial<AppSettings>) => onChange({ ...settings, ...partial })

  const navItems = useMemo(
    () =>
      [
        {
          id: 'appearance' as const,
          label: t('settings.nav.appearance'),
          icon: '◇',
          group: t('settings.group.options'),
        },
        {
          id: 'reading' as const,
          label: t('settings.nav.reading'),
          icon: '☰',
          group: t('settings.group.options'),
        },
        {
          id: 'highlight' as const,
          label: t('settings.nav.highlight'),
          icon: '▮',
          group: t('settings.group.options'),
        },
        {
          id: 'ocr' as const,
          label: t('settings.nav.ocr'),
          icon: '⬚',
          group: t('settings.group.options'),
        },
        {
          id: 'ai' as const,
          label: t('settings.nav.ai'),
          icon: '✦',
          group: t('settings.group.options'),
        },
        {
          id: 'css' as const,
          label: t('settings.nav.css'),
          icon: '</>',
          group: t('settings.group.advanced'),
        },
      ] satisfies { id: NavId; label: string; icon: string; group: string }[],
    [t],
  )

  const filteredNav = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return navItems
    return navItems.filter(
      (item) =>
        item.label.toLowerCase().includes(q) ||
        item.group.toLowerCase().includes(q),
    )
  }, [query, navItems])

  const groups = useMemo(() => {
    const map = new Map<string, typeof navItems>()
    for (const item of filteredNav) {
      const list = map.get(item.group) || []
      list.push(item)
      map.set(item.group, list)
    }
    return [...map.entries()]
  }, [filteredNav])

  if (!open) return null

  const active = filteredNav.some((x) => x.id === nav) ? nav : filteredNav[0]?.id

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal settings-modal obs-settings"
        role="dialog"
        aria-labelledby="app-settings-title"
        onClick={(e) => e.stopPropagation()}
      >
        <aside className="obs-settings-nav">
          <div className="obs-settings-search">
            <span className="obs-settings-search-icon" aria-hidden>
              ⌕
            </span>
            <input
              type="search"
              placeholder={t('settings.search')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label={t('settings.searchAria')}
            />
          </div>

          <nav className="obs-settings-nav-list" aria-label={t('settings.navAria')}>
            {groups.length === 0 ? (
              <div className="obs-settings-empty">{t('settings.noMatch')}</div>
            ) : (
              groups.map(([group, items]) => (
                <div key={group} className="obs-nav-group">
                  <div className="obs-nav-group-title">{group}</div>
                  {items.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className={`obs-nav-item${active === item.id ? ' is-active' : ''}`}
                      onClick={() => setNav(item.id)}
                    >
                      <span className="obs-nav-icon" aria-hidden>
                        {item.icon}
                      </span>
                      <span>{item.label}</span>
                    </button>
                  ))}
                </div>
              ))
            )}
          </nav>
        </aside>

        <section className="obs-settings-main">
          <header className="obs-settings-main-header">
            <h2 id="app-settings-title">
              {navItems.find((x) => x.id === active)?.label || t('settings.title')}
            </h2>
            <button
              type="button"
              className="btn icon-btn"
              onClick={onClose}
              title={t('app.close')}
              aria-label={t('app.close')}
            >
              ✕
            </button>
          </header>

          <div className="obs-settings-content">
            {active === 'appearance' && (
              <>
                <h3 className="obs-section-heading">{t('settings.section.language')}</h3>
                <div className="obs-setting-group">
                  <SettingItem
                    name={t('settings.locale.name')}
                    desc={t('settings.locale.desc')}
                  >
                    <select
                      className="obs-dropdown"
                      value={settings.locale}
                      onChange={(e) => {
                        const next = e.target.value as AppLocale
                        if (next === 'zh-CN' || next === 'en') {
                          patch({ locale: next })
                        }
                      }}
                    >
                      {LOCALE_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {t(opt.labelKey)}
                        </option>
                      ))}
                    </select>
                  </SettingItem>
                </div>

                <h3 className="obs-section-heading">{t('settings.section.theme')}</h3>
                <div className="obs-setting-group">
                  <SettingItem
                    name={t('settings.theme.name')}
                    desc={t('settings.theme.desc')}
                  >
                    <select
                      className="obs-dropdown"
                      value={settings.theme}
                      onChange={(e) =>
                        patch({
                          theme: e.target.value === 'light' ? 'light' : 'dark',
                        })
                      }
                    >
                      <option value="dark">{t('settings.theme.dark')}</option>
                      <option value="light">{t('settings.theme.light')}</option>
                    </select>
                  </SettingItem>
                  <SettingItem
                    name={t('settings.motion.name')}
                    desc={t('settings.motion.desc')}
                  >
                    <Toggle
                      checked={settings.smoothAnimations}
                      onChange={(v) => patch({ smoothAnimations: v })}
                      label={t('settings.motion.name')}
                    />
                  </SettingItem>
                  <SettingItem
                    name={t('settings.cssLink.name')}
                    desc={t('settings.cssLink.desc')}
                  >
                    <button
                      type="button"
                      className="obs-link-btn"
                      onClick={() => setNav('css')}
                    >
                      {t('settings.cssLink.manage')} <span aria-hidden>›</span>
                    </button>
                  </SettingItem>
                </div>
              </>
            )}

            {active === 'reading' && (
              <>
                <h3 className="obs-section-heading">{t('settings.section.reading')}</h3>
                <div className="obs-setting-group">
                  <SettingItem
                    name={t('settings.scale.name')}
                    desc={t('settings.scale.desc')}
                  >
                    <div className="obs-slider-wrap">
                      <input
                        className="obs-slider"
                        type="range"
                        min={50}
                        max={300}
                        step={10}
                        value={Math.round(settings.defaultScale * 100)}
                        onChange={(e) => {
                          const pct = Number(e.target.value)
                          patch({
                            defaultScale: Math.min(3, Math.max(0.5, pct / 100)),
                          })
                        }}
                      />
                      <span className="obs-slider-value">
                        {Math.round(settings.defaultScale * 100)}%
                      </span>
                    </div>
                  </SettingItem>
                  <SettingItem
                    name={t('settings.sidebar.name')}
                    desc={t('settings.sidebar.desc')}
                  >
                    <Toggle
                      checked={settings.sidebarOpen}
                      onChange={(v) => patch({ sidebarOpen: v })}
                      label={t('settings.sidebar.name')}
                    />
                  </SettingItem>
                </div>
              </>
            )}

            {active === 'highlight' && (
              <>
                <h3 className="obs-section-heading">{t('settings.section.highlight')}</h3>
                <div className="obs-setting-group">
                  <SettingItem
                    name={t('settings.palette.name')}
                    desc={t('settings.palette.desc')}
                  >
                    <button
                      type="button"
                      className="obs-btn"
                      onClick={() => {
                        onClose()
                        onOpenPalette()
                      }}
                    >
                      {t('settings.palette.manage')}
                    </button>
                  </SettingItem>
                </div>
              </>
            )}

            {active === 'ocr' && (
              <>
                <h3 className="obs-section-heading">{t('settings.section.ocr')}</h3>
                <div className="obs-setting-group">
                  <SettingItem
                    name={t('settings.ocr.mode.name')}
                    desc={t('settings.ocr.mode.desc')}
                  >
                    <select
                      className="obs-dropdown"
                      value={ocr.mode}
                      onChange={(e) =>
                        onOcrChange({
                          ...ocr,
                          mode: e.target.value as OcrSettings['mode'],
                        })
                      }
                    >
                      <option value="offline">{t('settings.ocr.mode.offline')}</option>
                      <option value="online">{t('settings.ocr.mode.online')}</option>
                    </select>
                  </SettingItem>
                  <SettingItem
                    name={t('settings.ocr.tier.name')}
                    desc={t('settings.ocr.tier.desc')}
                  >
                    <select
                      className="obs-dropdown"
                      value={ocr.tier}
                      disabled={ocr.mode === 'online'}
                      onChange={(e) =>
                        onOcrChange({
                          ...ocr,
                          tier: e.target.value as OcrTier,
                        })
                      }
                    >
                      <option value="tiny">{t('settings.ocr.tier.tiny')}</option>
                      <option value="small">{t('settings.ocr.tier.small')}</option>
                      <option value="medium">{t('settings.ocr.tier.medium')}</option>
                    </select>
                  </SettingItem>
                  <SettingItem
                    name={t('settings.ocr.device.name')}
                    desc={t('settings.ocr.device.desc')}
                  >
                    <span className="obs-setting-value">
                      {ocrBackend
                        ? ocrBackend.gpuAvailable
                          ? t('settings.ocr.device.gpu', {
                              device: ocrBackend.device || 'gpu:0',
                            })
                          : t('settings.ocr.device.cpu')
                        : t('settings.ocr.device.detecting')}
                    </span>
                  </SettingItem>
                  <SettingItem
                    name={t('settings.ocr.url.name')}
                    desc={t('settings.ocr.url.desc')}
                  >
                    <input
                      className="obs-text-input"
                      type="url"
                      placeholder="https://example.com/ocr"
                      value={ocr.apiUrl}
                      disabled={ocr.mode === 'offline'}
                      onChange={(e) =>
                        onOcrChange({ ...ocr, apiUrl: e.target.value })
                      }
                    />
                  </SettingItem>
                  <SettingItem
                    name={t('settings.ocr.key.name')}
                    desc={t('settings.ocr.key.desc')}
                  >
                    <input
                      className="obs-text-input"
                      type="password"
                      placeholder={t('settings.ocr.key.placeholder')}
                      value={ocr.apiKey}
                      disabled={ocr.mode === 'offline'}
                      onChange={(e) =>
                        onOcrChange({ ...ocr, apiKey: e.target.value })
                      }
                    />
                  </SettingItem>
                  <SettingItem
                    name={t('settings.ocr.lang.name')}
                    desc={t('settings.ocr.lang.desc')}
                  >
                    <input
                      className="obs-text-input"
                      type="text"
                      value={ocr.language}
                      disabled={ocr.mode === 'offline'}
                      onChange={(e) =>
                        onOcrChange({ ...ocr, language: e.target.value })
                      }
                    />
                  </SettingItem>
                </div>
              </>
            )}

            {active === 'ai' && (
              <AiProviderSettings ai={ai} onChange={onAiChange} />
            )}

            {active === 'css' && (
              <CustomCssPanel
                value={settings.customCss}
                onChange={(customCss) => patch({ customCss })}
              />
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
