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


def _clear_stale_proxies() -> None:
    """清除失效本地代理（如 Clash 7897 已关但仍残留）。

    Windows 还会从注册表读系统代理；仅清环境变量不够，需屏蔽 urllib/requests 的代理发现。
    """
    for key in (
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "SOCKS_PROXY",
        "socks_proxy",
        "SOCKS5_PROXY",
        "socks5_proxy",
    ):
        os.environ.pop(key, None)
    os.environ["NO_PROXY"] = "*"
    os.environ["no_proxy"] = "*"
    # 阻止 urllib 读取环境/注册表代理（requests 也走这里）
    try:
        urllib.request.getproxies = lambda: {}  # type: ignore[assignment]
        if hasattr(urllib.request, "getproxies_environment"):
            urllib.request.getproxies_environment = lambda: {}  # type: ignore[attr-defined]
        if hasattr(urllib.request, "getproxies_registry"):
            urllib.request.getproxies_registry = lambda: {}  # type: ignore[attr-defined]
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        urllib.request.install_opener(opener)
    except Exception:  # noqa: BLE001
        pass


_clear_stale_proxies()

def emit_progress(done: int, total: int, stage: str = "") -> None:
    """写到 stderr，供 Rust 侧解析并转发给前端进度条。"""
    payload = json.dumps(
        {"done": int(done), "total": int(total), "stage": stage or ""},
        ensure_ascii=False,
    )
    sys.stderr.write(f"__OCR_PROGRESS__{payload}\n")
    sys.stderr.flush()


# 懒加载单例，避免每次请求重新下模型
_OCR = None
_OCR_TIER: str | None = None
_OCR_DEVICE: str | None = None
_STRUCTURE = None
_STRUCTURE_DEVICE: str | None = None
# 进程内缓存：首次探测后复用
_DETECTED_DEVICE: str | None = None
_DETECTED_GPU: bool | None = None

_ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")

# 各档位检测/识别模型名（用于本地缓存检测与显式加载）
_TIER_MODELS: dict[str, tuple[str, str]] = {
    "tiny": ("PP-OCRv6_tiny_det", "PP-OCRv6_tiny_rec"),
    "small": ("PP-OCRv6_small_det", "PP-OCRv6_small_rec"),
    "medium": ("PP-OCRv6_medium_det", "PP-OCRv6_medium_rec"),
}


def detect_inference_device() -> tuple[str, bool]:
    """探测本机是否可用 GPU；有则返回 (gpu:0, True)，否则 (cpu, False)。"""
    global _DETECTED_DEVICE, _DETECTED_GPU
    if _DETECTED_DEVICE is not None and _DETECTED_GPU is not None:
        return _DETECTED_DEVICE, _DETECTED_GPU

    device = "cpu"
    gpu = False
    try:
        import paddle

        compiled = False
        try:
            compiled = bool(paddle.device.is_compiled_with_cuda())
        except Exception:  # noqa: BLE001
            compiled = False
        count = 0
        if compiled:
            try:
                count = int(paddle.device.cuda.device_count())
            except Exception:  # noqa: BLE001
                count = 0
        if compiled and count > 0:
            device = "gpu:0"
            gpu = True
    except Exception:  # noqa: BLE001
        pass

    _DETECTED_DEVICE = device
    _DETECTED_GPU = gpu
    return device, gpu


def get_inference_device() -> str:
    return detect_inference_device()[0]


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
    """规范化档位名。本地无模型时仍返回请求档，由 get_ocr 先尝试下载，失败再回退。"""
    req = (requested or "small").lower()
    if req not in _TIER_MODELS:
        return "small"
    return req

def _cached_fallback_tier(preferred: str) -> str | None:
    """在 preferred 不可用时，返回本机已缓存的 small/tiny。"""
    for fallback in ("small", "tiny"):
        if fallback == preferred:
            continue
        d, r = _TIER_MODELS[fallback]
        if _model_ready(d) and _model_ready(r):
            return fallback
    return None


