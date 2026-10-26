import type {
  AiProvider,
  AiProviderEntry,
  AiSettings,
  AiStudySettings,
  AppLocale,
  ResolvedAiConfig,
} from '../pdf/types'

export const AI_PROVIDER_KINDS: AiProvider[] = [
  'openai',
  'anthropic',
  'claude-code',
  'codex',
]

export function isAiProviderKind(v: unknown): v is AiProvider {
  return typeof v === 'string' && AI_PROVIDER_KINDS.includes(v as AiProvider)
}

/** 常见模型预设；仍可直接输入任意模型名，或从服务端拉取模型列表 */
export const PROVIDER_MODEL_PRESETS: Record<string, string[]> = {
  anthropic: [
    'claude-opus-5-5',
    'claude-sonnet-5-5',
    'claude-haiku-5-5',
    'claude-fable-5-1',
  ],
  openai: ['gpt-5.1', 'gpt-5.1-mini', 'gpt-5', 'gpt-4.1', 'o4-mini'],
  deepseek: ['deepseek-flash', 'deepseek-v4-pro'],
  google: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'],
  openrouter: [
    'google/gemini-2.5-pro',
    'openai/gpt-5.1',
    'anthropic/claude-sonnet-5-5',
    'deepseek/deepseek-chat',
    'qwen/qwen3-235b-a22b',
  ],
  ollama: ['qwen3:8b', 'deepseek-r1:8b', 'llama3.2', 'gemma3:12b'],
  groq: ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'qwen/qwen3-32b'],
  xai: ['grok-4', 'grok-3', 'grok-3-mini'],
  mistral: ['mistral-large-latest', 'mistral-medium-latest', 'codestral-latest'],
  moonshot: ['kimi-k2-0905-preview', 'kimi-k2-turbo-preview', 'moonshot-v1-128k'],
}

export function modelPresets(entry: AiProviderEntry): string[] {
  return PROVIDER_MODEL_PRESETS[entry.id] ?? []
}

/** 内置 Provider 模板（凭证字段为空，由用户填写） */
export function createBuiltinProviders(): AiProviderEntry[] {
  const entry = (
    id: string,
    kind: AiProvider,
    name: string,
    subtitle: string,
    apiBase: string,
    model: string,
  ): AiProviderEntry => ({
    id,
    kind,
    name,
    subtitle,
    builtin: true,
    apiBase,
    apiKey: '',
    model,
    cliPath: '',
    cliArgs: '',
  })

  return [
    entry(
      'anthropic',
      'anthropic',
      'Anthropic (Claude)',
      'Official Claude API · adaptive thinking / prompt caching',
      'https://api.anthropic.com',
      'claude-opus-5-5',
    ),
    entry(
      'claude-code',
      'claude-code',
      'Claude Code CLI (local)',
      "Uses the local 'claude' binary — no API key needed",
      '',
      '',
    ),
    entry(
      'codex',
      'codex',
      'Codex CLI (local)',
      "Uses the local 'codex' binary — no API key needed",
      '',
      '',
    ),
    entry(
      'openai',
      'openai',
      'OpenAI (GPT)',
      'Official OpenAI API',
      'https://api.openai.com/v1',
      'gpt-5.1',
    ),
    entry(
      'deepseek',
      'openai',
      'DeepSeek',
      'api.deepseek.com · deepseek-flash / deepseek-v4-pro',
      'https://api.deepseek.com',
      'deepseek-flash',
    ),
    entry(
      'google',
      'openai',
      'Google Gemini',
      'OpenAI-compatible endpoint · gemini-2.5',
      'https://generativelanguage.googleapis.com/v1beta/openai',
      'gemini-2.5-pro',
    ),
    entry(
      'openrouter',
      'openai',
      'OpenRouter',
      'One key, many models',
      'https://openrouter.ai/api/v1',
      'google/gemini-2.5-pro',
    ),
    entry(
      'ollama',
      'openai',
      'Ollama (local)',
      'Private & offline · http://localhost:11434',
      'http://localhost:11434/v1',
      'qwen3:8b',
    ),
    entry(
      'groq',
      'openai',
      'Groq',
      'Very fast inference · api.groq.com',
      'https://api.groq.com/openai/v1',
      'llama-3.3-70b-versatile',
    ),
    entry(
      'xai',
      'openai',
      'xAI (Grok)',
      'api.x.ai',
      'https://api.x.ai/v1',
      'grok-4',
    ),
    entry(
      'mistral',
      'openai',
      'Mistral',
      'api.mistral.ai',
      'https://api.mistral.ai/v1',
      'mistral-large-latest',
    ),
    entry(
      'moonshot',
      'openai',
      'Moonshot (Kimi)',
      'api.moonshot.cn · long context',
      'https://api.moonshot.cn/v1',
      'kimi-k2-0905-preview',
    ),
    entry(
      'azure-openai',
      'openai',
      'Azure OpenAI',
      'Use https://<resource>.openai.azure.com/openai/v1 · Model = deployment name',
      '',
      '',
    ),
  ]
}

