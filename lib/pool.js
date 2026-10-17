/**
 * 极小的并发池：把一批目标分给 n 个 worker，结果按**输入顺序**返回。
 *
 * 为什么不用 Promise.all(items.map(work))：那是无限并发 —— 一次改十几个插件时会同时
 * 清缓存 + 重建 fiber，既没有收益也更容易撞上宿主的共享状态。
 */
export function clampConcurrency(value, max = 8) {
  const parsed = Math.floor(Number(value))
  if (!Number.isFinite(parsed) || parsed < 1) return 1
  return Math.min(max, parsed)
}

/**
 * @template T, R
 * @param {T[]} items
 * @param {number} limit 并发上限（<=1 时退化为串行）
 * @param {(item: T, index: number) => Promise<R>} worker
 * @returns {Promise<R[]>} 与 items 等长、同序
 */
export async function runPool(items, limit, worker) {
  const list = Array.isArray(items) ? items : []
  const results = new Array(list.length)
  if (list.length === 0) return results
  const width = Math.min(clampConcurrency(limit), list.length)
  let cursor = 0
  const consume = async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= list.length) return
      results[index] = await worker(list[index], index)
    }
  }
  await Promise.all(Array.from({ length: width }, () => consume()))
  return results
}