def _bos_reachable(timeout: float = 4.0) -> bool:
    """快速探测百度 BOS 是否可达（代理失效时会马上失败）。"""
    url = "https://paddle-model-ecology.bj.bcebos.com/"
    try:
        req = urllib.request.Request(url, method="HEAD")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return 200 <= getattr(resp, "status", 200) < 500
    except Exception:  # noqa: BLE001
        try:
            req = urllib.request.Request(url, method="GET")
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return 200 <= getattr(resp, "status", 200) < 500
        except Exception:  # noqa: BLE001
            return False


def _tier_kwargs(tier: str) -> dict[str, Any]:
    device = get_inference_device()
    kwargs: dict[str, Any] = {
        "use_doc_orientation_classify": False,
        "use_doc_unwarping": False,
        "use_textline_orientation": False,
        "device": device,
    }
    # GPU 上适当加大识别 batch，CPU 保持 1 更稳
    if device.startswith("gpu"):
        kwargs["text_recognition_batch_size"] = 8
    names = _TIER_MODELS.get(tier)
    if not names:
        return kwargs
    det, rec = names
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
    """PP-OCRv6：tiny / small / medium。有本地缓存则直读，否则经 BOS 下载。自动选 GPU/CPU。"""
    global _OCR, _OCR_TIER, _OCR_DEVICE, _DETECTED_DEVICE, _DETECTED_GPU
    resolved = _resolve_tier(tier)
    det, rec = _TIER_MODELS[resolved]
    if not (_model_ready(det) and _model_ready(rec)):
        cached = _cached_fallback_tier(resolved)
        # 网络不通时不要进入 Paddle 多源重试（可卡数分钟）；有缓存则立刻回退
        if cached and not _bos_reachable():
            sys.stderr.write(
                f"[ocr] 本地无 {resolved} 且无法连接模型源，改用已缓存 {cached}\n"
            )
            resolved = cached
        elif not cached:
            sys.stderr.write(
                f"[ocr] 本地无 {resolved}，将尝试从 BOS 下载…\n"
            )

    device = get_inference_device()
    if _OCR is not None and _OCR_TIER == resolved and _OCR_DEVICE == device:
        return _OCR
    try:
        from paddleocr import PaddleOCR
    except ImportError as exc:
        raise RuntimeError(
            "未安装 PaddleOCR。请执行：\n"
            "  python -m pip install paddlepaddle==3.2.1 -i https://www.paddlepaddle.org.cn/packages/stable/cpu/\n"
            "  # 若有 NVIDIA GPU，请改为安装对应 CUDA 版 paddlepaddle\n"
            "  pip install -r python-ocr/requirements.txt"
        ) from exc

    def _try_create(tier_name: str, device_name: str) -> Any:
        kw = _tier_kwargs(tier_name)
        kw["device"] = device_name
        if not device_name.startswith("gpu"):
            kw.pop("text_recognition_batch_size", None)
        with _StdoutToStderr():
            return PaddleOCR(**kw)

    try:
        _OCR = _try_create(resolved, device)
        _OCR_TIER = resolved
        _OCR_DEVICE = device
    except Exception as exc:  # noqa: BLE001
        msg = _strip_ansi(str(exc))
        # GPU 初始化失败 → CPU
        if device.startswith("gpu"):
            try:
                _OCR = _try_create(resolved, "cpu")
                _OCR_TIER = resolved
                _OCR_DEVICE = "cpu"
                _DETECTED_DEVICE = "cpu"
                _DETECTED_GPU = False
                return _OCR
            except Exception as cpu_exc:  # noqa: BLE001
                msg = _strip_ansi(str(cpu_exc))

        # 下载失败 / 模型缺失 → 回退已缓存档位（你本机已有 small/tiny）
        fallback = _cached_fallback_tier(resolved)
        if fallback:
            try:
                sys.stderr.write(
                    f"[ocr] 加载 {resolved} 失败，回退到本地 {fallback}\n"
                )
                use_dev = "cpu" if device.startswith("gpu") else device
                _OCR = _try_create(fallback, use_dev)
                _OCR_TIER = fallback
                _OCR_DEVICE = use_dev
                return _OCR
            except Exception:  # noqa: BLE001
                pass

        local = _models_root()
        proxy_hint = ""
        if "ProxyError" in msg or "7897" in msg or "proxy" in msg.lower():
            proxy_hint = (
                "\n5) 检测到代理连接失败（如 localhost:7897）。"
                "请关闭失效代理，或清除系统/终端里的 HTTP(S)_PROXY 后再试。"
            )
        raise RuntimeError(
            f"无法加载 PP-OCRv6（档位 {resolved}，设备 {device}）。\n"
            f"原因: {msg}\n"
            f"本地模型目录: {local}\n"
            "处理建议：\n"
            "1) 有网时再试一次（会从百度 BOS 下载模型）；\n"
            "2) 设置里先改用已缓存的 tiny/small 档位；\n"
            "3) 有 GPU 但失败时请确认已安装 CUDA 版 paddlepaddle；\n"
            "4) 确认已设置 PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True。"
            f"{proxy_hint}"
        ) from exc
    return _OCR


