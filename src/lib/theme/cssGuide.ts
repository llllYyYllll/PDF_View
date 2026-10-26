/** 自定义 CSS 说明文档、可调变量与示例片段 */

export type CssVarDoc = {
  name: string
  desc: string
  sample: string
  /** 是否适合用颜色选择器快速改 */
  color?: boolean
}

export type CssSelectorDoc = {
  selector: string
  desc: string
}

export type CssSnippet = {
  id: string
  title: string
  desc: string
  code: string
}

export const CSS_VAR_DOCS: CssVarDoc[] = [
  { name: '--bg', desc: '应用主背景', sample: '#1e1e1e', color: true },
  { name: '--bg-elev', desc: '侧栏 / 弹窗 / 卡片背景', sample: '#252526', color: true },
  { name: '--bg-soft', desc: '次级柔和背景', sample: '#2d2d2d', color: true },
  { name: '--bg-hover', desc: '悬停背景', sample: '#2a2d2e', color: true },
  { name: '--bg-active', desc: '选中 / 激活背景', sample: '#37373d', color: true },
  { name: '--bg-toolbar', desc: '顶栏背景', sample: '#323233', color: true },
  { name: '--border', desc: '主边框色', sample: '#3c3c3c', color: true },
  { name: '--border-subtle', desc: '弱边框色', sample: '#333333', color: true },
  { name: '--text', desc: '主文字色', sample: '#cccccc', color: true },
  { name: '--muted', desc: '次要文字色', sample: '#858585', color: true },
  { name: '--accent', desc: '强调色（按钮、焦点、高亮框）', sample: '#007acc', color: true },
  { name: '--accent-hover', desc: '强调色悬停', sample: '#1c8ad4', color: true },
  { name: '--accent-2', desc: '次强调色（成功 / 提示）', sample: '#89d185', color: true },
  { name: '--danger', desc: '危险 / 错误色', sample: '#f14c4c', color: true },
  { name: '--page-bg', desc: 'PDF 阅读区周围背景', sample: '#1e1e1e', color: true },
  { name: '--paper', desc: 'PDF 纸张背景', sample: '#ffffff', color: true },
  { name: '--input-bg', desc: '输入框背景', sample: '#3c3c3c', color: true },
  { name: '--placeholder-bg', desc: '页面加载占位背景', sample: '#2d2d2d', color: true },
  { name: '--info-fg', desc: '信息条文字色', sample: '#3794ff', color: true },
  { name: '--info-bg', desc: '信息条背景', sample: 'rgba(0,122,204,0.15)' },
  { name: '--error-fg', desc: '错误条文字色', sample: '#f48771', color: true },
  { name: '--error-bg', desc: '错误条背景', sample: 'rgba(241,76,76,0.15)' },
  { name: '--hl-focus', desc: '高亮命中焦点底色', sample: 'rgba(0,122,204,0.18)' },
  { name: '--search-hit', desc: '搜索命中底色', sample: 'rgba(255,214,10,0.55)' },
  { name: '--shadow', desc: '阴影', sample: '0 2px 8px rgba(0,0,0,0.36)' },
  { name: '--radius', desc: '圆角', sample: '2px' },
  { name: '--radius-lg', desc: '大圆角（设置卡片等）', sample: '10px' },
  { name: '--font-ui', desc: '界面字体', sample: "'Segoe UI', sans-serif" },
  { name: '--font-mono', desc: '等宽字体', sample: "'Cascadia Code', monospace" },
  { name: '--font-size', desc: '根字号', sample: '13px' },
  { name: '--sidebar-width', desc: '侧栏宽度（也可拖动侧栏右缘调整）', sample: '260px' },
  { name: '--ai-panel-width', desc: 'AI 面板宽度（也可拖动面板左缘调整）', sample: '420px' },
  { name: '--toolbar-min-height', desc: '顶栏最小高度', sample: '35px' },
  { name: '--toolbar-padding', desc: '顶栏内边距', sample: '4px 8px' },
  { name: '--scrollbar-size', desc: '滚动条粗细', sample: '10px' },
  { name: '--scrollbar-thumb', desc: '滚动条滑块色', sample: '#424242', color: true },
  { name: '--scrollbar-thumb-hover', desc: '滚动条悬停色', sample: '#4f4f4f', color: true },
  { name: '--modal-backdrop', desc: '弹窗遮罩', sample: 'rgba(0,0,0,0.45)' },
  { name: '--drop-overlay-bg', desc: '拖放遮罩', sample: 'rgba(0,122,204,0.12)' },
  { name: '--paper-outline', desc: '纸张描边', sample: '#00000055' },
  { name: '--dur-fast', desc: '快速动画时长（需开启平滑动画）', sample: '120ms' },
  { name: '--dur-ui', desc: '常规动画时长', sample: '180ms' },
  { name: '--dur-panel', desc: '面板动画时长', sample: '220ms' },
]