export function createCustomProvider(name = 'Custom Provider'): AiProviderEntry {
  const id = `custom-${Date.now().toString(36)}`
  return {
    id,
    kind: 'openai',
    name,
    subtitle: 'OpenAI-compatible endpoint',
    builtin: false,
    apiBase: '',
    apiKey: '',
    model: '',
    cliPath: '',
    cliArgs: '',
  }
}

export function defaultStudySettings(): AiStudySettings {
  return {
    contextMode: 'auto',
    replyLocale: 'auto',
    maxContextChars: 160_000,
    keepHistory: true,
    includeAnnotations: true,
    customSystemPrompt: '',
  }
}

export function defaultAiSettings(): AiSettings {
  return {
    // Claude Code CLI 已在本机时无需 API Key，开箱即用
    activeId: 'claude-code',
    providers: createBuiltinProviders(),
    study: defaultStudySettings(),
  }
}

export function getActiveProvider(settings: AiSettings): AiProviderEntry {
  const found = settings.providers.find((p) => p.id === settings.activeId)
  if (found) return found
  return (
    settings.providers.find((p) => p.id === 'claude-code') ??
    settings.providers[0] ??
    createBuiltinProviders()[0]
  )
}

export function resolveAiConfig(settings: AiSettings): ResolvedAiConfig {
  const p = getActiveProvider(settings)
  return {
    provider: p.kind,
    apiBase: p.apiBase,
    apiKey: p.apiKey,
    model: p.model,
    cliPath: p.cliPath,
    cliArgs: p.cliArgs,
  }
}

export function isCliKind(kind: AiProvider): boolean {
  return kind === 'claude-code' || kind === 'codex'
}

function isLocalApiBase(base: string): boolean {
  return /(^|\/\/)(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i.test(base)
}

function requiresApiKey(entry: AiProviderEntry): boolean {
  if (entry.kind === 'anthropic') return true
  if (!entry.builtin) return false
  return entry.id !== 'ollama'
}

/** 配置是否可用；返回 null 表示可以发起请求 */
export function aiConfigIssue(
  entry: AiProviderEntry,
  locale: AppLocale,
): string | null {
  const en = locale === 'en'
  if (entry.builtin && isCliKind(entry.kind)) return null
  if (!entry.apiBase.trim()) {
    return en ? 'Set the API Base in AI settings.' : '请在 AI 设置中填写 API Base。'
  }
  if (!entry.model.trim()) {
    return en ? 'Set a model in AI settings.' : '请在 AI 设置中填写模型。'
  }
  if (
    requiresApiKey(entry) &&
    !entry.apiKey.trim() &&
    !isLocalApiBase(entry.apiBase)
  ) {
    return en
      ? 'Set the API Key in AI settings.'
      : '请在 AI 设置中填写 API Key。'
  }
  return null
}
