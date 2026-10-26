import { useState } from 'react'
import {
  aiConfigIssue,
  createCustomProvider,
  defaultSystemPromptBody,
  isCliKind,
  listAiModels,
  modelPresets,
  testAiConnection,
  type ModelInfo,
} from '../lib/ai'
import type {
  AiProvider,
  AiProviderEntry,
  AiSettings,
  AiStudySettings,
} from '../lib/pdf/types'
import { useI18n } from '../lib/i18n/I18nContext'

type Props = {
  ai: AiSettings
  onChange: (next: AiSettings) => void
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
      onClick={(e) => {
        e.stopPropagation()
        onChange(!checked)
      }}
    >
      <span className="obs-toggle-thumb" />
    </button>
  )
}

export function AiProviderSettings({ ai, onChange }: Props) {
  const { t, locale } = useI18n()
  const [expandedId, setExpandedId] = useState<string | null>(ai.activeId)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [testMsg, setTestMsg] = useState<{ id: string; text: string } | null>(
    null,
  )
  const [fetchingId, setFetchingId] = useState<string | null>(null)
  const [fetchedModels, setFetchedModels] = useState<
    Record<string, ModelInfo[]>
  >({})
  const [fetchMsg, setFetchMsg] = useState<{ id: string; text: string } | null>(
    null,
  )

  const patchProvider = (id: string, partial: Partial<AiProviderEntry>) => {
    onChange({
      ...ai,
      providers: ai.providers.map((p) => (p.id === id ? { ...p, ...partial } : p)),
    })
  }

  const patchStudy = (partial: Partial<AiStudySettings>) => {
    onChange({ ...ai, study: { ...ai.study, ...partial } })
  }

  const activate = (id: string) => {
    onChange({ ...ai, activeId: id })
    setExpandedId(id)
    setTestMsg(null)
  }

  const addCustom = () => {
    const entry = createCustomProvider(
      locale === 'en' ? 'Custom Provider' : '自定义 Provider',
    )
    onChange({
      ...ai,
      activeId: entry.id,
      providers: [...ai.providers, entry],
    })
    setExpandedId(entry.id)
  }

  const removeCustom = (id: string) => {
    const nextProviders = ai.providers.filter((p) => p.id !== id)
    const nextActive =
      ai.activeId === id
        ? (nextProviders.find((p) => p.builtin)?.id ??
          nextProviders[0]?.id ??
          'claude-code')
        : ai.activeId
    onChange({ ...ai, activeId: nextActive, providers: nextProviders })
    if (expandedId === id) setExpandedId(nextActive)
  }

  const onTest = async (entry: AiProviderEntry) => {
    setTestingId(entry.id)
    setTestMsg(null)
    try {
      const reply = await testAiConnection(
        { ...ai, activeId: entry.id },
        locale,
      )
      setTestMsg({
        id: entry.id,
        text: `${t('settings.ai.testOk')}: ${reply.slice(0, 80)}`,
      })
    } catch (e) {
      setTestMsg({
        id: entry.id,
        text: `${t('settings.ai.testFail')}: ${e instanceof Error ? e.message : String(e)}`,
      })
    } finally {
      setTestingId(null)
    }
  }

  const onFetchModels = async (entry: AiProviderEntry) => {
    setFetchingId(entry.id)
    setFetchMsg(null)
    try {
      const list = await listAiModels({ ...ai, activeId: entry.id })
      setFetchedModels((prev) => ({ ...prev, [entry.id]: list }))
      if (!list.length) {
        setFetchMsg({ id: entry.id, text: t('settings.ai.fetchEmpty') })
      }
    } catch (e) {
      setFetchMsg({
        id: entry.id,
        text: `${t('settings.ai.fetchFail')}: ${e instanceof Error ? e.message : String(e)}`,
      })
    } finally {
      setFetchingId(null)
    }
  }

  const study = ai.study

  return (
    <div className="ai-provider-page">
      <header className="ai-provider-page-head">
        <h3 className="obs-section-heading" style={{ margin: 0 }}>
          {t('settings.section.ai')}
        </h3>
        <p className="ai-provider-page-desc">{t('settings.ai.page.desc')}</p>
      </header>

      <section className="ai-study-card" aria-label={t('settings.ai.studyTitle')}>
        <div className="ai-study-head">
          <h4>{t('settings.ai.studyTitle')}</h4>
          <p className="ai-provider-page-desc">{t('settings.ai.studyDesc')}</p>
        </div>

        <div className="ai-study-grid">
          <label className="ai-provider-field">
            <span>{t('settings.ai.contextMode.name')}</span>
            <select
              className="obs-text-input"
              value={study.contextMode}
              onChange={(e) =>
                patchStudy({
                  contextMode: e.target.value as AiStudySettings['contextMode'],
                })
              }
            >
              <option value="auto">{t('settings.ai.contextMode.auto')}</option>
              <option value="full">{t('settings.ai.contextMode.full')}</option>
              <option value="retrieval">
                {t('settings.ai.contextMode.retrieval')}
              </option>
            </select>
            <small className="settings-hint">
              {t('settings.ai.contextMode.desc')}
            </small>
          </label>

          <label className="ai-provider-field">
            <span>{t('settings.ai.replyLocale.name')}</span>
            <select
              className="obs-text-input"
              value={study.replyLocale}
              onChange={(e) =>
                patchStudy({
                  replyLocale: e.target.value as AiStudySettings['replyLocale'],
                })
              }
            >
              <option value="auto">{t('settings.ai.replyLocale.auto')}</option>
              <option value="zh-CN">{t('settings.ai.replyLocale.zh')}</option>
              <option value="en">{t('settings.ai.replyLocale.en')}</option>
            </select>
            <small className="settings-hint">
              {t('settings.ai.replyLocale.desc')}
            </small>
          </label>

          <label className="ai-provider-field">
            <span>{t('settings.ai.maxChars.name')}</span>
            <input
              className="obs-text-input"
              type="number"
              min={20_000}
              max={600_000}
              step={10_000}
              value={study.maxContextChars}
              onChange={(e) => {
                const value = Number(e.target.value)
                if (!Number.isFinite(value)) return
                patchStudy({
                  maxContextChars: Math.min(
                    600_000,
                    Math.max(20_000, Math.round(value)),
                  ),
                })
              }}
            />
            <small className="settings-hint">
              {t('settings.ai.maxChars.desc')} ·{' '}
              {t('settings.ai.studyHint', {
                tokens: Math.round(study.maxContextChars / 2),
              })}
            </small>
          </label>

          <div className="ai-study-toggle-row">
            <div>
              <div className="ai-study-toggle-name">
                {t('settings.ai.keepHistory.name')}
              </div>
              <small className="settings-hint">
                {t('settings.ai.keepHistory.desc')}
              </small>
            </div>
            <Toggle
              checked={study.keepHistory}
              label={t('settings.ai.keepHistory.name')}
              onChange={(v) => patchStudy({ keepHistory: v })}
            />
          </div>

          <div className="ai-study-toggle-row">
            <div>
              <div className="ai-study-toggle-name">
                {t('settings.ai.includeAnnotations.name')}
              </div>
              <small className="settings-hint">
                {t('settings.ai.includeAnnotations.desc')}
              </small>
            </div>
            <Toggle
              checked={study.includeAnnotations}
              label={t('settings.ai.includeAnnotations.name')}
              onChange={(v) => patchStudy({ includeAnnotations: v })}
            />
          </div>

          <div className="ai-study-prompt">
            <div className="ai-study-prompt-head">
              <div>
                <div className="ai-study-toggle-name">
                  {t('settings.ai.customPrompt.name')}
                </div>
                <small className="settings-hint">
                  {study.customSystemPrompt.trim()
                    ? t('settings.ai.customPrompt.usingCustom')
                    : t('settings.ai.customPrompt.usingDefault')}
                  {' · '}
                  {t('settings.ai.customPrompt.desc')}
                </small>
              </div>
              <button
                type="button"
                className="btn tiny"
                disabled={!study.customSystemPrompt}
                onClick={() => patchStudy({ customSystemPrompt: '' })}
              >
                {t('settings.ai.customPrompt.reset')}
              </button>
            </div>
            <textarea
              className="ai-study-prompt-input"
              rows={10}
              spellCheck={false}
              value={study.customSystemPrompt}
              placeholder={defaultSystemPromptBody(locale)}
              onChange={(e) =>
                patchStudy({
                  customSystemPrompt: e.target.value.slice(0, 20_000),
                })
              }
            />
          </div>
        </div>
      </section>

      <div className="ai-provider-toolbar">
        <button type="button" className="ai-provider-add" onClick={addCustom}>
          {t('settings.ai.addCustom')}
        </button>
      </div>

      <ul className="ai-provider-list">
        {ai.providers.map((entry) => {
          const active = entry.id === ai.activeId
          const open = expandedId === entry.id
          const cli = isCliKind(entry.kind)
          const presets = modelPresets(entry)
          const models = fetchedModels[entry.id] ?? []
          const issue = active ? aiConfigIssue(entry, locale) : null

          return (
            <li
              key={entry.id}
              className={`ai-provider-card${active ? ' is-active' : ''}${open ? ' is-open' : ''}`}
            >
              <div
                className="ai-provider-row"
                role="button"
                tabIndex={0}
                onClick={() => setExpandedId(open ? null : entry.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    setExpandedId(open ? null : entry.id)
                  }
                }}
              >
                <span
                  className={`ai-provider-chevron${open ? ' is-open' : ''}`}
                  aria-hidden
                >
                  ▸
                </span>
                <div className="ai-provider-meta">
                  <div className="ai-provider-title-row">
                    <span className="ai-provider-name">{entry.name}</span>
                    {active ? (
                      <span className="ai-provider-badge">
                        {t('settings.ai.active')}
                      </span>
                    ) : null}
                  </div>
                  <span className="ai-provider-sub">
                    {entry.subtitle || entry.apiBase}
                  </span>
                </div>
                <Toggle
                  checked={active}
                  label={t('settings.ai.activate')}
                  onChange={(on) => {
                    if (on) activate(entry.id)
                  }}
                />
              </div>

              {open ? (
                <div
                  className="ai-provider-body"
                  onClick={(e) => e.stopPropagation()}
                >
                  {active && issue ? (
                    <p className="ai-provider-issue">
                      {t('ai.providerIssue')}：{issue}
                    </p>
                  ) : null}

                  {!entry.builtin ? (
                    <label className="ai-provider-field">
                      <span>{t('settings.ai.name')}</span>
                      <input
                        className="obs-text-input"
                        type="text"
                        value={entry.name}
                        onChange={(e) =>
                          patchProvider(entry.id, { name: e.target.value })
                        }
                      />
                    </label>
                  ) : null}

                  {!entry.builtin ? (
                    <label className="ai-provider-field">
                      <span>{t('settings.ai.kind.name')}</span>
                      <select
                        className="obs-text-input"
                        value={entry.kind === 'anthropic' ? 'anthropic' : 'openai'}
                        onChange={(e) =>
                          patchProvider(entry.id, {
                            kind: e.target.value as AiProvider,
                          })
                        }
                      >
                        <option value="openai">
                          {t('settings.ai.kind.openai')}
                        </option>
                        <option value="anthropic">
                          {t('settings.ai.kind.anthropic')}
                        </option>
                      </select>
                      <small className="settings-hint">
                        {t('settings.ai.kind.desc')}
                      </small>
                    </label>
                  ) : null}

                  {cli ? (
                    <>
                      <label className="ai-provider-field">
                        <span>{t('settings.ai.cliPath.name')}</span>
                        <input
                          className="obs-text-input"
                          type="text"
                          placeholder={entry.kind === 'codex' ? 'codex' : 'claude'}
                          value={entry.cliPath}
                          onChange={(e) =>
                            patchProvider(entry.id, {
                              cliPath: e.target.value,
                            })
                          }
                        />
                      </label>
                      <label className="ai-provider-field">
                        <span>{t('settings.ai.cliArgs.name')}</span>
                        <input
                          className="obs-text-input"
                          type="text"
                          value={entry.cliArgs}
                          onChange={(e) =>
                            patchProvider(entry.id, {
                              cliArgs: e.target.value,
                            })
                          }
                        />
                      </label>
                      <p className="settings-hint">
                        {t('settings.ai.cliTextOnly')}
                      </p>
                    </>
                  ) : (
                    <>
                      <label className="ai-provider-field">
                        <span>{t('settings.ai.apiBase.name')}</span>
                        <input
                          className="obs-text-input"
                          type="url"
                          value={entry.apiBase}
                          onChange={(e) => {
                            const apiBase = e.target.value
                            patchProvider(entry.id, {
                              apiBase,
                              ...(!entry.builtin
                                ? { subtitle: apiBase || entry.subtitle }
                                : {}),
                            })
                          }}
                        />
                      </label>
                      <label className="ai-provider-field">
                        <span>{t('settings.ai.apiKey.name')}</span>
                        <input
                          className="obs-text-input"
                          type="password"
                          autoComplete="off"
                          placeholder={t('settings.ai.localKeyless')}
                          value={entry.apiKey}
                          onChange={(e) =>
                            patchProvider(entry.id, {
                              apiKey: e.target.value,
                            })
                          }
                        />
                        <small className="settings-hint">
                          {t('settings.ai.apiKey.desc')}
                        </small>
                      </label>
                      <label className="ai-provider-field">
                        <span>{t('settings.ai.model.name')}</span>
                        <input
                          className="obs-text-input"
                          type="text"
                          list={`ai-models-${entry.id}`}
                          value={entry.model}
                          onChange={(e) =>
                            patchProvider(entry.id, {
                              model: e.target.value,
                            })
                          }
                        />
                        <datalist id={`ai-models-${entry.id}`}>
                          {[...presets, ...models.map((m) => m.id)].map((id) => (
                            <option key={id} value={id} />
                          ))}
                        </datalist>
                        <small className="settings-hint">
                          {t('settings.ai.model.desc')}
                        </small>
                      </label>

                      {presets.length ? (
                        <div className="ai-model-presets">
                          <span className="ai-model-presets-label">
                            {t('settings.ai.modelPresets')}
                          </span>
                          <div className="ai-model-chips">
                            {presets.map((model) => (
                              <button
                                key={model}
                                type="button"
                                className={`ai-model-chip${entry.model === model ? ' is-active' : ''}`}
                                onClick={() =>
                                  patchProvider(entry.id, { model })
                                }
                              >
                                {model}
                              </button>
                            ))}
                          </div>
                        </div>
                      ) : null}

                      {models.length ? (
                        <div className="ai-model-presets">
                          <div className="ai-model-chips">
                            {models.slice(0, 60).map((model) => (
                              <button
                                key={model.id}
                                type="button"
                                className={`ai-model-chip${entry.model === model.id ? ' is-active' : ''}`}
                                title={model.label || model.id}
                                onClick={() =>
                                  patchProvider(entry.id, { model: model.id })
                                }
                              >
                                {model.label || model.id}
                              </button>
                            ))}
                          </div>
                        </div>
                      ) : null}
                    </>
                  )}

                  <div className="ai-provider-actions">
                    <button
                      type="button"
                      className="obs-btn"
                      disabled={testingId === entry.id}
                      onClick={() => void onTest(entry)}
                    >
                      {testingId === entry.id
                        ? t('settings.ai.testing')
                        : t('settings.ai.test')}
                    </button>
                    {!cli ? (
                      <button
                        type="button"
                        className="obs-btn"
                        disabled={fetchingId === entry.id}
                        onClick={() => void onFetchModels(entry)}
                      >
                        {fetchingId === entry.id
                          ? t('settings.ai.fetching')
                          : t('settings.ai.fetchModels')}
                      </button>
                    ) : null}
                    {!entry.builtin ? (
                      <button
                        type="button"
                        className="obs-btn obs-btn-danger"
                        onClick={() => removeCustom(entry.id)}
                      >
                        {t('settings.ai.remove')}
                      </button>
                    ) : null}
                  </div>
                  {testMsg?.id === entry.id ? (
                    <p className="settings-hint">{testMsg.text}</p>
                  ) : null}
                  {fetchMsg?.id === entry.id ? (
                    <p className="settings-hint">{fetchMsg.text}</p>
                  ) : null}
                </div>
              ) : null}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
