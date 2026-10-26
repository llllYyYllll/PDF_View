import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { LlmImage } from './llm'

/**
 * 把 PDF 页渲染成 JPEG（base64），用于多模态模型读图。
 * 默认限制最长边 1500px，兼顾图表清晰度与请求体积。
 */
export async function renderPageImage(
  pdf: PDFDocumentProxy,
  pageIndex: number,
  maxDim = 1500,
  quality = 0.82,
): Promise<LlmImage> {
  const page = await pdf.getPage(pageIndex + 1)
  const base = page.getViewport({ scale: 1 })
  const scale = Math.min(2, maxDim / Math.max(base.width, base.height))
  const viewport = page.getViewport({ scale: Math.max(0.5, scale) })

  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(viewport.width)
  canvas.height = Math.ceil(viewport.height)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Canvas 2D context is not available.')
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)

  await page.render({ canvas, canvasContext: context, viewport }).promise

  let data = canvas.toDataURL('image/jpeg', quality)
  // 超大页面再压缩一轮，避免超过常见 5MB 图片上限
  if (data.length > 4_600_000) {
    const smaller = document.createElement('canvas')
    const ratio = Math.sqrt(4_600_000 / data.length)
    smaller.width = Math.max(1, Math.floor(canvas.width * ratio))
    smaller.height = Math.max(1, Math.floor(canvas.height * ratio))
    const ctx2 = smaller.getContext('2d')
    if (ctx2) {
      ctx2.fillStyle = '#ffffff'
      ctx2.fillRect(0, 0, smaller.width, smaller.height)
      ctx2.drawImage(canvas, 0, 0, smaller.width, smaller.height)
      data = smaller.toDataURL('image/jpeg', 0.75)
    }
  }

  return {
    mediaType: 'image/jpeg',
    data: data.replace(/^data:image\/jpeg;base64,/, ''),
  }
}
