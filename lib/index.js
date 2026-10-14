/**
 * dsh-hot-reloader —— 让 DSH 插件源码「改完即生效」，不用重启 DeepSeek Harness。
 *
 * 为什么需要它：
 *   宿主自带的 `@deepseek-ai/dsh-hmr` 有两处硬编码把 `/node_modules/` 排除在依赖分析之外
 *   （`isExcluded` 与 `loadDependencies`），而 profile 安装的插件恰恰都在
 *   `profiles/<p>/node_modules/<包名>/` 下 —— 所以改 `lib/*.js` 对这些插件永远不生效，
 *   这就是「改完东西老重启」的根因。本插件自己实现这条链路，不排除 node_modules。
 *
 * 原理：
 *   1. 从 loader 的每个 entry 解析出插件入口的真实 URL → 向上找 package.json 得到「包根」
 *   2. 轮询扫描包根内的 .js/.mjs/.cjs/.json（mtime + size），比对基线
 *   3. 检测到变更 → debounce 等写入稳定 → 串行执行重载
 *   4. 清掉这些模块在 Node 内部 ESM LoadCache 与 CJS require.cache 中的条目
 *   5. 重新 import 入口 → registry.delete(旧 plugin) → 用 parent.registry.plugin() 重建 fiber
 *
 * 只清「该插件包内」的模块，不动第三方依赖（它们的状态通常要复用，例如 ws 连接）。
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

export const name = 'dsh-hot-reloader'
export const inject = ['loader']

const nodeRequire = createRequire(import.meta.url)
/** 本插件自身的包根（默认不自动重载自己，避免自举抖动）。 */
const SELF_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * 把「待重建的插件」还原成带 inject 声明的插件形状。
 *
 * 为什么需要：registry 的 runtime 里只留了 `callback`（`RegistryService.resolve()`
 * 的结果，即 apply 函数本身）。函数对象上没有 `inject` 属性，所以 `record.plugin`
 * 拿去重建 fiber 时 `Inject.resolve(undefined)` 得到空 inject —— 插件一旦访问任何
 * 注入的服务就抛 `cannot get property "X" without inject`。首次重建（用重新 import
 * 的 replacement）通常自带 inject，但回滚分支用 record.plugin，于是「重建失败 →
 * 回滚也失败」，插件就停在拆掉的状态（端口不再绑定，只能重启宿主）。
 *
 * `fallbackInject` 来自运行中 fiber 的 `fiber.inject`（cordis 归一化后的 map，
 * 形状 `{ 服务名: null }`）；`Inject.resolve` 同时接受数组和这种对象，两者都行。
 */
function pluginShape(target, fallbackInject) {
  if (!target) return target
  const isFn = typeof target === 'function'
  const apply = isFn ? target : (typeof target.apply === 'function' ? target.apply : undefined)
  if (!apply) return target
  // 对象形状（ESM namespace / `{ apply }`）自带的 inject 优先，别用旧的盖掉新声明。
  const own = isFn ? undefined : target.inject
  const inject = own ?? fallbackInject
  const empty = inject == null
    || (Array.isArray(inject) ? inject.length === 0 : Object.keys(inject).length === 0)
  if (empty) return target
  return { name: isFn ? (apply.name || target.name) : (target.name || apply.name), inject, apply }
}

const DEFAULTS = {
  /** 总开关。 */
  enabled: true,
  /** 轮询间隔（毫秒）。 */
  intervalMs: 1000,
  /** 发现变更后等待写入稳定的时间（毫秒）。 */
  debounceMs: 400,
  /** 额外监听的目录（绝对路径）。 */
  extraRoots: [],
  /** 只监听这些包名（留空 = 全部）。 */
  only: [],
  /** 跳过的包名。 */
  except: [],
  /** 扫描时按文件名子串跳过。 */
  ignore: ['.bak', '.test.', '.spec.', '.map'],
  /** 目录递归深度上限。 */
  maxDepth: 8,
  /** 是否允许自动重载本插件自己。 */
  reloadSelf: false,
  /** 是否连 app.asar 内的宿主包一起监听（默认关：归档不会变，且重载宿主包会自伤）。 */
  includeAsar: false,
  /** 认定「包管理操作仍在进行」的时间窗（毫秒）；0 = 关闭该让路机制。 */
  installQuietMs: 8000,
  /** profile 目录；默认取 DSH_PROFILE_DIR。 */
  profileDir: '',
  /** 静默模式：只记录失败。 */
  quiet: false,
}

