export type OutlineItem = {
  title: string
  pageIndex: number | null
  items: OutlineItem[]
}

export type HighlightRect = {
  x: number
  y: number
  width: number
  height: number
}

/** 用户自定义的高亮色及含义 */
export type HighlightPaletteItem = {
  id: string
  color: string
  /** 该颜色代表的含义，如「重点」「疑问」 */
  label: string
}

/** 文字高亮；可附带批注 note */
export type Highlight = {
  id: string
  pageIndex: number
  color: string
  /** 应用时快照的颜色含义 */
  colorLabel?: string
  text: string
  note: string
  /** 目录中自定义显示文案；空则回退为选中原文 text */
  outlineTitle?: string
  rects: HighlightRect[]
  createdAt: number
}

/** 页面级批注（与高亮无关） */
export type PageAnnotation = {
  id: string
  pageIndex: number
  body: string
  createdAt: number
}

/** 三向索引一行：页码 ↔ 高亮 ↔ 批注 */
export type IndexRow = {
  id: string
  pageIndex: number
  highlightId: string | null
  highlightText: string
  annotationId: string | null
  annotationText: string
  kind: 'highlight' | 'page-note' | 'both'
}

export type OcrMode = 'offline' | 'online'

/** PP-OCRv6 档位：速度优先 → 精度优先 */
export type OcrTier = 'tiny' | 'small' | 'medium'

export type OcrSettings = {
  mode: OcrMode
  apiUrl: string
  apiKey: string
  language: string
  /** 离线识别档位 */
  tier: OcrTier
}

export type OcrWord = {
  text: string
  x0: number
  y0: number
  x1: number
  y1: number
}

export type OcrPageOverlay = {
  pageIndex: number
  text: string
  words: OcrWord[]
  mode: OcrMode
}

/** 用户自定义的页标题（不含页号），key 为 pageIndex 字符串 */
export type PageTitleMap = Record<string, string>

/** 落盘的工程文件（与 PDF 同目录的 .pdfview.json） */
export type ProjectFile = {
  version: 1
  fileName: string
  savedAt: number
  outline: OutlineItem[]
  highlights: Highlight[]
  pageAnnotations: PageAnnotation[]
  ocrOverlays: OcrPageOverlay[]
  /** 目录页重命名：只改标题文案，不改页号 */
  pageTitles?: PageTitleMap
  scale: number
  pageIndex: number
}

/** 应用级偏好（localStorage，与工程文件无关） */
export type AppTheme = 'dark' | 'light'

export type AppLocale = 'zh-CN' | 'en'

export type AppSettings = {
  theme: AppTheme
  /** 界面语言 */
  locale: AppLocale
  /** 新打开文档时的默认缩放 */
  defaultScale: number
  /** 启动时是否显示侧栏 */
  sidebarOpen: boolean
  /** 左侧边栏宽度（px） */
  sidebarWidth: number
  /** 右侧 AI 面板宽度（px） */
  aiPanelWidth: number
  /** 是否开启界面平滑动画 */
  smoothAnimations: boolean
  /** 用户自定义界面 CSS（注入到页面，覆盖默认主题变量/规则） */
  customCss: string
}

/** AI 提供方协议类型 */
export type AiProvider = 'openai' | 'anthropic' | 'claude-code' | 'codex'

/** 学习助手的任务类型 */
export type AiTask =
  | 'chat'
  | 'summarize-page'
  | 'summarize-doc'
  | 'summarize-selection'
  | 'explain-selection'
  | 'translate-selection'
  | 'summarize-highlights'
  | 'suggest-highlights'
  | 'structured-notes'
  | 'organize-outline'
  | 'prepare-coach'
  | 'quiz'
  | 'flashcards'
  | 'mindmap'
  | 'vision-page'

/** 文档上下文策略 */
export type AiContextMode = 'auto' | 'full' | 'retrieval'

