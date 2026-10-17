/**
 * 目标解析：把「人/模型给出的选择器」翻译成「要重载哪些目标」，并施加作用域护栏。
 *
 * 纯函数模块：不碰 ctx、不碰磁盘写入，只有 realpath 容错读取，便于单独测试。
 * 选择器语法（HTTP 的 targets[] 与工具 hot_reload 共用一套）：
 *   - 关键词 'workspace'：包根落在给定工作区内；'all'：全部被监听目标（仍受 allowForeign 约束）
 *   - 包名：specifier / pkgName / 子路径 entry（如 dsh-onebot-qq/settings-remote）
 *   - 路径：文件或目录（相对路径按工作区解析），与包根「有交集」即命中
 * 判定顺序：关键词 → 包名/路径（整串能命中包名就按包名，否则含分隔符即按路径）→ 包名兜底。
 * 顺序是有意的：'dsh-onebot-qq/settings-remote' 是包名子路径，而 'pkg/dsh-onebot-qq' 是相对路径。
 */
import fs from 'node:fs'
import path from 'node:path'

/** 关键词选择器（大小写不敏感）。 */
const KEYWORDS = new Set(['workspace', 'all'])

/**
 * 归一化路径用于比较：相对路径按 cwd 解析；能 realpath 就 realpath（link 安装两侧口径才一致）。
 * 不存在的路径不抛错，退回 resolve 结果（测试与「尚未创建的目录」都要能用）。
 * @param {unknown} value
 * @param {string} [cwd]
 * @returns {string | undefined}
 */
export function normalizePathForCompare(value, cwd) {
  if (typeof value !== 'string' || value === '') return undefined
  const resolved = path.resolve(cwd || process.cwd(), value)
  try {
    return fs.realpathSync.native(resolved)
  } catch {
    return resolved
  }
}

/**
 * child 是否落在 parent 之内（含相等）。Windows 下 path.relative 自身按盘符大小写不敏感比较。
 * @param {string} parent
 * @param {string} child
 * @returns {boolean}
 */
export function isWithin(parent, child) {
  if (typeof parent !== 'string' || typeof child !== 'string' || !parent || !child) return false
  const rel = path.relative(parent, child)
  if (rel === '') return true
  // 只认真正的父级逃逸：兄弟目录可能叫 `..foo`，`rel.startsWith('..')` 会把它误判成越界。
  if (rel === '..') return false
  return !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)
}

/** 两个路径是否有交集（互为祖先或相等）——目录选择器靠它命中该目录下的所有目标。 */
function overlaps(a, b) {
  return isWithin(a, b) || isWithin(b, a)
}

/** 整串是否是某个目标的包名 / specifier / 子路径 entry。 */
function nameMatches(target, selector) {
  const names = [target.pkgName, ...(target.entries || []).map((item) => item.specifier)]
  return names.some((name) => typeof name === 'string'
    && (name === selector || name.startsWith(selector + '/')))
}

/** 看起来像路径的选择器（绝对、以 . 开头、或含分隔符）。 */
function looksLikePath(selector) {
  return path.isAbsolute(selector) || /^[.][.]?[/\\]/.test(selector) || /[/\\]/.test(selector)
}

/**
 * 解析选择器并施加护栏。
 * @param {object} input
 * @param {string[]} [input.selectors] 留空 = ['workspace']
 * @param {string} [input.workspace] 会话工作区（默认 process.cwd()）
 * @param {Array<{pkgName: string, root: string, entries?: Array<{specifier: string}>}>} input.targets
 * @param {boolean} [input.allowForeign] 是否放行「包根在工作区之外」的目标
 * @param {string} [input.selfRoot] 本插件自己的包根（命中即跳过，避免自举抖动）
 * @param {string} [input.selfName] 本插件自己的包名
 * @returns {{ workspace: string, matched: Array<{target: object, selector: string, how: string}>, skipped: Array<{pkg: string, root?: string, selector: string, reason: string}> }}
 */