/** 递归扫描时永远跳过的目录名。 */
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', '.dsh-market', '__pycache__', '.cache'])
const CODE_EXT = /\.(js|mjs|cjs|json)$/
/** pnpm 装包时会改写的 profile 文件；用它们的 mtime 识别「正在安装」。 */
const INSTALL_MARKERS = [
  'node_modules/.modules.yaml',
  'node_modules/.pnpm-workspace-state-v1.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
]

export function apply(ctx, rawConfig = {}) {
  const cfg = { ...DEFAULTS, ...(rawConfig || {}) }

  /** 状态与观测面。 */
  const state = {
    startedAt: Date.now(),
    enabled: cfg.enabled,
    intervalMs: cfg.intervalMs,
    debounceMs: cfg.debounceMs,
    scans: 0,
    reloads: 0,
    failures: 0,
    ready: false,
    suspended: false,
    lastScanAt: 0,
    lastReloadAt: 0,
    lastError: null,
    roots: [],
    targets: [],
    logs: [],
    recent: [],
  }

  function log(level, message, extra) {
    const line = { at: Date.now(), level, message: message == null ? '' : String(message) }
    if (extra !== undefined) line.extra = safeJson(extra)
    state.logs.push(line)
    if (state.logs.length > 300) state.logs.splice(0, state.logs.length - 300)
    if (level === 'error') state.lastError = line.message
    if (cfg.quiet && level === 'info') return
    const sink = level === 'error' ? ctx.logger?.warn : ctx.logger?.info
    // ctx.logger 支持 %c 之类的占位符，这里统一自己拼好再传，避免占位符被解释。
    try {
      sink?.call(ctx.logger, `[hot-reloader] ${line.message}`)
    } catch { /* logger 不可用时静默 */ }
  }

  function safeJson(value) {
    try {
      return JSON.parse(JSON.stringify(value))
    } catch {
      return String(value)
    }
  }

  // ---------------------------------------------------------------- 模块解析

  /** 把 entry 的 specifier 解析成绝对 file: URL（兼容 Node 22/23 的 v1 与 24+ 的 v2）。 */
  async function resolveUrl(specifier, baseUrl) {
    const hmr = ctx.get('hmr')
    if (hmr && typeof hmr._resolve === 'function') {
      try {
        const resolved = await hmr._resolve(specifier, baseUrl, {})
        const url = typeof resolved === 'string' ? resolved : resolved?.url
        if (url) return url
      } catch { /* 落到下面的自实现 */ }
    }
    const internal = ctx.loader?.internal
    if (!internal) return undefined
    try {
      if (typeof internal.getOrCreateModuleJob === 'function') {
        // v2：resolve 变私有，改用 resolveSync(parentURL, request)
        const resolved = internal.resolveSync(baseUrl, { specifier, attributes: {} })
        return typeof resolved === 'string' ? resolved : resolved?.url
      }
      const resolved = await internal.resolve(specifier, baseUrl, {})
      return typeof resolved === 'string' ? resolved : resolved?.url
    } catch {
      return undefined
    }
  }

  /** asar 归档内的路径永不变化（且宿主包重载会破坏宿主自身），默认跳过。 */
  function isAsarPath(path) {
    return /[\\/]app\.asar[\\/]/.test(path) || path.includes('.asar' + sep)
  }

  /** 入口模块文件当前是否可读（装包窗口里会短暂不存在）。 */
  function moduleEntryExists(fileUrl) {
    if (!fileUrl || !fileUrl.startsWith('file:')) return true
    try {
      return existsSync(fileURLToPath(fileUrl))
    } catch {
      return true
    }
  }

  /**
   * 是否正在安装/更新包。
   *
   * pnpm 在操作时会改写 profile 根下的这几个文件；它们的 mtime 就是最可靠的信号，
   * 比去猜「目录内容看起来像不像半成品」稳得多。窗口内我们完全不碰文件系统。
   * @returns 命中的文件名，或 undefined 表示空闲。
   */
  function installInProgress() {
    if (!(cfg.installQuietMs > 0)) return undefined
    const dirs = profileDirs()
    if (!dirs.length) return undefined
    const now = Date.now()
    for (const dir of dirs) {
      for (const name of INSTALL_MARKERS) {
        try {
          const st = statSync(join(dir, name))
          if (now - st.mtimeMs < cfg.installQuietMs) return `${name}`
        } catch { /* 文件不存在则跳过 */ }
      }
      // 额外看一眼 node_modules 下有没有 pnpm 的半成品临时目录。
      // 必须校验 mtime：历史遗留的 _tmp_ 目录（装包失败留下的残骸）会永远命中，
      // 那样插件就再也不扫描了 —— 这是个真实踩过的坑。
      try {
        for (const dirent of readdirSync(join(dir, 'node_modules'), { withFileTypes: true })) {
          if (!dirent.name.includes('_tmp_')) continue
          try {
            const st = statSync(join(dir, 'node_modules', dirent.name))
            if (now - st.mtimeMs < cfg.installQuietMs) return `node_modules/${dirent.name}`
          } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    }
    return undefined
  }

  /**
   * 候选 profile 目录。
   *
   * 不依赖环境变量 —— 宿主进程里 DSH_PROFILE_DIR 未必存在。真正可靠的来源是
   * loader 树：任何插件（或 patch 文件）的绝对路径里都含 `profiles/<名字>/`，
   * 从中截出前缀即可；再加 DSH_HOME 兜底。
   */
  function profileDirs() {
    if (profileDirCache) return profileDirCache
    const found = new Set()
    const consider = (p) => {
      if (typeof p !== 'string') return
      const m = /^(.*?[\\/]profiles[\\/][^\\/]+)(?:[\\/]|$)/i.exec(p)
      if (m) found.add(m[1])
    }
    // 1) 从已解析出的插件包根反推（最可靠：这些路径一定是真实存在的）
    for (const target of targetCache.list) consider(target.root)
    // 2) 从 loader entry 的 baseUrl 反推
    try {
      for (const entry of ctx.loader.entries()) consider(entry?.parent?.tree?.ctx?.baseUrl)
    } catch { /* ignore */ }
    // 3) 显式配置 / 环境变量
    if (cfg.profileDir) consider(cfg.profileDir)
    consider(process.env.DSH_PROFILE_DIR)
    // 4) DSH_HOME 拼默认名
    const home = process.env.DSH_HOME
    const profileName = process.env.DSH_PROFILE
    if (home && profileName) consider(join(home, 'profiles', profileName))
    profileDirCache = [...found]
    return profileDirCache
  }

  /** 从入口文件向上找 package.json，得到包根目录。 */
  function findPackageRoot(entryUrl) {
    let dir
    try {
      dir = dirname(fileURLToPath(entryUrl))
    } catch {
      return undefined
    }
    let cursor = dir
    for (let i = 0; i < 8; i += 1) {
      if (existsSync(join(cursor, 'package.json'))) return cursor
      const parent = dirname(cursor)
      if (parent === cursor) break
      cursor = parent
    }
    return dir
  }

  /** 收集本轮需要盯的插件目标（每次扫描前重建，以容纳新装插件）。 */
  async function collectTargets() {
    const byRoot = new Map()
    for (const entry of ctx.loader.entries()) {
      const specifier = entry?.options?.name
      if (!specifier || specifier.startsWith('cordis:')) continue
      const baseUrl = entry?.parent?.tree?.ctx?.baseUrl
      if (!baseUrl || !baseUrl.startsWith('file:')) continue
      const url = await resolveUrl(specifier, baseUrl)
      if (!url || !url.startsWith('file:')) continue
      const root = findPackageRoot(url)
      if (!root) continue
      if (!cfg.includeAsar && isAsarPath(root)) continue
      if (cfg.except.includes(specifier)) continue
      if (!cfg.reloadSelf && root === SELF_ROOT) continue
      // 一个包根可能挂多个 entry（例如 dsh-onebot-qq 与 dsh-onebot-qq/settings-remote），
      // 全部归到同一个 root 下，重载时一起重挂。
      let target = byRoot.get(root)
      if (!target) {
        target = { root, entries: [], pkgName: specifier, id: entry.options.id }
        byRoot.set(root, target)
      }
      target.entries.push({ entry, specifier, url, id: entry.options.id })
    }
    for (const extra of cfg.extraRoots) {
      if (typeof extra !== 'string' || !existsSync(extra)) continue
      if (byRoot.has(extra)) continue
      byRoot.set(extra, { root: extra, entries: [], pkgName: '<extra>', id: '<extra>' })
    }
    return [...byRoot.values()]
  }

  function isWanted(target) {
    if (cfg.only.length) {
      return target.entries.some((item) => cfg.only.includes(item.specifier))
        || cfg.only.includes(target.pkgName)
    }
    return true
  }

  // ---------------------------------------------------------------- 文件扫描

  /**
   * 基线按「包根」分组：绝对路径 -> "mtime:size"。
   * 分组是必要的 —— 新装的插件（或宿主启动后较晚挂上的 entry）第一次被扫到时，
   * 整包文件都不在基线里，若按全局比对会被当成「新增」而误触发重载。
   */
  const baseline = new Map() // root -> Map(绝对路径 -> "mtime:size")

  function scanRoot(root, out, depth) {
    if (depth > cfg.maxDepth) return
    let entries
    try {
      entries = readdirSync(root, { withFileTypes: true })
    } catch {
      return
    }
    for (const dirent of entries) {
      const full = join(root, dirent.name)
      if (dirent.isDirectory()) {
        if (SKIP_DIRS.has(dirent.name) || dirent.name.startsWith('.')) continue
        scanRoot(full, out, depth + 1)
        continue
      }
      if (!dirent.isFile()) continue
      if (!CODE_EXT.test(dirent.name)) continue
      if (cfg.ignore.some((frag) => frag && dirent.name.includes(frag))) continue
      let stamp
      try {
        const st = statSync(full)
        stamp = `${st.mtimeMs}:${st.size}`
      } catch {
        continue
      }
      out.set(full, stamp)
    }
  }

  /** 扫描所有目标，返回 root -> Map(path -> stamp)。 */
  function scanTargets(targets) {
    const current = new Map()
    for (const target of targets) {
      const files = new Map()
      scanRoot(target.root, files, 0)
      current.set(target.root, files)
    }
    return current
  }

  function baselineSize() {
    let total = 0
    for (const files of baseline.values()) total += files.size
    return total
  }

  // ---------------------------------------------------------------- 重载核心

  /** 清掉某个包根内所有已缓存模块（ESM LoadCache + CJS require.cache），返回回滚函数。 */
  function clearPackageCache(root) {
    const internal = ctx.loader?.internal
    const cache = internal?.loadCache
    const prefix = root.endsWith(sep) ? root : root + sep
    const esmBackup = []
    const cjsBackup = []

    /** 嵌套的 node_modules（第三方依赖）不清：它们的状态通常要复用（例如 ws 连接）。 */
    const inScope = (path) => {
      if (path !== root && !path.startsWith(prefix)) return false
      return !path.slice(root.length).includes(`${sep}node_modules${sep}`)
    }

    if (cache && typeof cache.keys === 'function') {
      const urls = []
      for (const url of cache.keys()) {
        if (typeof url !== 'string' || !url.startsWith('file:')) continue
        let path
        try {
          path = fileURLToPath(url)
        } catch {
          continue
        }
        if (!inScope(path)) continue
        urls.push(url)
      }
      for (const url of urls) {
        try {
          const job = cache.get(url)
          esmBackup.push([url, job])
          cache.delete(url)
        } catch { /* 单个条目失败不影响其它 */ }
      }
    }

    const cjsCache = nodeRequire.cache
    if (cjsCache) {
      for (const path of Object.keys(cjsCache)) {
        if (!inScope(path)) continue
        cjsBackup.push([path, cjsCache[path]])
        try {
          Reflect.deleteProperty(cjsCache, path)
        } catch { /* ignore */ }
      }
    }

    return function rollback() {
      for (const [url, job] of esmBackup) {
        try {
          if (job !== undefined) cache.set(url, job)
        } catch { /* ignore */ }
      }
      for (const [path, mod] of cjsBackup) {
        try {
          cjsCache[path] = mod
        } catch { /* ignore */ }
      }
    }
  }

  /** 重载一个目标（该包根下的全部插件）。 */
  async function reloadTarget(target) {
    const loader = ctx.loader

    if (!target.entries.length) {
      // 只有 extraRoots 的场景：没有 entry 可重挂，只能清缓存让下次 import 拿到新代码。
      const rollback = clearPackageCache(target.root)
      try {
        log('info', `已清缓存（无绑定 entry）：${target.root}`)
      } catch (error) {
        rollback()
        throw error
      }
      return { ok: true, fibers: 0 }
    }

    // 按 plugin（registry 的 key = 插件的 apply 函数）聚合：
    // 同一个模块可能被多个 entry 引用，此时它们的 fiber 共享一个 runtime，
    // 必须一起重挂，否则会重复注册。
    const byPlugin = new Map()
    for (const item of target.entries) {
      const fiber = item.entry?.fiber
      const runtime = fiber?.runtime
      if (!runtime) continue
      const plugin = runtime.callback
      if (byPlugin.has(plugin)) continue
      // fiber.inject 是 cordis 归一化后的注入声明（{ 服务名: null }）。runtime.callback
      // 只是个函数，本身不带 inject —— 必须在这里把它捞出来，否则重建时会丢。
      byPlugin.set(plugin, {
        plugin,
        filename: item.url,
        runtime,
        specifier: item.specifier,
        fiberInject: fiber?.inject,
      })
    }
    if (!byPlugin.size) return { ok: false, reason: 'entry 未激活（无 fiber），跳过' }

    for (const record of byPlugin.values()) {
      record.generations = [...(record.runtime.fibers || [])].map((f) => {
        const own = f.entry?.fiber?.uid === f.uid ? f.entry : undefined
        return {
          fiber: f,
          entry: own,
          config: own === undefined ? f._config : own.options.config,
        }
      })
    }

    const rollback = clearPackageCache(target.root)

    // 先全部重新导入，任何一个失败就整体回滚，不动运行中的实例
    try {
      for (const record of byPlugin.values()) {
        // 装包 / 更新包的过程中，pnpm 会先把目录挪走再换新的。这个窗口里入口文件
        // 可能不存在 —— 这不是「代码写错了」，而是包正处于半成品状态，安静跳过即可，
        // 否则会在日志里刷一堆吓人的 ENOENT。
        if (!moduleEntryExists(record.filename)) {
          rollback()
          return { ok: false, reason: '包正在被安装/更新（入口文件暂不可读），跳过', transient: true }
        }
        const exports = await loader.import(record.filename, () => [])
        const replacement = loader.unwrapExports(exports)
        if (typeof replacement !== 'function' && !(replacement && typeof replacement.apply === 'function')) {
          throw new Error(`${record.specifier} 重新导入后不是合法插件（既非函数，也无 apply 方法）`)
        }
        record.replacement = replacement
      }
    } catch (error) {
      rollback()
      const message = error?.message || String(error)
      if (/ENOENT|no such file or directory/i.test(message)) {
        return { ok: false, reason: '包文件暂时缺失（可能正在安装/更新），跳过', transient: true }
      }
      throw new Error(`重新导入失败：${message}`)
    }

    // 卸载旧的（registry.delete 会 dispose 该 plugin 的全部 fiber）
    const removed = []
    for (const record of byPlugin.values()) {
      try {
        ctx.registry.delete(record.plugin)
        removed.push(record)
      } catch (error) {
        log('error', `dispose 旧插件失败：${record.specifier} — ${error?.message || error}`)
      }
    }
    await Promise.all(removed.flatMap(({ generations }) =>
      generations.map(({ fiber }) => fiber.await().catch(() => undefined))))

    // 按原来的 config 重建
    const activated = []
    try {
      for (const record of removed) {
        for (const previous of record.generations) {
          // parent.fiber.uid === null 表示宿主根 fiber，不重建
          if (previous.fiber.parent?.fiber?.uid === null) continue
          const rebuilt = previous.fiber.parent.registry
            .plugin(pluginShape(record.replacement, record.fiberInject ?? previous.fiber?.inject), previous.config, () => [])
            .ctx.fiber
          if (previous.entry !== undefined) {
            rebuilt.entry = previous.entry
            previous.entry.fiber = rebuilt
          }
          activated.push(rebuilt)
        }
      }
      await Promise.all(activated.map((f) => f.await()))
    } catch (error) {
      // 尽力恢复：把刚建的拆掉，再把旧插件挂回去
      for (const fiber of activated) {
        try { fiber.dispose() } catch { /* ignore */ }
      }
      for (const record of removed) {
        try {
          for (const previous of record.generations) {
            if (previous.fiber.parent?.fiber?.uid === null) continue
            const back = previous.fiber.parent.registry
              .plugin(pluginShape(record.plugin, record.fiberInject ?? previous.fiber?.inject), previous.config, () => [])
              .ctx.fiber
            if (previous.entry !== undefined) {
              back.entry = previous.entry
              previous.entry.fiber = back
            }
          }
        } catch { /* ignore */ }
      }
      rollback()
      throw new Error(`重建 fiber 失败：${error?.message || error}`)
    }

    await loader.await()
    return { ok: true, fibers: activated.length }
  }

  // ---------------------------------------------------------------- 主循环

  let stopped = false
  let running = false
  let pendingTimer
  /** target 列表缓存：解析 entry 需要 await，没必要每秒重算。 */
  let targetCache = { at: 0, list: [] }
  /** profile 目录缓存（推出来后不再变）。 */
  let profileDirCache = null

  async function getTargets(force) {
    const ttl = Math.max(3000, cfg.intervalMs * 5)
    if (!force && targetCache.list.length && Date.now() - targetCache.at < ttl) {
      return targetCache.list
    }
    const list = (await collectTargets()).filter(isWanted)
    targetCache = { at: Date.now(), list }
    profileDirCache = null   // 目标变了，重算 profile 目录
    return list
  }

  async function tick() {
    if (stopped || running) return
    running = true
    try {
      if (!state.enabled) return

      // 安装/更新包期间让路：pnpm 会把包目录「挪走 → 放新的 → 改回名字」，
      // 这个窗口里我们既不该重载（拿到的是半成品），也不该去翻它的目录。
      // pnpm 会改写这几个文件，用它们的 mtime 作为「正在装包」的信号。
      const busy = installInProgress()
      if (busy) {
        if (!state.suspended) {
          state.suspended = true
          log('info', `检测到包管理操作（${busy}），暂停扫描以免干扰安装`)
        }
        return
      }
      if (state.suspended) {
        state.suspended = false
        // 装包后目录结构已变，基线全部作废重建，避免把新装的文件当成「变更」
        baseline.clear()
        targetCache = { at: 0, list: [] }
        log('info', '包管理操作结束，重建基线')
        await tick()
        return
      }

      const targets = await getTargets(false)
      state.targets = targets.map((t) => ({
        root: t.root,
        entries: t.entries.map((item) => item.specifier),
      }))
      state.roots = [...new Set(targets.map((t) => t.root))]
      const current = scanTargets(targets)
      state.scans += 1
      state.lastScanAt = Date.now()

      // 找出变化（新增 / 修改 / 删除），按包根分组
      const owners = new Map()
      let knownFiles = 0
      for (const target of targets) {
        const now = current.get(target.root) || new Map()
        const before = baseline.get(target.root)
        baseline.set(target.root, now)
        knownFiles += now.size
        if (before === undefined) {
          // 本包第一次被扫到（刚装上 / entry 刚挂上）：只建基线，不算变更
          continue
        }
        const files = []
        for (const [path, stamp] of now) {
          if (before.get(path) !== stamp) files.push(path)
        }
        for (const path of before.keys()) {
          if (!now.has(path)) files.push(path)
        }
        if (files.length) owners.set(target.root, { target, files })
      }
      // 清理已经消失的插件
      for (const root of [...baseline.keys()]) {
        if (!targets.some((t) => t.root === root)) baseline.delete(root)
      }

      if (!state.ready) {
        state.ready = true
        log('info', `已建立基线：${targets.length} 个插件，${knownFiles} 个文件`)
        return
      }
      if (!owners.size) return

      const summary = [...owners.values()]
        .map(({ target, files }) => `${target.pkgName}(${files.length})`)
        .join(', ')
      log('info', `检测到变更：${summary} — ${cfg.debounceMs}ms 后重载`)

      // debounce：等写入稳定；期间若有新变更，tick 会在下轮再捕一次
      clearTimeout(pendingTimer)
      pendingTimer = setTimeout(() => {
        void performReload([...owners.values()])
      }, cfg.debounceMs)
      pendingTimer.unref?.()
    } catch (error) {
      state.failures += 1
      log('error', `扫描失败：${error?.message || error}`)
    } finally {
      running = false
    }
  }

  async function performReload(ownerList) {
    if (stopped) return
    const run = async () => {
      for (const { target, files } of ownerList) {
        const started = Date.now()
        try {
          const result = await reloadTarget(target)
          if (result.ok) {
            state.reloads += 1
            state.lastReloadAt = Date.now()
            const fileNames = files.slice(0, 6).map((p) => p.slice(target.root.length + 1)).join(', ')
            log('info', `✔ 已热重载 ${target.pkgName}（${Date.now() - started}ms）← ${fileNames}${files.length > 6 ? ` 等 ${files.length} 个文件` : ''}`)
            state.recent.unshift({ at: Date.now(), pkg: target.pkgName, files: files.length, ms: Date.now() - started, ok: true })
          } else if (result.transient) {
            // 装包窗口之类的临时状况：不算失败，不打 error，避免刷噪音
            log('info', `跳过 ${target.pkgName}：${result.reason}`)
            state.recent.unshift({ at: Date.now(), pkg: target.pkgName, files: files.length, ok: true, note: result.reason })
          } else {
            log('info', `跳过 ${target.pkgName}：${result.reason}`)
          }
        } catch (error) {
          state.failures += 1
          log('error', `✘ 热重载 ${target.pkgName} 失败：${error?.message || error}（改动仍在磁盘，下次变更或手动重载会再试）`)
          state.recent.unshift({ at: Date.now(), pkg: target.pkgName, files: files.length, ok: false, error: String(error?.message || error) })
        }
      }
      if (state.recent.length > 30) state.recent.length = 30
    }

    const hmr = ctx.get('hmr')
    if (hmr && typeof hmr.runExclusive === 'function') {
      try {
        await hmr.runExclusive(run)
        return
      } catch (error) {
        // 内置 HMR 正在忙（嵌套事务）时退回直接执行
        if (!/nested|disposed/i.test(String(error?.message))) {
          log('error', `HMR 事务失败，改为直接重载：${error?.message || error}`)
        }
      }
    }
    await run()
  }

  /**
   * 重载本插件自己。
   * 走与普通插件完全相同的路径，只是目标固定为自己的包根 —— 自动轮询默认不动自己
   * （改自己的监听逻辑会让自举变得难以预测），所以留这个显式入口。
   */
  async function selfReload() {
    const entry = [...ctx.loader.entries()].find((item) => {
      const base = item?.parent?.tree?.ctx?.baseUrl
      if (!base || !base.startsWith('file:')) return false
      return typeof item?.options?.name === 'string' && item.options.name.includes('dsh-hot-reloader')
    })
    if (!entry) return { reloaded: false, note: '未在当前 loader 树中找到本插件 entry' }
    const baseUrl = entry.parent?.tree?.ctx?.baseUrl
    const url = await resolveUrl(entry.options.name, baseUrl)
    if (!url) return { reloaded: false, note: '无法解析本插件入口 URL' }
    const target = { root: SELF_ROOT, entries: [{ entry, specifier: entry.options.name, url, id: entry.options.id }], pkgName: name, id: entry.options.id }
    try {
      await reloadTarget(target)
      return { reloaded: true }
    } catch (error) {
      return { reloaded: false, error: String(error?.message || error) }
    }
  }

  /** 手动触发一次重载（全量或指定包名）。 */
  async function manualReload(pkgNames) {
    const wanted = pkgNames && pkgNames.length ? new Set(pkgNames) : undefined
    const targets = (await getTargets(true))
      .filter((t) => !wanted
        || wanted.has(t.pkgName)
        || t.entries.some((item) => wanted.has(item.specifier)))
    if (!targets.length) return { reloaded: [], note: '没有匹配的插件' }
    const ownerList = targets.map((target) => ({ target, files: [] }))
    const before = state.reloads
    await performReload(ownerList)
    const succeeded = state.reloads - before
    return {
      reloaded: targets.map((t) => t.pkgName),
      succeeded,
      failures: ownerList.length - succeeded,
    }
  }

  // ---------------------------------------------------------------- 启动

  ctx.effect(() => {
    stopped = false
    state.ready = false
    state.suspended = false
    baseline.clear()

    const timer = setInterval(() => { void tick() }, Math.max(200, Number(cfg.intervalMs) || 1000))
    timer.unref?.()
    // 首次等 loader 把 entries 都挂好，再建基线
    const boot = setTimeout(() => { void tick() }, 1200)
    boot.unref?.()

    log('info', `已启动：轮询 ${cfg.intervalMs}ms / 防抖 ${cfg.debounceMs}ms`)

    return () => {
      stopped = true
      clearInterval(timer)
      clearTimeout(boot)
      clearTimeout(pendingTimer)
      baseline.clear()
      log('info', '已停止')
    }
  }, 'hot-reloader: watcher')

  // ---------------------------------------------------------------- HTTP 观测面

  ctx.inject(['webServer'], (webCtx) => {
    const isLocal = (hostname) => {
      if (!hostname) return true
      const host = String(hostname).toLowerCase().replace(/^\[|\]$/g, '')
      if (host === 'localhost' || host === '::1' || host.endsWith('.localhost')) return true
      const parts = host.split('.')
      return parts.length === 4 && parts[0] === '127'
        && parts.every((p) => /^\d+$/.test(p) && Number(p) <= 255)
    }

    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: '/dsh-hot-reloader',
      handler: async (request, response) => {
        if (!isLocal(request.socket?.remoteAddress ?? request.headers?.host?.split(':')[0])) {
          response.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
          response.end(JSON.stringify({ error: 'forbidden' }))
          return
        }
        const path = String(request.url || '/').split('?')[0]
        const method = String(request.method || 'GET').toUpperCase()

        if (method === 'POST' && path.endsWith('/reload')) {
          let body = ''
          try {
            for await (const chunk of request) body += chunk
          } catch { /* ignore */ }
          let names = []
          if (body) {
            try {
              const parsed = JSON.parse(body)
              if (Array.isArray(parsed)) names = parsed
              else if (Array.isArray(parsed?.packages)) names = parsed.packages
            } catch {
              names = body.split(',').map((s) => s.trim()).filter(Boolean)
            }
          }
          const result = await manualReload(names)
          response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          response.end(JSON.stringify({ ok: true, ...result }, null, 2))
          return
        }

        if (method === 'POST' && path.endsWith('/toggle')) {
          state.enabled = !state.enabled
          response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          response.end(JSON.stringify({ ok: true, enabled: state.enabled }))
          return
        }

        // 显式重载本插件自身：默认自动重载不碰自己（避免自举抖动），
        // 但开发本插件时需要一个「改完即生效」的入口。
        if (method === 'POST' && path.endsWith('/self-reload')) {
          const result = await selfReload()
          response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          response.end(JSON.stringify({ ok: true, ...result }, null, 2))
          return
        }

        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({
          ok: true,
          plugin: name,
          enabled: state.enabled,
          ready: state.ready,
          suspended: state.suspended || Boolean(installInProgress()),
          uptimeMs: Date.now() - state.startedAt,
          scannedFiles: baselineSize(),
          scans: state.scans,
          reloads: state.reloads,
          failures: state.failures,
          lastScanAt: state.lastScanAt,
          lastReloadAt: state.lastReloadAt,
          lastError: state.lastError,
          watch: state.roots,
          packages: state.targets,
          recent: state.recent,
          logs: state.logs.slice(-40),
          endpoints: {
            status: 'GET  /dsh-hot-reloader',
            reload: 'POST /dsh-hot-reloader/reload      body: ["包名"] 或 {"packages":["包名"]}（留空 = 全部）',
            toggle: 'POST /dsh-hot-reloader/toggle',
            selfReload: 'POST /dsh-hot-reloader/self-reload   （重载本插件自身，开发用）',
          },
        }, null, 2))
      },
    }), 'hot-reloader: http')

    log('info', 'HTTP 观测面：http://127.0.0.1:19387/dsh-hot-reloader')
  })

  // 暴露为可选服务，便于其它插件/agent 工具主动触发；失败也不影响自动重载
  try {
    ctx.provide('hotReloader', { reload: manualReload, status: () => state, config: cfg })
  } catch (error) {
    log('info', `hotReloader 服务注册失败（不影响自动重载）：${error?.message || error}`)
  }
}
// self-reload trigger 19:36:31
