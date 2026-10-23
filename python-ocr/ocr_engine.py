#!/usr/bin/env python3
"""
PDF View OCR 侧车

主路径（推荐）：
  PP-OCRv6（像素级 bbox）+ PP-StructureV3 标题层级（可选）
  + PyMuPDF render_mode=3 写入不可见文字层

刻意不用：Tesseract / VLM（PaddleOCR-VL、MinerU）—— 坐标不可靠或不适合文字层对齐。
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

# 跳过 PaddleX 模型源连通性检查；国内优先走 BOS，避免 HuggingFace 超时
os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
os.environ.setdefault("PADDLE_PDX_MODEL_SOURCE", "bos")

# 懒加载单例，避免每次请求重新下模型
_OCR = None
_OCR_TIER: str | None = None
_STRUCTURE = None

_ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")

# 可本地缓存检测的档位（medium 走 PaddleOCR 默认名，不在此表）
_TIER_MODELS: dict[str, tuple[str, str]] = {
    "tiny": ("PP-OCRv6_tiny_det", "PP-OCRv6_tiny_rec"),
    "small": ("PP-OCRv6_small_det", "PP-OCRv6_small_rec"),
}


class _StdoutToStderr:
    """Paddle 推理会往 stdout 打日志，需隔离以免破坏 JSON 协议。

    仅替换 ``sys.stdout`` 拦不住 C++ 层直接写 fd 1 的日志（如 oneDNN 的
    ``ReduceMeanCheckIfOneDNNSupport``），因此同时做 fd 级重定向。
    """

    def __enter__(self):
        self._old = sys.stdout
        try:
            sys.stdout.flush()
            sys.stderr.flush()
        except Exception:  # noqa: BLE001
            pass
        sys.stdout = sys.stderr
        self._saved_fd: int | None = None
        try:
            self._saved_fd = os.dup(1)
            os.dup2(2, 1)
        except OSError:
            self._saved_fd = None
        return self

    def __exit__(self, *args):
        try:
            sys.stdout.flush()
            sys.stderr.flush()
            if self._saved_fd is not None:
                os.dup2(self._saved_fd, 1)
                os.close(self._saved_fd)
        except OSError:
            pass
        finally:
            sys.stdout = self._old


def _strip_ansi(text: str) -> str:
    return _ANSI_RE.sub("", text)


def _models_root() -> Path:
    return Path.home() / ".paddlex" / "official_models"


def _model_ready(name: str) -> bool:
    d = _models_root() / name
    return (d / "inference.pdiparams").is_file() or (d / "inference.yml").is_file()


def _resolve_tier(requested: str) -> str:
    """优先用请求档位；若本地无模型则回退到已缓存档位，避免无网时硬失败。"""
    req = (requested or "small").lower()
    if req == "medium":
        return "medium"
    if req not in _TIER_MODELS:
        req = "small"
    det, rec = _TIER_MODELS[req]
    if _model_ready(det) and _model_ready(rec):
        return req
    for fallback in ("small", "tiny"):
        if fallback == req:
            continue
        d, r = _TIER_MODELS[fallback]
        if _model_ready(d) and _model_ready(r):
            return fallback
    return req


def _tier_kwargs(tier: str) -> dict[str, Any]:
    kwargs: dict[str, Any] = {
        "use_doc_orientation_classify": False,
        "use_doc_unwarping": False,
        "use_textline_orientation": False,
    }
    if tier == "medium":
        # 不指定 name 时走 PaddleOCR 默认
        return kwargs
    det, rec = _TIER_MODELS[tier]
    kwargs["text_detection_model_name"] = det
    kwargs["text_recognition_model_name"] = rec
    if _model_ready(det):
        kwargs["text_detection_model_dir"] = str(_models_root() / det)
    if _model_ready(rec):
        kwargs["text_recognition_model_dir"] = str(_models_root() / rec)
    return kwargs


def decode_image(image_base64: str):
    from PIL import Image
    import numpy as np

    raw = base64.b64decode(image_base64)
    img = Image.open(io.BytesIO(raw)).convert("RGB")
    return np.asarray(img)


def get_ocr(tier: str = "small"):
    """PP-OCRv6：tiny / small / medium。有本地缓存则直读，否则经 BOS 下载。"""
    global _OCR, _OCR_TIER
    resolved = _resolve_tier(tier)
    if _OCR is not None and _OCR_TIER == resolved:
        return _OCR
    try:
        from paddleocr import PaddleOCR
    except ImportError as exc:
        raise RuntimeError(
            "未安装 PaddleOCR。请执行：\n"
            "  python -m pip install paddlepaddle==3.2.1 -i https://www.paddlepaddle.org.cn/packages/stable/cpu/\n"
            "  pip install -r python-ocr/requirements.txt"
        ) from exc

    kwargs = _tier_kwargs(resolved)
    try:
        with _StdoutToStderr():
            _OCR = PaddleOCR(**kwargs)
            _OCR_TIER = resolved
    except Exception as exc:  # noqa: BLE001
        msg = _strip_ansi(str(exc))
        local = _models_root()
        raise RuntimeError(
            f"无法加载 PP-OCRv6（档位 {resolved}）。\n"
            f"原因: {msg}\n"
            f"本地模型目录: {local}\n"
            "处理建议：\n"
            "1) 有网时再试一次（会从百度 BOS 下载模型）；\n"
            "2) 或先用已缓存的 tiny/small 模型；\n"
            "3) 确认已设置 PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True。"
        ) from exc
    return _OCR


def get_structure():
    global _STRUCTURE
    if _STRUCTURE is not None:
        return _STRUCTURE
    try:
        from paddleocr import PPStructureV3
    except ImportError:
        return None
    try:
        _STRUCTURE = PPStructureV3(
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
        )
    except Exception:  # noqa: BLE001
        _STRUCTURE = False  # 标记不可用
    return _STRUCTURE if _STRUCTURE else None


def _as_mapping(res: Any) -> dict[str, Any]:
    if isinstance(res, dict):
        return res
    for attr in ("json", "res", "data"):
        val = getattr(res, attr, None)
        if callable(val):
            try:
                val = val()
            except Exception:  # noqa: BLE001
                val = None
        if isinstance(val, dict):
            return val
    # PaddleX result objects often support __getitem__
    out: dict[str, Any] = {}
    for key in ("rec_texts", "rec_scores", "rec_boxes", "rec_polys", "dt_polys"):
        try:
            out[key] = res[key]
        except Exception:  # noqa: BLE001
            pass
    return out


def parse_ocr_result(result: Any) -> tuple[str, list[dict[str, Any]]]:
    """从 PaddleOCR.predict 结果提取 text + 行级 bbox（像素坐标）。"""
    words: list[dict[str, Any]] = []
    texts: list[str] = []

    pages = result if isinstance(result, list) else [result]
    for page in pages:
        data = _as_mapping(page)
        rec_texts = data.get("rec_texts") or []
        rec_scores = data.get("rec_scores") or [1.0] * len(rec_texts)
        boxes = data.get("rec_boxes")
        if boxes is None:
            boxes = data.get("dt_polys") or data.get("rec_polys") or []

        for i, text in enumerate(rec_texts):
            text = (text or "").strip()
            if not text:
                continue
            score = float(rec_scores[i]) if i < len(rec_scores) else 1.0
            if score < 0.3:
                continue
            box = boxes[i] if i < len(boxes) else None
            x0, y0, x1, y1 = _box_to_xyxy(box)
            words.append(
                {
                    "text": text,
                    "x0": x0,
                    "y0": y0,
                    "x1": x1,
                    "y1": y1,
                    "score": score,
                }
            )
            texts.append(text)

    return "\n".join(texts), words


def _box_to_xyxy(box: Any) -> tuple[float, float, float, float]:
    if box is None:
        return 0.0, 0.0, 0.0, 0.0
    # numpy / list
    try:
        import numpy as np

        arr = np.asarray(box, dtype=float)
        if arr.ndim == 1 and arr.size >= 4:
            return float(arr[0]), float(arr[1]), float(arr[2]), float(arr[3])
        if arr.ndim == 2 and arr.shape[0] >= 4:
            xs, ys = arr[:, 0], arr[:, 1]
            return float(xs.min()), float(ys.min()), float(xs.max()), float(ys.max())
    except Exception:  # noqa: BLE001
        pass
    if isinstance(box, (list, tuple)) and len(box) >= 4 and not isinstance(box[0], (list, tuple)):
        return float(box[0]), float(box[1]), float(box[2]), float(box[3])
    return 0.0, 0.0, 0.0, 0.0


def offline_ocr_image(image_base64: str, tier: str = "small") -> dict[str, Any]:
    ocr = get_ocr(tier)
    image = decode_image(image_base64)
    with _StdoutToStderr():
        result = ocr.predict(image)
    text, words = parse_ocr_result(result)
    return {"text": text, "words": words, "mode": "offline", "engine": "PP-OCRv6"}


def extract_titles_structure(image) -> list[dict[str, Any]]:
    """PP-StructureV3：抽取标题块（含层级启发式）。"""
    structure = get_structure()
    if not structure:
        return []
    try:
        with _StdoutToStderr():
            result = structure.predict(image)
    except Exception:  # noqa: BLE001
        return []

    titles: list[dict[str, Any]] = []
    pages = result if isinstance(result, list) else [result]
    for page in pages:
        data = _as_mapping(page)
        # 常见字段：parsing_res_list / layout_det_res / blocks
        blocks = (
            data.get("parsing_res_list")
            or data.get("layout_det_res")
            or data.get("boxes")
            or []
        )
        if isinstance(blocks, dict):
            blocks = blocks.get("boxes") or blocks.get("data") or []
        for b in blocks:
            if not isinstance(b, dict):
                continue
            label = str(b.get("label") or b.get("type") or b.get("block_label") or "").lower()
            if "title" not in label and "header" not in label and label not in {"doc_title", "paragraph_title", "section_header"}:
                continue
            content = (b.get("content") or b.get("text") or b.get("res") or "").strip()
            if isinstance(content, list):
                content = " ".join(str(x) for x in content)
            if not content:
                continue
            bbox = b.get("block_bbox") or b.get("bbox") or b.get("coordinate")
            x0, y0, x1, y1 = _box_to_xyxy(bbox)
            level = 1
            if "doc_title" in label:
                level = 1
            elif "paragraph_title" in label or "section" in label:
                level = 2
            titles.append(
                {
                    "title": str(content)[:80],
                    "level": level,
                    "x0": x0,
                    "y0": y0,
                    "x1": x1,
                    "y1": y1,
                }
            )
    return titles


TOC_LINE_RE = re.compile(
    r"^(?P<title>.+?)[\s\u3000·•\.．…]{2,}(?P<page>\d{1,4})\s*$"
)
HEADING_RE = re.compile(
    r"^(第[一二三四五六七八九十百千0-9]+[章节篇部]|[0-9]+(\.[0-9]+)*\s+\S+|Chapter\s+\d+)",
    re.I,
)


def build_outline_from_titles(
    page_titles: list[tuple[int, list[dict[str, Any]]]],
) -> list[dict[str, Any]]:
    """结构法：标题块 → outline。"""
    items: list[dict[str, Any]] = []
    for page_index, titles in page_titles:
        for t in titles:
            items.append(
                {
                    "title": t["title"],
                    "pageIndex": page_index,
                    "items": [],
                    "level": t.get("level", 1),
                }
            )
    return _nest_outline(items)


def _toc_parse(text: str, page_index: int, page_offset: int) -> list[dict[str, Any]]:
    """目录页法：解析「标题……页码」。"""
    items: list[dict[str, Any]] = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        m = TOC_LINE_RE.match(line)
        if not m:
            continue
        title = m.group("title").strip(" .-_·•")
        page = int(m.group("page")) + page_offset - 1
        if page < 0:
            page = 0
        items.append({"title": title[:80], "pageIndex": page, "items": [], "level": 1})
    return items


def build_outline_heuristic(page_words: list[tuple[int, list[dict[str, Any]]]]) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for page_index, words in page_words:
        if not words:
            continue
        heights = [max(1.0, w["y1"] - w["y0"]) for w in words]
        avg = sum(heights) / len(heights)
        for w in words:
            t = w["text"].strip()
            h = w["y1"] - w["y0"]
            if len(t) < 2 or len(t) > 48:
                continue
            if h < avg * 1.2 and not HEADING_RE.match(t):
                continue
            items.append({"title": t, "pageIndex": page_index, "items": [], "level": 1})
    return items


def _nest_outline(flat: list[dict[str, Any]]) -> list[dict[str, Any]]:
    # 简化：保持扁平，前端树可直接用
    return [
        {"title": x["title"], "pageIndex": x["pageIndex"], "items": []}
        for x in flat
    ]


def merge_outlines(*lists: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for lst in lists:
        for item in lst:
            key = f"{item.get('pageIndex')}|{item.get('title')}"
            if key in seen:
                continue
            seen.add(key)
            out.append(
                {
                    "title": item["title"],
                    "pageIndex": item["pageIndex"],
                    "items": item.get("items") or [],
                }
            )
    out.sort(key=lambda x: (x["pageIndex"] is None, x["pageIndex"] or 0))
    return out


def write_invisible_text_layer(
    pdf_path: str,
    page_index: int,
    words: list[dict[str, Any]],
    image_size: tuple[int, int],
    doc: Any | None = None,
) -> Any:
    """
    用 PyMuPDF 在扫描页写入不可见文字（render_mode=3）。
    words 坐标为「渲染图像像素」；按 page.rect 映射到 PDF 点。
    注意：PyMuPDF 为 AGPL-3.0。
    """
    import pymupdf as fitz

    close = False
    if doc is None:
        doc = fitz.open(pdf_path)
        close = True

    page = doc[page_index]
    pw, ph = float(page.rect.width), float(page.rect.height)
    iw, ih = float(image_size[0]), float(image_size[1])
    sx, sy = pw / max(iw, 1.0), ph / max(ih, 1.0)

    for w in words:
        text = (w.get("text") or "").strip()
        if not text:
            continue
        x0, y0, x1, y1 = w["x0"] * sx, w["y0"] * sy, w["x1"] * sx, w["y1"] * sy
        rect = fitz.Rect(x0, y0, max(x0 + 1, x1), max(y0 + 1, y1))
        fontsize = max(6.0, abs(y1 - y0) * 0.9)
        try:
            page.insert_text(
                (rect.x0, rect.y1 - 1),
                text,
                fontsize=fontsize,
                render_mode=3,  # invisible
            )
        except Exception:  # noqa: BLE001
            try:
                page.insert_textbox(rect, text, fontsize=fontsize, render_mode=3)
            except Exception:  # noqa: BLE001
                continue

    if close:
        return doc
    return doc


def apply_outline_to_pdf(doc: Any, outline: list[dict[str, Any]]) -> None:
    toc = []
    for item in outline:
        page = item.get("pageIndex")
        if page is None:
            continue
        toc.append([1, item["title"], int(page) + 1])
    if toc:
        doc.set_toc(toc)


def ocr_pdf_document(request: dict[str, Any]) -> dict[str, Any]:
    """
    对整个 PDF：逐页 PP-OCR → 写不可见文字层 → 合并结构/目录页书签。
    """
    import pymupdf as fitz

    pdf_path = request.get("pdfPath") or request.get("pdf_path")
    if not pdf_path:
        raise RuntimeError("缺少 pdfPath")
    out_path = request.get("outputPath") or request.get("output_path")
    if not out_path:
        p = Path(pdf_path)
        out_path = str(p.with_name(p.stem + ".ocr.pdf"))

    tier = request.get("tier") or "small"
    dpi = int(request.get("dpi") or 144)
    write_layer = bool(request.get("writeTextLayer", True))
    page_offset = int(request.get("pageOffset") or 0)

    ocr = get_ocr(tier)
    doc = fitz.open(pdf_path)
    zoom = dpi / 72.0
    mat = fitz.Matrix(zoom, zoom)

    all_page_words: list[tuple[int, list[dict[str, Any]]]] = []
    structure_titles: list[tuple[int, list[dict[str, Any]]]] = []
    toc_outlines: list[dict[str, Any]] = []
    page_overlays: list[dict[str, Any]] = []

    for i in range(len(doc)):
        page = doc[i]
        pix = page.get_pixmap(matrix=mat, alpha=False)
        img_bytes = pix.tobytes("png")
        import numpy as np
        from PIL import Image

        image = np.asarray(Image.open(io.BytesIO(img_bytes)).convert("RGB"))
        with _StdoutToStderr():
            result = ocr.predict(image)
        text, words = parse_ocr_result(result)
        # 像素 → PDF 点（前端 overlay 也可用 PDF 点；此处存 PDF 点方便文字层）
        scale = 72.0 / dpi
        pdf_words = [
            {
                **w,
                "x0": w["x0"] * scale,
                "y0": w["y0"] * scale,
                "x1": w["x1"] * scale,
                "y1": w["y1"] * scale,
            }
            for w in words
        ]
        all_page_words.append((i, words))
        page_overlays.append(
            {
                "pageIndex": i,
                "text": text,
                "words": pdf_words,
                "mode": "offline",
                "engine": "PP-OCRv6",
            }
        )

        titles = extract_titles_structure(image)
        if titles:
            structure_titles.append((i, titles))

        # 目录页启发：标题含「目录」或大量 TOC 行
        if "目录" in text[:80] or len(_toc_parse(text, i, page_offset)) >= 3:
            toc_outlines.extend(_toc_parse(text, i, page_offset))

        if write_layer and words:
            write_invisible_text_layer(
                pdf_path,
                i,
                words,
                (pix.width, pix.height),
                doc=doc,
            )

    outline = merge_outlines(
        build_outline_from_titles(structure_titles),
        toc_outlines,
        build_outline_heuristic(all_page_words),
    )
    if outline:
        apply_outline_to_pdf(doc, outline)

    doc.save(out_path, garbage=4, deflate=True)
    doc.close()

    return {
        "mode": "offline",
        "engine": "PP-OCRv6",
        "outputPath": out_path,
        "outline": outline,
        "pages": page_overlays,
        "text": "\n\n".join(p["text"] for p in page_overlays),
        "words": page_overlays[0]["words"] if page_overlays else [],
    }


def online_ocr(image_base64: str, api_url: str | None, api_key: str | None) -> dict[str, Any]:
    url = (api_url or "").strip()
    if not url:
        raise RuntimeError(
            "联网 OCR 未配置 API 地址。请在「OCR 设置」中填写 apiUrl（POST JSON：{imageBase64}，返回 {text, words}）。"
        )
    payload = json.dumps({"imageBase64": image_base64}).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    req = urllib.request.Request(url, data=payload, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.URLError as exc:
        raise RuntimeError(f"联网 OCR 请求失败: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"联网 OCR 返回非 JSON: {exc}") from exc
    words = body.get("words") or []
    text = body.get("text") or " ".join(w.get("text", "") for w in words)
    if not text and not words:
        raise RuntimeError("联网 OCR 返回为空，请检查服务端响应是否包含 text 或 words。")
    return {"text": text, "words": words, "mode": "online"}


def handle(request: dict[str, Any]) -> dict[str, Any]:
    action = (request.get("action") or "").lower()
    mode = (request.get("mode") or "offline").lower()
    tier = request.get("tier") or "small"

    if action in {"ocr_pdf", "pdf"} or request.get("pdfPath") or request.get("pdf_path"):
        return ocr_pdf_document(request)

    image_base64 = request.get("imageBase64") or request.get("image_base64")
    if not image_base64:
        raise RuntimeError("缺少 imageBase64 或 pdfPath")

    if mode == "online":
        return online_ocr(
            image_base64,
            request.get("apiUrl") or request.get("api_url"),
            request.get("apiKey") or request.get("api_key"),
        )

    result = offline_ocr_image(image_base64, tier=tier)
    # 单页也可附带结构标题，供前端生成目录
    try:
        titles = extract_titles_structure(decode_image(image_base64))
        if titles:
            result["titles"] = titles
    except Exception:  # noqa: BLE001
        pass
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--stdin-json", action="store_true")
    parser.add_argument("--file", type=str, default="")
    args = parser.parse_args()

    try:
        if args.file:
            with open(args.file, "r", encoding="utf-8") as f:
                request = json.load(f)
        else:
            request = json.load(sys.stdin)

        result = handle(request)
        sys.stdout.write(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(_strip_ansi(str(exc)))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
