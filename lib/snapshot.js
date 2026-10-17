/**
 * 落盘基线：让「关闭自动重载期间」的改动，在重新开启或重启宿主后仍能被发现。
 *
 * 为什么必须落盘：关闭时按用户要求**不扫盘**；而「开启时算一次差异」需要参照物 ——
 * 参照物只能是最后一次「内存代码 == 磁盘」时刻的文件指纹。宿主启动后扫一次正好此刻，
 * 关闭时把内存基线原样落盘，代价为零。
 *
 * 指纹格式与内存基线一致："mtimeMs:size"（只 stat，不读内容）。
 */
export const SNAPSHOT_VERSION = 1
export const SNAPSHOT_FILENAME = 'dsh-hot-reloader.baseline.json'

/** 上限：本机 21 个插件约 550 文件 ≈ 60KB；超过 8MB 视为异常（防止把坏数据写进 profile）。 */
export const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024

/** @param {Map<string, Map<string, string>>} stamps @param {number} [at] */
export function serializeSnapshot(stamps, at = Date.now()) {
  const roots = {}
  for (const [root, files] of stamps ?? new Map()) {
    const entry = {}
    for (const [path, stamp] of files ?? new Map()) entry[path] = stamp
    roots[root] = entry
  }
  return JSON.stringify({ version: SNAPSHOT_VERSION, at, roots })
}

/** 容错解析：任何异常（缺失/半截/版本不符/超限）都返回 undefined，调用方按「没有参照物」处理。 */
export function parseSnapshot(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_SNAPSHOT_BYTES) return undefined
  let data
  try {
    data = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!data || data.version !== SNAPSHOT_VERSION) return undefined
  if (typeof data.roots !== 'object' || data.roots === null) return undefined
  const out = new Map()
  for (const [root, entry] of Object.entries(data.roots)) {
    if (typeof root !== 'string' || root === '' || typeof entry !== 'object' || entry === null) continue
    const files = new Map()
    for (const [path, stamp] of Object.entries(entry)) {
      if (typeof path === 'string' && typeof stamp === 'string') files.set(path, stamp)
    }
    out.set(root, files)
  }
  return out
}

/**
 * 差异：返回 Map<root, string[]>（改过、新增、删除的文件）。
 * 只在**双方都有**的包根上比较 —— 新装/卸载的插件由启用期的基线逻辑处理，
 * 不能在这里当成「整个包都变了」而误触发重载。
 */
export function diffSnapshots(before, after) {
  const changed = new Map()
  for (const [root, now] of after ?? new Map()) {
    const prev = typeof before?.get === 'function' ? before.get(root) : undefined
    if (prev === undefined) continue
    const files = []
    for (const [path, stamp] of now) if (prev.get(path) !== stamp) files.push(path)
    for (const path of prev.keys()) if (!now.has(path)) files.push(path)
    if (files.length > 0) changed.set(root, files)
  }
  return changed
}