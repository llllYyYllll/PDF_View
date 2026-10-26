# PDF View

轻量 Windows 桌面 PDF 阅读器（Tauri 2 + React + TypeScript + PDF.js）。

## 功能

1. **AI 学习助手**（`Ctrl+J`）：基于全文的问答、划词解释/翻译/总结、页面读图、全书摘要、自测题、知识卡片、思维导图、结构化笔记、目录整理、高亮汇总  
2. **OCR**：PP-OCRv6 像素级坐标；全书可写不可见文字层（PyMuPDF）并生成目录（结构法 + 目录页法）  
3. **高亮**：拖选文字即高亮（可附批注）  
4. **批注**：页批注 + 高亮批注  
5. **保存**：`Ctrl+S` /「保存」→ 同目录 `.pdfview.json` 工程文件  
6. **三向索引**：侧栏「高亮 · 批注 · 页码」互跳  

## AI 学习助手

### 工作方式

- 打开 PDF 后，在本地用 PDF.js 解析全文并建立轻量索引；不依赖云端 embedding，扫描页可回退到已有 OCR 文字层。
- 上下文策略（设置 → AI）：
  - **自动**：文档能放进预算就用全文，否则用本地 BM25 检索相关段落；
  - **优先全文**：尽量携带完整正文；
  - **只检索**：每次只带与问题最相关的段落，适合超长文档。
- 超长文档的全书任务会按页均匀采样，并在回答中明确说明；当前页、选中页在检索时会加权。
- 回答中的 `[p12]` 是可点击的页码引用，点击直接跳转；下方「参考页码」也可跳转。
- 对话按文件保存在本机 `localStorage`，可在设置中关闭历史记录；支持停止、重新生成、复制和整段导出。

### 支持的 Provider

| 通道 | 能力 |
|------|------|
| Anthropic Claude API | SSE 流式输出、adaptive thinking、prompt caching、图像理解；内置 `claude-opus-5-5` 等最新模型预设 |
| OpenAI 兼容 API | SSE 流式输出、图像理解、reasoning 内容展示；支持 OpenAI、DeepSeek、Gemini、OpenRouter、Ollama、Groq、xAI、Mistral、Moonshot、Azure 等 |
| Claude Code CLI | 默认 Provider；无需 API Key，长文档提示词通过 stdin 传入；默认禁用文件/命令工具，只做文本生成 |
| Codex CLI | 无需 API Key；`codex exec` 的提示词通过 stdin 传入；默认 read-only 沙箱，只做文本生成 |

在「设置 → AI」中可启用某个 Provider、填写 API Base / Key / 模型、测试连接、拉取模型列表，或添加自定义 OpenAI / Anthropic 兼容端点。API Key 只保存在本机，不会写入 `.pdfview.json`。

Windows 下会自动在 PATH、`%APPDATA%\npm` 和 `~\.local\bin` 中查找 `claude.exe` / `claude.cmd`（Codex 同理），npm 全局安装的 `.cmd` shim 可直接使用；若仍启动失败，请在 CLI 路径中填写可执行文件的绝对路径。

桌面端的 AI 请求经 Tauri 的 Rust 网络层发出，不受 WebView CORS 限制；仅在浏览器里运行 `npm run dev` 调试时，仍受各服务商的跨域策略约束。

若系统代理（Clash 等）失效或端口变化，Rust 通道第一次请求失败后会自动改用直连重试一次，并在本次会话中记住该域名；两条通道都失败时，设置页会显示两边的具体错误链（DNS / TCP / TLS / 代理），而不只是“网络请求失败”。

### 隐私

使用云端 Provider 时，当前问题、所选的文档上下文（在预算内可能包含全文）、高亮/批注和页面图像会发送到你选择的模型服务；本地索引、聊天记录和 API Key 不经过本项目的中转服务器。对隐私敏感的内容可使用 Ollama 或 Claude Code / Codex CLI。

## 开发

### 环境

- Node.js 18+
- Rust（rustup），推荐默认工具链：`stable-x86_64-pc-windows-msvc`
- **Visual Studio 2022 Build Tools**，工作负载勾选「使用 C++ 的桌面开发」（Tauri 在 Windows 上需要 MSVC 链接器；纯 MinGW 会因 DLL 导出过多而链接失败）
- （OCR）Python 3.9+、PaddlePaddle CPU、PaddleOCR 3.7

若刚安装完 Build Tools，请**重新打开终端**后再运行。

### 运行

```bash
npm install
# Windows 推荐（自动加载 MSVC 环境）：
npm run dev:win
# 或已在「x64 Native Tools」终端中时：
npm run tauri:dev
```

示例文件：`samples/sample.pdf`

仅调试前端（浏览器，无原生对话框时会回退到 `<input type=file>`）：

```bash
npm run dev
```

### OCR（PP-OCRv6）

```bash
python -m pip install paddlepaddle==3.2.1 -i https://www.paddlepaddle.org.cn/packages/stable/cpu/
pip install -r python-ocr/requirements.txt
```

工具栏选「离线 OCR」→「OCR本页 / OCR全书」。全书且有本地路径时，会生成带不可见文字层的 `*.ocr.pdf` 并自动打开。首次会从百度 BOS 拉取模型到 `~/.paddlex/`（已跳过 HuggingFace 连通性检查）。

「联网 OCR」需点「OCR设置」填写自定义 API；未配置时会提示，不会再静默空结果。详见 [`python-ocr/README.md`](python-ocr/README.md)。

## 技术栈

| 层 | 技术 |
|----|------|
| 壳 | Tauri 2 |
| UI | React + Vite + TypeScript |
| PDF | PDF.js |
| OCR | PP-OCRv6 + PP-StructureV3 + PyMuPDF |