export function resolveTargets(input = {}) {
  const workspaceRoot = normalizePathForCompare(input.workspace || process.cwd()) || process.cwd()
  const allowForeign = input.allowForeign === true
  const selfRoot = normalizePathForCompare(input.selfRoot)
  const selfName = input.selfName || 'dsh-hot-reloader'
  // 先过滤再判空：`['']` 这种「非空但全无效」的输入应等价于留空（= workspace 作用域），
  // 而不是既不回落、也不记 no-match 的空集合。
  const filtered = Array.isArray(input.selectors)
    ? input.selectors.filter((item) => typeof item === 'string' && item.trim() !== '')
    : []
  const selectors = filtered.length > 0 ? filtered : ['workspace']

  const targets = (input.targets || []).map((target) => ({
    ...target,
    root: normalizePathForCompare(target.root) || target.root,
  }))

  const matched = []
  const skipped = []
  const taken = new Set()

  for (const selector of selectors) {
    const lower = selector.toLowerCase()
    const isKeyword = KEYWORDS.has(lower)
    const byName = !isKeyword && targets.filter((target) => nameMatches(target, selector))
    // 判定顺序：整串命中包名 → 按包名；否则含分隔符/绝对路径 → 按路径；都不是 → 按包名兜底（会记 no-match）
    const kind = isKeyword ? 'keyword' : (byName.length > 0 ? 'name' : (looksLikePath(selector) ? 'path' : 'name'))

    let candidates = []
    if (isKeyword) {
      candidates = lower === 'all'
        ? targets.slice()
        : targets.filter((target) => isWithin(workspaceRoot, target.root))
    } else if (kind === 'name') {
      candidates = byName
    } else {
      const abs = normalizePathForCompare(selector, workspaceRoot)
      candidates = targets.filter((target) => abs !== undefined && overlaps(abs, target.root))
    }

    if (candidates.length === 0) {
      // 关键词没命中是「当前没有目标」，不是用户写错了选择器；只有包名/路径选择器才记 no-match
      if (!isKeyword) skipped.push({ pkg: selector, selector, reason: 'no-match' })
      continue
    }

    for (const target of candidates) {
      if (taken.has(target.root)) continue
      if (selfRoot !== undefined && target.root === selfRoot) {
        taken.add(target.root)
        skipped.push({ pkg: target.pkgName, root: target.root, selector, reason: 'self' })
        continue
      }
      if (target.pkgName === selfName) {
        taken.add(target.root)
        skipped.push({ pkg: target.pkgName, root: target.root, selector, reason: 'self' })
        continue
      }
      if (!allowForeign && !isWithin(workspaceRoot, target.root)) {
        taken.add(target.root)
        skipped.push({ pkg: target.pkgName, root: target.root, selector, reason: 'outside-workspace' })
        continue
      }
      taken.add(target.root)
      matched.push({ target, selector, how: kind })
    }
  }

  return { workspace: workspaceRoot, matched, skipped }
}
/**
 * 同一个插件换了包根 = 一次「版本切换」（pnpm 升级后包根通常从 …/pkg@1.2.3/node_modules/pkg
 * 变成 …/pkg@1.2.4/…）。调用方必须把它当作变更处理：新包根在基线里是「第一次见到」，
 * 若按「首次见到只建基线」处理，升级就永远不会生效。
 *
 * @param {Map<string, string>} prevRootByKey 上一次扫描：插件键 -> 包根
 * @param {Array<{key: string, root: string}>} rows 本次扫描
 * @returns {Map<string, {from: string, to: string}>} 键 -> 迁移信息（没变的不出现）
 */
export function findVersionMoves(prevRootByKey, rows) {
  const moved = new Map()
  for (const row of rows ?? []) {
    if (typeof row?.key !== 'string' || row.key === '') continue
    const prev = typeof prevRootByKey?.get === 'function' ? prevRootByKey.get(row.key) : undefined
    if (typeof prev !== 'string' || prev === row.root) continue
    moved.set(row.key, { from: prev, to: row.root })
  }
  return moved
}
