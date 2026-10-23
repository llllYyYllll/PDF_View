# PDF View

轻量 Windows 桌面 PDF 阅读器（Tauri 2 + React + TypeScript + PDF.js）。

## 功能（极简）

1. **OCR**：PP-OCRv6 像素级坐标；全书可写不可见文字层（PyMuPDF）并生成目录（结构法 + 目录页法）  
2. **高亮**：拖选文字即高亮（可附批注）  
3. **批注**：页批注 + 高亮批注  
4. **保存**：`Ctrl+S` /「保存」→ 同目录 `.pdfview.json` 工程文件  
5. **三向索引**：侧栏「高亮 · 批注 · 页码」互跳  

已移除：搜索、书签、复杂设置弹窗等。阅读器仍保留打开、翻页、缩放与按需渲染。

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
