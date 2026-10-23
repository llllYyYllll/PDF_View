/** Simple LRU of rendered page bitmaps / DOM refs by page index. */
export class PageRenderCache {
  private order: number[] = []
  private readonly maxSize: number

  constructor(maxSize = 12) {
    this.maxSize = maxSize
  }

  touch(pageIndex: number) {
    this.order = this.order.filter((p) => p !== pageIndex)
    this.order.push(pageIndex)
  }

  /** Returns page indices that should be evicted after touching `pageIndex`. */
  evictCandidates(keepSet: Set<number>): number[] {
    const victims: number[] = []
    while (this.order.length > this.maxSize) {
      const oldest = this.order.find((p) => !keepSet.has(p))
      if (oldest === undefined) break
      this.order = this.order.filter((p) => p !== oldest)
      victims.push(oldest)
    }
    // hard trim if all are in keepSet
    while (this.order.length > this.maxSize * 2) {
      const dropped = this.order.shift()
      if (dropped !== undefined) victims.push(dropped)
    }
    return victims
  }

  clear() {
    this.order = []
  }
}
