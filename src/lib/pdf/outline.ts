import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { OutlineItem } from './types'

type PdfOutlineNode = {
  title: string
  dest?: unknown
  items?: PdfOutlineNode[]
}

async function destToPageIndex(
  pdf: PDFDocumentProxy,
  dest: unknown,
): Promise<number | null> {
  try {
    let explicitDest = dest
    if (typeof dest === 'string') {
      explicitDest = await pdf.getDestination(dest)
    }
    if (!Array.isArray(explicitDest) || explicitDest.length === 0) return null
    const first = explicitDest[0]
    if (typeof first === 'object' && first !== null) {
      return pdf.getPageIndex(first as Parameters<PDFDocumentProxy['getPageIndex']>[0])
    }
    if (typeof first === 'number') return first
  } catch {
    return null
  }
  return null
}

async function mapOutline(
  pdf: PDFDocumentProxy,
  nodes: PdfOutlineNode[] | null | undefined,
): Promise<OutlineItem[]> {
  if (!nodes?.length) return []
  const result: OutlineItem[] = []
  for (const node of nodes) {
    const pageIndex = await destToPageIndex(pdf, node.dest)
    result.push({
      title: node.title || '未命名',
      pageIndex,
      items: await mapOutline(pdf, node.items),
    })
  }
  return result
}

export async function getOutlineTree(pdf: PDFDocumentProxy): Promise<OutlineItem[]> {
  const raw = (await pdf.getOutline()) as PdfOutlineNode[] | null
  return mapOutline(pdf, raw)
}