export const CSS_SELECTOR_DOCS: CssSelectorDoc[] = [
  { selector: '.app', desc: '整应用根容器' },
  { selector: '.toolbar', desc: '顶部工具栏' },
  { selector: '.toolbar-group', desc: '工具栏分组' },
  { selector: '.btn / .btn.primary / .btn.icon-btn', desc: '按钮样式' },
  { selector: '.sidebar', desc: '左侧栏' },
  { selector: '.sidebar.collapsed', desc: '收起的侧栏' },
  { selector: '.sidebar-tabs / .tab / .tab.active', desc: '侧栏标签' },
  { selector: '.sidebar-body', desc: '侧栏内容滚动区' },
  { selector: '.outline-page-title / .outline-children', desc: '目录项与子项' },
  { selector: '.content', desc: '右侧主内容区' },
  { selector: '.viewer', desc: 'PDF 滚动阅读区' },
  { selector: '.page-view / .page-stack', desc: '单页纸张容器' },
  { selector: '.hl-hit / .hl-frame', desc: '高亮命中与蓝框（色块已绘入 canvas）' },
  { selector: '.hl-note-popover', desc: '批注弹出框' },
  { selector: '.hl-color-menu', desc: '选色菜单' },
  { selector: '.banner.error / .banner.info', desc: '顶部提示条' },
  { selector: '.empty-state', desc: '未打开文件时的空状态' },
  { selector: '.modal-backdrop / .modal', desc: '通用弹窗' },
  { selector: '.obs-settings / .obs-settings-nav', desc: '设置窗口与左侧导航' },
  { selector: '.obs-setting-item / .obs-setting-group', desc: '设置行与分组卡片' },
  { selector: '.drop-overlay', desc: '拖入 PDF 遮罩' },
]

