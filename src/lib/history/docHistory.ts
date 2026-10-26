import type {
  Highlight,
  OcrPageOverlay,
  OutlineItem,
  PageAnnotation,
  PageTitleMap,
} from '../pdf/types'

/** 可撤销的文档编辑快照 */
export type DocEditState = {
  highlights: Highlight[]
  pageAnnotations: PageAnnotation[]
  outline: OutlineItem[]
  ocrOverlays: OcrPageOverlay[]
  pageTitles: PageTitleMap
}

const MAX_HISTORY = 80

export function cloneDocEdit(state: DocEditState): DocEditState {
  return {
    highlights: structuredClone(state.highlights),
    pageAnnotations: structuredClone(state.pageAnnotations),
    outline: structuredClone(state.outline),
    ocrOverlays: structuredClone(state.ocrOverlays),
    pageTitles: structuredClone(state.pageTitles),
  }
}

export function createDocHistory() {
  const past: DocEditState[] = []
  const future: DocEditState[] = []

  return {
    clear() {
      past.length = 0
      future.length = 0
    },
    /** 在修改前调用，压入当前状态 */
    push(current: DocEditState) {
      past.push(cloneDocEdit(current))
      if (past.length > MAX_HISTORY) past.shift()
      future.length = 0
    },
    canUndo() {
      return past.length > 0
    },
    canRedo() {
      return future.length > 0
    },
    undo(current: DocEditState): DocEditState | null {
      if (!past.length) return null
      future.push(cloneDocEdit(current))
      return past.pop() || null
    },
    redo(current: DocEditState): DocEditState | null {
      if (!future.length) return null
      past.push(cloneDocEdit(current))
      return future.pop() || null
    },
  }
}

export type DocHistory = ReturnType<typeof createDocHistory>