/** 助手回答语言 */
export type AiReplyLocale = 'auto' | 'zh-CN' | 'en'

/** 学习助手偏好（随 AiSettings 保存） */
export type AiStudySettings = {
  /** auto：能放下全文就用全文，否则检索；full：优先全文；retrieval：只检索相关段落 */
  contextMode: AiContextMode
  /** auto：跟随界面语言，并允许模型按提问语言回答 */
  replyLocale: AiReplyLocale
  /** 全文上下文的最大字符数（约 4 字符 ≈ 1 token） */
  maxContextChars: number
  /** 是否在本机保留对话记录 */
  keepHistory: boolean
  /** 是否把高亮 / 页批注加入上下文 */
  includeAnnotations: boolean
  /**
   * 自定义系统提示。空字符串表示使用内置默认 prompt；
   * 非空时整段替换默认正文，仍会追加回答语言规则。
   */
  customSystemPrompt: string
}

/** PDF 文本解析结果的一页 */
export type DocPageText = {
  pageIndex: number
  text: string
  /** pdf：内嵌文字层；ocr：OCR 覆盖层；empty：无文本（可能是扫描页） */
  source: 'pdf' | 'ocr' | 'empty'
}

/** 供检索的文本块 */
export type DocChunk = {
  id: string
  pageIndex: number
  text: string
}

/** 整本文档的文本索引 */
export type DocIndex = {
  signature: string
  pages: DocPageText[]
  chunks: DocChunk[]
  totalChars: number
  tokenEstimate: number
  scannedPages: number
}

/** 划词 AI 请求（用于从高亮菜单直接发起） */
export type AiSelectionContext = {
  text: string
  pageIndex: number
}

export type AiActionRequest = {
  id: number
  task: AiTask
  selection?: AiSelectionContext
}

/** 一条对话消息（持久化在本机） */
export type AiChatMessage = {
  id: string
  role: 'user' | 'assistant'
  /** 界面上显示的内容 */
  content: string
  /** 实际发给模型的内容（用户消息；任务指令等），缺省用 content */
  llmText?: string
  createdAt: number
  task?: AiTask
  provider?: AiProvider
  model?: string
  /** 推理模型返回的思考摘要（可选） */
  thinking?: string
  /** 回答参考到的页码（0 开始） */
  pagesUsed?: number[]
  /** 本次上下文模式 */
  contextMode?: 'full' | 'retrieval' | 'page' | 'selection' | 'none'
  /** 本次上下文 token 估算 */
  contextTokens?: number
  /** 上下文降级原因 */
  fallback?: 'too-large' | 'not-indexed' | 'scanned' | 'cli-limit' | 'no-text'
  /** 生成这条回答时所在页（0 开始） */
  pageIndex?: number
  /** 这条用户消息绑定的划词内容（用于重新生成） */
  selection?: AiSelectionContext
  /** 仅出错时存在 */
  error?: string
}

export type AiChatSession = {
  fileKey: string
  messages: AiChatMessage[]
  updatedAt: number
}

/** 单个 Provider 条目（各自独立保存凭证） */
export type AiProviderEntry = {
  id: string
  kind: AiProvider
  name: string
  /** 列表副标题（官方说明或默认 Base） */
  subtitle: string
  builtin: boolean
  apiBase: string
  apiKey: string
  model: string
  /** CLI 可执行名或绝对路径 */
  cliPath: string
  /** 额外 CLI 参数（空格分隔，不含 prompt） */
  cliArgs: string
}

/** AI 设置：多 Provider，同一时间仅一个活跃 */
export type AiSettings = {
  activeId: string
  providers: AiProviderEntry[]
  study: AiStudySettings
}

/** 解析后的扁平配置，供 HTTP / CLI 调用 */
export type ResolvedAiConfig = {
  provider: AiProvider
  apiBase: string
  apiKey: string
  model: string
  cliPath: string
  cliArgs: string
}

export type AiResult = {
  text: string
  provider: AiProvider
}
