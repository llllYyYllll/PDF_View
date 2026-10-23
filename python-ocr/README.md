# PDF View OCR 侧车（PP-OCRv6）

按「像素级坐标 → 不可见文字层 → 目录」路线实现，**不用 Tesseract / VLM**。

| 环节 | 技术 |
|------|------|
| 文字识别 | PaddleOCR 3.7 · PP-OCRv6（tiny/small/medium） |
| 版面/标题 | PP-StructureV3（可选）+ 目录页正则 + 启发式 |
| 文字层 | PyMuPDF `insert_text(..., render_mode=3)` |

> PyMuPDF 为 **AGPL-3.0**。若闭源商用，请改用 `ocrmypdf` + `ocrmypdf-paddleocr-plus`。

## 安装

```bash
python -m pip install paddlepaddle==3.2.1 -i https://www.paddlepaddle.org.cn/packages/stable/cpu/
pip install -r requirements.txt
```

首次离线 OCR 会自动从百度 BOS 下载 PP-OCRv6 模型到 `~/.paddlex/official_models/`。
侧车已默认设置：

- `PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True`（跳过 HuggingFace 等连通性检查）
- `PADDLE_PDX_MODEL_SOURCE=bos`（国内镜像）

若本机已有 `tiny` / `small` 缓存，会优先直读本地目录；请求 `small` 但未下载时，会回退到已缓存的 `tiny`。

联网 OCR 需在应用「OCR 设置」中填写 `apiUrl`（可选 `apiKey`），协议见下。

## 协议

- 单页离线：`{"mode":"offline","imageBase64":"...","tier":"small"}`
- 单页联网：`{"mode":"online","imageBase64":"...","apiUrl":"https://...","apiKey":"..."}`
- 全书：`{"action":"ocr_pdf","pdfPath":"D:/a.pdf","tier":"small","writeTextLayer":true}`

联网接口约定：`POST { "imageBase64": "..." }` → `{ "text": "...", "words": [{ "text","x0","y0","x1","y1" }] }`。

输出含 `words[].x0/y0/x1/y1`（像素或 PDF 点）与 `outline`。