export const CSS_SNIPPETS: CssSnippet[] = [
  {
    id: 'accent-purple',
    title: '紫色强调',
    desc: '把强调色改成偏紫',
    code: `:root {
  --accent: #c586c0;
  --accent-hover: #d7a6d2;
  --info-fg: #c586c0;
  --info-bg: rgba(197, 134, 192, 0.15);
  --hl-focus: rgba(197, 134, 192, 0.2);
}
`,
  },
  {
    id: 'accent-green',
    title: '绿色强调',
    desc: '强调色改成绿色',
    code: `:root {
  --accent: #3fa66b;
  --accent-hover: #4fc07e;
  --info-fg: #4fc07e;
  --info-bg: rgba(63, 166, 107, 0.15);
}
`,
  },
  {
    id: 'wider-sidebar',
    title: '加宽侧栏',
    desc: '侧栏改为 320px',
    code: `:root {
  --sidebar-width: 320px;
}
`,
  },
  {
    id: 'rounder-ui',
    title: '更大圆角',
    desc: '整体更圆润',
    code: `:root {
  --radius: 6px;
  --radius-lg: 14px;
}
.btn,
.obs-dropdown,
.obs-btn,
.obs-text-input {
  border-radius: var(--radius);
}
`,
  },
  {
    id: 'larger-font',
    title: '更大字号',
    desc: '界面文字放大',
    code: `:root {
  --font-size: 14px;
}
.obs-setting-name {
  font-size: 15px;
}
`,
  },
  {
    id: 'compact-toolbar',
    title: '紧凑顶栏',
    desc: '降低顶栏高度',
    code: `:root {
  --toolbar-min-height: 28px;
  --toolbar-padding: 2px 6px;
}
`,
  },
  {
    id: 'sepia-paper',
    title: '护眼纸张',
    desc: '阅读区偏暖、纸张米白',
    code: `:root {
  --page-bg: #2a2620;
  --paper: #f4ecd8;
  --paper-outline: #00000033;
}
`,
  },
  {
    id: 'hide-page-label',
    title: '隐藏页标签',
    desc: '不显示页面上方页码标签',
    code: `.page-label {
  display: none;
}
`,
  },
  {
    id: 'toolbar-border',
    title: '顶栏强调底边',
    desc: '用强调色给顶栏加底边',
    code: `.toolbar {
  border-bottom: 2px solid var(--accent);
}
`,
  },
  {
    id: 'dense-outline',
    title: '更密目录',
    desc: '压缩目录行距',
    code: `.outline-page-title {
  padding: 1px 4px;
  font-size: 12px;
}
.outline-children {
  padding-left: 14px;
}
`,
  },
]

export const CSS_DOC_INTRO = `自定义 CSS 会注入到页面末尾，可覆盖主题变量与任意选择器，即时生效并自动保存。

写法提示：
1. 优先改 :root { --变量 }，一次改多处联动。
2. 也可直接写 .toolbar / .sidebar 等选择器做精细调整。
3. 深/浅色可分别写：[data-theme="dark"] { ... } 与 [data-theme="light"] { ... }。
4. 开启「平滑动画」后，--dur-fast / --dur-ui / --dur-panel 才会明显生效。
5. 快速调色区会维护 /* === pdfview:vars === */ 标记块，请勿删标记行。`

const VARS_START = '/* === pdfview:vars === */'
const VARS_END = '/* === /pdfview:vars === */'

export function readManagedVars(css: string): Record<string, string> {
  const start = css.indexOf(VARS_START)
  const end = css.indexOf(VARS_END)
  if (start < 0 || end < 0 || end <= start) return {}
  const block = css.slice(start, end)
  const out: Record<string, string> = {}
  const re = /(--[\w-]+)\s*:\s*([^;]+);/g
  let m: RegExpExecArray | null
  while ((m = re.exec(block))) {
    out[m[1]] = m[2].trim()
  }
  return out
}

export function writeManagedVar(css: string, name: string, value: string): string {
  const current = readManagedVars(css)
  current[name] = value
  const body = Object.entries(current)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `  ${k}: ${v};`)
    .join('\n')
  const managed = `${VARS_START}\n:root {\n${body}\n}\n${VARS_END}`

  const start = css.indexOf(VARS_START)
  const end = css.indexOf(VARS_END)
  if (start >= 0 && end > start) {
    return `${css.slice(0, start).trimEnd()}\n\n${managed}\n${css.slice(end + VARS_END.length).trimStart()}`.trim()
  }
  const trimmed = css.trim()
  return trimmed ? `${managed}\n\n${trimmed}` : managed
}

export function clearManagedVars(css: string): string {
  const start = css.indexOf(VARS_START)
  const end = css.indexOf(VARS_END)
  if (start < 0 || end < 0 || end <= start) return css
  return `${css.slice(0, start)}${css.slice(end + VARS_END.length)}`.replace(/\n{3,}/g, '\n\n').trim()
}

export function appendSnippet(css: string, snippet: string): string {
  const trimmed = css.trimEnd()
  const code = snippet.trim()
  if (!trimmed) return code + '\n'
  if (trimmed.includes(code)) return css
  return `${trimmed}\n\n${code}\n`
}