def get_structure():
    global _STRUCTURE, _STRUCTURE_DEVICE
    device = get_inference_device()
    if _STRUCTURE is not None and _STRUCTURE_DEVICE == device:
        return _STRUCTURE if _STRUCTURE else None
    try:
        from paddleocr import PPStructureV3
    except ImportError:
        return None
    try:
        _STRUCTURE = PPStructureV3(
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            device=device,
        )
        _STRUCTURE_DEVICE = device
    except Exception:  # noqa: BLE001
        if device.startswith("gpu"):
            try:
                _STRUCTURE = PPStructureV3(
                    use_doc_orientation_classify=False,
                    use_doc_unwarping=False,
                    device="cpu",
                )
                _STRUCTURE_DEVICE = "cpu"
            except Exception:  # noqa: BLE001
                _STRUCTURE = False
                _STRUCTURE_DEVICE = device
        else:
            _STRUCTURE = False  # 标记不可用
            _STRUCTURE_DEVICE = device
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

    emit_progress(0, 0, "loading_model")
    ocr = get_ocr(tier)
    doc = fitz.open(pdf_path)
    total_pages = len(doc)
    emit_progress(0, total_pages, "start")
    zoom = dpi / 72.0
    mat = fitz.Matrix(zoom, zoom)

    all_page_words: list[tuple[int, list[dict[str, Any]]]] = []
    structure_titles: list[tuple[int, list[dict[str, Any]]]] = []
    toc_outlines: list[dict[str, Any]] = []
    page_overlays: list[dict[str, Any]] = []

    for i in range(total_pages):
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

        emit_progress(i + 1, total_pages, "page")

    emit_progress(total_pages, total_pages, "saving")
    outline = merge_outlines(
        build_outline_from_titles(structure_titles),
        toc_outlines,
        build_outline_heuristic(all_page_words),
    )
    if outline:
        apply_outline_to_pdf(doc, outline)

    doc.save(out_path, garbage=4, deflate=True)
    doc.close()
    emit_progress(total_pages, total_pages, "done")

    return {
        "mode": "offline",
        "engine": "PP-OCRv6",
        "tier": _OCR_TIER or _resolve_tier(tier),
        "device": _OCR_DEVICE or get_inference_device(),
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
    result["device"] = _OCR_DEVICE or get_inference_device()
    result["tier"] = _OCR_TIER or _resolve_tier(tier)
    # 单页也可附带结构标题，供前端生成目录
    try:
        titles = extract_titles_structure(decode_image(image_base64))
        if titles:
            result["titles"] = titles
    except Exception:  # noqa: BLE001
        pass
    return result


def probe_backends() -> dict[str, Any]:
    """供 Rust detect_ocr_backends 调用：探测 PaddleOCR 与 GPU。"""
    paddle_ok = False
    engine = "none"
    try:
        from paddleocr import PaddleOCR  # noqa: F401

        paddle_ok = True
        engine = "PP-OCRv6"
    except Exception:  # noqa: BLE001
        pass
    device, gpu = detect_inference_device()
    return {
        "offlineReady": paddle_ok,
        "onlineReady": True,
        "engine": engine,
        "gpuAvailable": gpu,
        "device": device,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--stdin-json", action="store_true")
    parser.add_argument("--probe", action="store_true", help="探测 OCR 后端与 GPU")
    parser.add_argument("--file", type=str, default="")
    args = parser.parse_args()

    try:
        if args.probe:
            sys.stdout.write(json.dumps(probe_backends(), ensure_ascii=False))
            return 0

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
