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

import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { clampConcurrency, runPool } from './pool.js'
import { Config, makeConfigReader } from './config.js'
import {
  findVersionMoves,
  isWithin,
  matchTargetsByPackageName,
  normalizePathForCompare,
  projectPackageNames,
  readPackageName,
  resolveTargets,
} from './targets.js'
import { createSettingsBridge } from './settings-bridge.js'
import { registerHotReloadTool } from './tool.js'
import { MAX_SNAPSHOT_BYTES, SNAPSHOT_FILENAME, diffSnapshots, parseSnapshot, serializeSnapshot } from './snapshot.js'
import { checkSnapshot } from './preflight.js'

// 让宿主读到 Config（cordis 从插件模块命名空间取 plugin.Config）；undefined = 宿主无可用的
// schemastery，此时没有设置页，但配置语义仍由 lib/config.js 的 DEFAULTS 保证。
export { Config }

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
 *
 * **Config 必须一起带过去**：cordis 只在**首次**为某个 callback 建 runtime 记录时读取
 * `plugin.Config`（`runtime = { ..., Config: plugin.Config }`），之后复用旧的 runtime。
 * 重建 fiber 时若把 Config 丢了，宿主 `SettingsForms.describe()` 里的
 * `schema = entry.fiber.runtime.Config` 就是 undefined ⇒ 该插件**在设置页里消失**、
 * `settings.update()` 报 "No configurable plugin entry"（本机真机验收实测）。
 */
function pluginShape(target, fallbackInject, fallbackConfig) {
  if (!target) return target
  const isFn = typeof target === 'function'
  const apply = isFn ? target : (typeof target.apply === 'function' ? target.apply : undefined)
  if (!apply) return target
  // 自带的声明优先，别用旧的盖掉新声明；函数形状（CJS `module.exports = apply` 还原后）也能挂 inject/Config。
  const ownInject = target.inject
  const ownConfig = target.Config
  const inject = ownInject ?? fallbackInject
  const Config = ownConfig ?? fallbackConfig
  const empty = inject == null
    || (Array.isArray(inject) ? inject.length === 0 : Object.keys(inject).length === 0)
  if (empty && Config === undefined) return target
  return {
    name: isFn ? (apply.name || target.name) : (target.name || apply.name),
    ...(empty ? {} : { inject }),
    ...(Config === undefined ? {} : { Config }),
    apply,
  }
}

export { pluginShape }

// 配置默认值与 Config schema 都在 lib/config.js（那里是唯一真源）。

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
  /**
   * 运行期配置读取器：每次都解包 volatile 引用，所以设置页改 enabled 无需重挂 fiber 即生效。
   * 读热点（扫描）请在函数入口取一次快照，别在每文件循环里调 cfg()。
   */
  const readConfig = makeConfigReader(rawConfig)
  const cfg = () => readConfig()

  /** 状态与观测面。 */
  const state = {
    startedAt: Date.now(),
    /** 运行期覆盖（/toggle 用，仅内存）：null = 跟随持久配置。 */
    runtimeOverride: null,
    intervalMs: cfg().intervalMs,
    debounceMs: cfg().debounceMs,
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

  /** 有效开关：运行期覆盖优先，其次持久配置（设置页 / /auto 写进 profile patch）。 */
  const effectiveEnabled = () => (state.runtimeOverride === null ? cfg().enabled === true : state.runtimeOverride === true)

  /**
   * 开关状态快照。**只读**，供服务与 LLM 工具查询：模型不该为了「看一眼开关」而调用会写盘的 auto。
   */
  const autoState = () => ({
    enabled: effectiveEnabled(),
    source: state.runtimeOverride === null ? 'config' : 'runtime',
    runtimeOverride: state.runtimeOverride,
    configEnabled: cfg().enabled === true,
    reloadSelf: cfg().reloadSelf === true,
    allowForeignTargets: cfg().allowForeignTargets === true,
    quiet: cfg().quiet === true,
    settingsAvailable: settingsBridge.available(),
  })

  /** 本插件在 profile patch 里的条目 id：从 loader 树现取，取不到回落包名。 */
  const ownEntryId = () => {
    try {
      for (const entry of ctx.loader.entries()) {
        const base = entry?.parent?.tree?.ctx?.baseUrl
        if (typeof base !== 'string' || !base.startsWith('file:')) continue
        const specifier = entry?.options?.name
        if (typeof specifier === 'string' && (specifier === name || specifier.startsWith(name + '/'))) {
          if (typeof entry.options.id === 'string' && entry.options.id !== '') return entry.options.id
        }
      }
    } catch { /* loader 不可用时回落 */ }
    return name
  }

  /** 持久开关桥。宿主没有 settings 服务时 available() 为 false，手动/工具重载仍然可用。 */
  const settingsBridge = createSettingsBridge({
    getService: () => ctx.get('settings'),
    entryId: ownEntryId,
    logger: ctx.logger,
  })

  function log(level, message, extra) {
    const line = { at: Date.now(), level, message: message == null ? '' : String(message) }
    if (extra !== undefined) line.extra = safeJson(extra)
    state.logs.push(line)
    if (state.logs.length > 300) state.logs.splice(0, state.logs.length - 300)
    if (level === 'error') state.lastError = line.message
    if (cfg().quiet && level === 'info') return
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
    if (!(cfg().installQuietMs > 0)) return undefined
    const dirs = profileDirs()
    if (!dirs.length) return undefined
    const now = Date.now()
    for (const dir of dirs) {
      for (const name of INSTALL_MARKERS) {
        try {
          const st = statSync(join(dir, name))
          if (now - st.mtimeMs < cfg().installQuietMs) return `${name}`
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
            if (now - st.mtimeMs < cfg().installQuietMs) return `node_modules/${dirent.name}`
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
    if (cfg().profileDir) consider(cfg().profileDir)
    consider(process.env.DSH_PROFILE_DIR)
    // 4) DSH_HOME 拼默认名
    const home = process.env.DSH_HOME
    const profileName = process.env.DSH_PROFILE
    if (home && profileName) consider(join(home, 'profiles', profileName))
    // 只缓存「非空」结果：早期（插件列表还没建好）算出来的是空数组，一旦缓存住就再也不会重算，
    // 落盘基线会一直拿不到路径（真机撞到过：快照永远写不出来）。
    if (found.size > 0) profileDirCache = [...found]
    return [...found]
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
    let entries = []
    try {
      entries = [...ctx.loader.entries()]
    } catch (error) {
      // self-reload 期间旧 fiber 已 dispose，属性访问会抛：本轮跳过收集，别把整轮/请求带崩。
      log('info', `loader 树暂不可用，本轮跳过目标收集：${error?.message || error}`)
      return []
    }
    for (const entry of entries) {
      const specifier = entry?.options?.name
      if (!specifier || specifier.startsWith('cordis:')) continue
      const baseUrl = entry?.parent?.tree?.ctx?.baseUrl
      if (!baseUrl || !baseUrl.startsWith('file:')) continue
      const url = await resolveUrl(specifier, baseUrl)
      if (!url || !url.startsWith('file:')) continue
      const root = findPackageRoot(url)
      if (!root) continue
      if (!cfg().includeAsar && isAsarPath(root)) continue
      if (cfg().except.includes(specifier)) continue
      if (!cfg().reloadSelf && root === SELF_ROOT) continue
      // 一个包根可能挂多个 entry（例如 dsh-onebot-qq 与 dsh-onebot-qq/settings-remote），
      // 全部归到同一个 root 下，重载时一起重挂。
      let target = byRoot.get(root)
      if (!target) {
        target = { root, entries: [], pkgName: specifier, id: entry.options.id }
        byRoot.set(root, target)
      }
      target.entries.push({ entry, specifier, url, id: entry.options.id })
    }
    for (const extra of cfg().extraRoots) {
      if (typeof extra !== 'string' || !existsSync(extra)) continue
      if (byRoot.has(extra)) continue
      byRoot.set(extra, { root: extra, entries: [], pkgName: '<extra>', id: '<extra>' })
    }
    return [...byRoot.values()]
  }

  /** 插件的稳定键：优先 loader entry id（版本升级后不变），否则用包名。 */
  function keyOfTarget(target) {
    const id = target?.id
    return typeof id === 'string' && id !== '' && id !== '<extra>' ? id : String(target?.pkgName ?? '')
  }

  function isWanted(target) {
    if (cfg().only.length) {
      return target.entries.some((item) => cfg().only.includes(item.specifier))
        || cfg().only.includes(target.pkgName)
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
  /** 待重载批次（root -> {target, files}）：**累积**而不是被每轮 tick 替换。 */
  const pendingReloads = new Map()
  /** 插件键 -> 上次扫描到的包根：识别「同一插件换包根」= 版本切换。 */
  const lastRootByKey = new Map()
  /** 所有重载共用的串行链，避免同一目标被并发重载。 */
  let reloadChain = Promise.resolve()
  /** 手动重载的每目标时间戳（限流用）。 */
  const manualLastAt = new Map()

  function scanRoot(root, out, depth, conf) {
    if (depth > conf.maxDepth) return
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
        scanRoot(full, out, depth + 1, conf)
        continue
      }
      if (!dirent.isFile()) continue
      if (!CODE_EXT.test(dirent.name)) continue
      if (conf.ignore.some((frag) => frag && dirent.name.includes(frag))) continue
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
    // 扫描是热点：入口取一次配置快照传下去，别在每个目录/文件上重新解包 volatile。
    const conf = cfg()
    for (const target of targets) {
      const files = new Map()
      scanRoot(target.root, files, 0, conf)
      current.set(target.root, files)
    }
    return current
  }

  function baselineSize() {
    let total = 0
    for (const files of baseline.values()) total += files.size
    return total
  }

  // ---------------------------------------------------------------- 落盘基线

  /**
   * 关闭自动重载时**不扫盘**（用户要求）；但「开启时算一次差异」需要参照物 ⇒ 把最后一次
   * 「内存里的代码 == 磁盘」时刻的文件指纹落盘。三个写入点：
   *   ① 宿主启动后扫一次（那一刻内存里的代码就是从磁盘读来的）；
   *   ② 关闭期间（把内存基线原样落盘，代价为零、且没有任何扫描）；
   *   ③ 每次真正重载之后（基线已前移）。
   */
  let snapshotWrittenAt = 0
  /** 启动首扫的完成信号：首次启用要先等它落盘，否则会拿旧/缺快照去比差异。 */
  let primePromise

  function snapshotFile() {
    // 显式配置优先（测试与自定义部署要能指到任意目录）；否则从 profile 目录反推。
    const configured = cfg().profileDir
    const dir = typeof configured === 'string' && configured.length > 0 ? configured : profileDirs()[0]
    return typeof dir === 'string' && dir.length > 0 ? join(dir, SNAPSHOT_FILENAME) : undefined
  }

  /** 落盘不可用时只提醒一次，避免每个 interval 刷一行。 */
  let snapshotPathWarned = false
  function warnSnapshotUnavailable() {
    if (snapshotPathWarned) return
    snapshotPathWarned = true
    log('info', '落盘基线不可用：找不到 profile 目录 —— 关闭自动重载期间的改动将无法在开启时补检（其余功能不受影响）')
  }

  function writeSnapshot(stamps) {
    const file = snapshotFile()
    if (file === undefined) {
      warnSnapshotUnavailable()
      return false
    }
    try {
      const text = serializeSnapshot(stamps)
      if (text.length > MAX_SNAPSHOT_BYTES) return false
      const tmp = `${file}.tmp`
      writeFileSync(tmp, text, 'utf8')
      renameSync(tmp, file)
      snapshotWrittenAt = Date.now()
      return true
    } catch (error) {
      log('info', `快照写入失败（不影响自动重载）：${error?.message || error}`)
      return false
    }
  }

  function readSnapshot() {
    const file = snapshotFile()
    if (file === undefined) return undefined
    try {
      return parseSnapshot(readFileSync(file, 'utf8'))
    } catch {
      return undefined
    }
  }

  /** 启动后扫一次并落盘：此刻内存里的代码 == 磁盘，快照即「已加载状态」的真值。 */
  async function primeSnapshot() {
    if (stopped) return
    try {
      if (installInProgress()) return
      const targets = await getTargets(true)
      writeSnapshot(scanTargets(targets))
      // 启动扫描同时记录包根映射：关闭期升级过的插件，开启时才能被识别成「换包根」。
      for (const target of targets) lastRootByKey.set(keyOfTarget(target), target.root)
    } catch (error) {
      log('info', `启动快照失败（不影响自动重载）：${error?.message || error}`)
    }
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
      // 必须用 Map.prototype.*.call 直接操作整条记录：
      // Node ≤23 的 loadCache 是 Map<url, ModuleJob>；Node ≥24 变成 Map<url, { [type]: ModuleJob }>，
      // 且它的 .delete(url) 只把默认槽置 undefined（不删整条），带 type 的（如 json）槽更是清不到。
      // 宿主 dsh-hmr 也是这么做的（注释见其 lib/index.js:560-564）。
      for (const url of urls) {
        try {
          const job = Map.prototype.get.call(cache, url)
          esmBackup.push([url, job])
          Map.prototype.delete.call(cache, url)
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
          // 三参 set(classicMapSet) 在 Node 24 会把 job 当 type 槽、抛 ERR_INVALID_ARG_TYPE 并被吞 ——
          // 回滚就会静默失效，所以统一用 Map.prototype.set.call 还原整条记录。
          if (job !== undefined) Map.prototype.set.call(cache, url, job)
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
  /**
   * 同一包根的两次重载**绝不允许交叠**：后到的排队等前一次结束。
   * 覆盖所有入口（自动批次、HTTP、工具、selfReload）—— 批次层已有 reloadChain 串行，
   * 但 selfReload 之类会绕过它，所以在最窄处（reloadTarget）再兜一层。
   */
  const targetChains = new Map()
  function reloadTarget(target) {
    const root = target?.root ?? ''
    const prev = targetChains.get(root) ?? Promise.resolve()
    const task = prev.then(
      () => reloadTargetUnlocked(target),
      () => reloadTargetUnlocked(target),
    )
    targetChains.set(root, task.then(() => undefined, () => undefined))
    return task
  }

  async function reloadTargetUnlocked(target) {
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
        // 旧 runtime 的 Config 用于回滚分支（record.plugin 只是个函数，不带声明）
        runtimeConfig: runtime?.Config,
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
    const disposeFailures = []
    for (const record of byPlugin.values()) {
      try {
        ctx.registry.delete(record.plugin)
        removed.push(record)
      } catch (error) {
        disposeFailures.push(`${record.specifier}: ${error?.message || error}`)
        log('error', `dispose 旧插件失败：${record.specifier} — ${error?.message || error}`)
      }
    }
    if (disposeFailures.length > 0) {
      // 插件可能停在「已拆一半」的状态：这时候绝不能报成功（旧代码会继续重建并打 ✔ 已热重载）。
      return { ok: false, reason: `dispose 旧插件失败（插件可能停在已拆状态，需重启宿主）：${disposeFailures.join('; ')}` }
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
            .plugin(
              pluginShape(record.replacement, record.fiberInject ?? previous.fiber?.inject, record.runtimeConfig),
              previous.config,
              () => [],
            )
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
              .plugin(
                pluginShape(record.plugin, record.fiberInject ?? previous.fiber?.inject, record.runtimeConfig),
                previous.config,
                () => [],
              )
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
    if (activated.length === 0) {
      // 有目标却一个 fiber 都没重建：清缓存或 registry.delete 没生效（异常被吞）——
      // 代码其实没换，必须当失败报出去，否则上层 ok:true 是假成功。
      return { ok: false, reason: '没有可重建的 fiber（清缓存或 registry.delete 未生效）' }
    }
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
    const ttl = Math.max(3000, cfg().intervalMs * 5)
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
      if (!effectiveEnabled()) {
        // 关闭时**不扫盘**：只把内存基线原样落盘（30s 节流），供下次开启/重启后算差异。
        if (state.ready && baseline.size > 0 && Date.now() - snapshotWrittenAt > 30000) writeSnapshot(baseline)
        return
      }

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
        pendingReloads.clear()
        targetCache = { at: 0, list: [] }
        log('info', '包管理操作结束，重建基线')
        // 注意：这里的 tick() 会立刻撞上本函数开头的重入守卫返回，基线实际由下一个 interval 轮重建。
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
      // 版本切换：同一插件换了包根（pnpm 升级的典型形态）。新包根在基线里是「第一次见到」，
      // 按老逻辑只建基线 ⇒ 升级永远不生效；这里显式识别并当作一次变更。
      const rows = targets.map((target) => ({ key: keyOfTarget(target), root: target.root }))
      const moves = findVersionMoves(lastRootByKey, rows)
      for (const row of rows) lastRootByKey.set(row.key, row.root)
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

      for (const [key, move] of moves) {
        const target = targets.find((item) => keyOfTarget(item) === key)
        if (target === undefined) continue
        log('info', `检测到版本切换：${target.pkgName}（${move.from} → ${move.to}）— 按新版本重载`)
        owners.set(target.root, { target, files: [] })
      }

      if (!state.ready) {
        state.ready = true
        log('info', `已建立基线：${targets.length} 个插件，${knownFiles} 个文件`)
        // 关闭期间不扫盘 ⇒ 用落盘快照补一次差异：真正变过的插件照样进重载批次。
        // 先等启动首扫落盘（它可能比第一次启用还慢），否则比对的是旧快照或空快照。
        if (primePromise !== undefined) {
          await Promise.race([primePromise, new Promise((resolve) => { const t = setTimeout(resolve, 3000); t.unref?.() })])
        }
        const snapshot = readSnapshot()
        if (snapshot !== undefined) {
          const stale = diffSnapshots(snapshot, current)
          for (const target of targets) {
            const files = stale.get(target.root)
            if (files !== undefined && files.length > 0) owners.set(target.root, { target, files })
          }
          if (stale.size > 0) log('info', `开启时比对快照：${stale.size} 个插件在关闭期间有改动`)
        }
        if (!owners.size) {
          writeSnapshot(current)
          return
        }
      }
      if (!owners.size) return

      const summary = [...owners.values()]
        .map(({ target, files }) => `${target.pkgName}(${files.length})`)
        .join(', ')
      // debounce：等写入稳定，期间的新变更在**同一批次里累积**。
      // 不能只保留最后一轮的 owners：debounceMs 现在可由设置页热改，一旦它大于 intervalMs，
      // 上一轮的目标会被静默丢掉（基线已前移，之后就再也检测不到）。
      const debounceMs = cfg().debounceMs
      for (const [root, entry] of owners) pendingReloads.set(root, entry)
      log('info', `检测到变更：${summary} — ${debounceMs}ms 后重载`)
      clearTimeout(pendingTimer)
      pendingTimer = setTimeout(() => {
        const batch = [...pendingReloads.values()]
        pendingReloads.clear()
        void performReload(batch)
          .then(() => { writeSnapshot(baseline) })
          .catch((error) => {
            state.failures += 1
            log('error', `重载批次失败：${error?.message || error}`)
          })
      }, debounceMs)
      pendingTimer.unref?.()
    } catch (error) {
      state.failures += 1
      log('error', `扫描失败：${error?.message || error}`)
    } finally {
      running = false
    }
  }

  /**
   * 重载一批目标。返回逐目标结果 —— HTTP /reload 与工具 hot_reload 的响应都靠它，
   * 不再用「全局计数差值」猜成功与否。
   * @returns {Promise<Array<{pkg: string, root: string, ok: boolean, ms?: number, fibers?: number, skipped?: boolean, reason?: string, error?: string}>>}
   */
  /**
   * 重载前的快照体检：把「未写稳 / 空文件 / 语法错误」的改动挡在重载之外。
   * 关键：它在 clearPackageCache 之前执行 —— 拒绝时运行中的插件完全不受影响。
   */
  /**
   * 严格模式：在包根跑配置的检查命令（类型检查 / lint 等）。空配置 ⇒ 不检查。
   * 只在前面的快照体检通过后才跑 —— 不对半截代码做昂贵检查。
   * @returns {Array<{file: string, code: string, message: string}>} 空数组 = 通过
   */
  function runStrict(target) {
    const commands = Array.isArray(cfg().strictCommands)
      ? cfg().strictCommands.filter((command) => typeof command === 'string' && command.trim() !== '')
      : []
    if (commands.length === 0) return []
    const timeout = Math.max(1000, Number(cfg().strictTimeoutMs) || 20000)
    for (const command of commands) {
      let result
      try {
        result = spawnSync(command, { cwd: target.root, shell: true, timeout, encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
      } catch (error) {
        return [{ file: target.root, code: 'strict', message: `${command} 无法执行：${error?.message || error}` }]
      }
      if (result?.error || result?.status !== 0) {
        const output = String(result?.stderr || result?.stdout || result?.error?.message || '').trim()
        const tail = output.split('\n').filter(Boolean).slice(-3).join(' | ')
        const why = result?.error?.code === 'ETIMEDOUT' ? `超时（${timeout}ms）` : `exit ${result?.status ?? '?'}`
        return [{ file: target.root, code: 'strict', message: `${command} 失败（${why}）${tail ? `：${tail}` : ''}` }]
      }
    }
    return []
  }

  async function preflightTarget(target, files) {
    if (cfg().checkBeforeReload !== true) return { ok: true, skipped: [] }
    const candidates = []
    for (const file of Array.isArray(files) ? files : []) candidates.push(file)
    if (candidates.length === 0) {
      // 手动重载 / 版本切换没有「变更文件」清单：退回入口文件（便宜且够用）。
      for (const item of target.entries ?? []) {
        try {
          candidates.push(fileURLToPath(item.url))
        } catch { /* 非 file: URL 跳过 */ }
      }
    }
    if (candidates.length === 0) return { ok: true, skipped: [] }
    let report
    try {
      report = await checkSnapshot(candidates, { settleMs: Number(cfg().checkSettleMs) || 0 })
    } catch (error) {
      // 体检器自己坏了：不假装通过、也不锁死插件，记一行并放行。
      log('info', `快照体检异常（已放行）：${error?.message || error}`)
      return { ok: true, degraded: true, skipped: candidates }
    }
    if (report.ok !== true) return report
    if (cfg().checkStrict === true) {
      const problems = runStrict(target)
      if (problems.length > 0) {
        return { ok: false, checked: report.checked, skipped: report.skipped, problems, retryable: false }
      }
    }
    return report
  }

  async function performReload(ownerList) {
    if (stopped) {
      // 不能返回空数组：上层会把「什么都没做」当成成功（曾经因此出现假绿）。
      return ownerList.map(({ target }) => ({ pkg: target.pkgName, root: target.root, ok: false, error: '插件已卸载（stopped），未执行重载' }))
    }
    /** 单个目标：体检 → 重载 → 记录。由下面的 worker 池调度（并发数可配）。 */
    const reloadOne = async ({ target, files }) => {
      const changed = Array.isArray(files) ? files : []
      const started = Date.now()
      try {
        // 先体检：不过关就整包跳过，绝不先清缓存（清完再失败会把运行中的实例弄坏）。
        const pre = await preflightTarget(target, files)
        if (pre.ok !== true) {
          const first = pre.problems?.[0]
          const code = first?.code ?? 'failed'
          const message = first ? `${first.file} — ${first.message}` : '快照不完整'
          log('error', `✘ 拒绝重载 ${target.pkgName}（快照体检 ${code}）：${message}`)
          state.recent.unshift({ at: Date.now(), pkg: target.pkgName, files: changed.length, ok: false, error: `preflight:${code}` })
          return { pkg: target.pkgName, root: target.root, ok: false, error: `preflight:${code}`, message, retryable: pre.retryable === true }
        }
        const result = await reloadTarget(target)
        if (result.ok) {
          state.reloads += 1
          state.lastReloadAt = Date.now()
          const fileNames = changed.slice(0, 6).map((p) => p.slice(target.root.length + 1)).join(', ')
          log('info', `✔ 已热重载 ${target.pkgName}（${Date.now() - started}ms）← ${fileNames}${changed.length > 6 ? ` 等 ${changed.length} 个文件` : ''}`)
          state.recent.unshift({ at: Date.now(), pkg: target.pkgName, files: changed.length, ms: Date.now() - started, ok: true })
          return { pkg: target.pkgName, root: target.root, ok: true, ms: Date.now() - started, fibers: result.fibers }
        }
        if (result.transient) {
          // 装包窗口之类的临时状况：不算失败，不打 error，避免刷噪音
          log('info', `跳过 ${target.pkgName}：${result.reason}`)
          state.recent.unshift({ at: Date.now(), pkg: target.pkgName, files: changed.length, ok: true, note: result.reason })
          return { pkg: target.pkgName, root: target.root, ok: true, skipped: true, reason: result.reason }
        }
        log('info', `跳过 ${target.pkgName}：${result.reason}`)
        return { pkg: target.pkgName, root: target.root, ok: true, skipped: true, reason: result.reason }
      } catch (error) {
        state.failures += 1
        log('error', `✘ 热重载 ${target.pkgName} 失败：${error?.message || error}（改动仍在磁盘，下次变更或手动重载会再试）`)
        state.recent.unshift({ at: Date.now(), pkg: target.pkgName, files: changed.length, ok: false, error: String(error?.message || error) })
        return { pkg: target.pkgName, root: target.root, ok: false, error: String(error?.message || error) }
      }
    }

    const run = async () => {
      // 每个插件独立一个 worker 槽位：不同插件之间可并行，同一目标仍只被处理一次
      // （批次由 reloadChain 串行，且 ownerList 已按包根去重）。
      const results = await runPool(ownerList, clampConcurrency(cfg().reloadConcurrency), reloadOne)
      if (state.recent.length > 30) state.recent.length = 30
      return results
    }

    // 所有入口（自动防抖 / HTTP / 工具）共用一条串行链：同一目标被并发 delete+重建会互相破坏。
    const task = reloadChain.then(async () => {
      const hmr = ctx.get('hmr')
      if (hmr && typeof hmr.runExclusive === 'function') {
        try {
          return await hmr.runExclusive(run)
        } catch (error) {
          // 只有「嵌套事务」这类**尚未开始执行**的失败才回退直跑；事务中途失败时重跑会重复重载。
          if (!/nested/i.test(String(error?.message))) throw error
          log('info', 'HMR 事务正在忙（嵌套），本轮直接执行')
        }
      }
      return await run()
    })
    reloadChain = task.then(() => undefined, () => undefined)
    // 兜底：自动路径（启用补差异 / 定时扫描）绝不能把异常抛给宿主调用栈 —— 一次失败的重载
    // 只该记成「这个插件没重载成功」，不该让「开启自动重载」这种无关操作也报错。
    // 所有未预期异常在这里折成逐目标失败行（调用方仍能从 rows 里看到原因）。
    return task.catch((error) => {
      state.failures += 1
      log('error', `重载批次失败：${error?.message || error}`)
      return ownerList.map(({ target }) => ({
        pkg: target.pkgName,
        root: target.root,
        ok: false,
        error: String(error?.message || error),
      }))
    })
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
  /**
   * 手动重载：选择器语义与 LLM 工具 hot_reload 完全一致（解析与护栏都在 lib/targets.js）。
   * @param {string[]} [selectors] 留空 = ['workspace']
   * @param {{workspace?: string, dryRun?: boolean}} [options]
   * @returns {Promise<object>} { ok, workspace, dryRun, reloaded[], skipped[], failed[] }
   */
  async function manualReload(selectors, options = {}) {
    const workspace = options.workspace || process.cwd()
    const all = await getTargets(true)
    const resolved = resolveTargets({
      selectors,
      workspace,
      targets: all,
      allowForeign: cfg().allowForeignTargets === true,
      selfRoot: SELF_ROOT,
      selfName: name,
    })
    const skipped = resolved.skipped.map((item) => ({ pkg: item.pkg, root: item.root, reason: item.reason }))

    if (options.dryRun === true) {
      // dry-run 只回报命中集合，绝不碰 reloadTarget：命中集合进 skipped 并标 dry-run。
      // 但它**做体检** —— 「先看看这批快照能不能重载」正是 dry-run 最便宜的用法。
      const matched = resolved.matched.map((item) => ({ pkg: item.target.pkgName, root: item.target.root, reason: 'dry-run' }))
      const failed = []
      for (const item of resolved.matched) {
        const pre = await preflightTarget(item.target, [])
        if (pre.ok === true) continue
        const first = pre.problems?.[0]
        failed.push({
          pkg: item.target.pkgName,
          root: item.target.root,
          ok: false,
          error: `preflight:${first?.code ?? 'failed'}`,
          message: first ? `${first.file} — ${first.message}` : '快照不完整',
          retryable: pre.retryable === true,
        })
      }
      const bad = new Set(failed.map((row) => row.pkg))
      const clean = matched.filter((row) => !bad.has(row.pkg))
      if (failed.length > 0) return {
        ok: false,
        workspace: resolved.workspace,
        dryRun: true,
        reloaded: [],
        skipped: [...skipped, ...clean],
        failed,
        note: `${failed.length} 个目标未通过快照体检（见 failed.message）`,
      }
      const empty = clean.length === 0 && skipped.length === 0
      return {
        ok: clean.length > 0,
        workspace: resolved.workspace,
        dryRun: true,
        reloaded: [],
        skipped: empty ? [{ pkg: '(选择器)', reason: 'no-match' }] : [...skipped, ...clean],
        failed: [],
        // 空命中必须显式说明，否则 ok:true + 空集合会让调用方以为「没什么要做的」
        ...(empty ? { note: '没有命中任何目标：确认 workspace 与 targets 是否匹配（可先 action:"list" 看全部目标）' } : {}),
      }
    }

    // 兜底：插件代码常在项目里、被加载的却是装进 profile 的副本（真实副本，没有软链回项目），
    // 此时按路径一个都匹配不到。用「项目里的包名」对「已加载插件的包名」再试一次。
    if (resolved.matched.length === 0 && selectors.length === 0) {
      try {
        const names = projectPackageNames(resolved.workspace)
        if (names.size > 0) {
          const named = all.map((target) => ({ ...target, packageName: readPackageName(target.root) }))
          for (const target of matchTargetsByPackageName(named, names)) {
            if (target.root === SELF_ROOT) continue
            resolved.matched.push({ target, selector: target.pkgName, how: 'package-name' })
          }
          if (resolved.matched.length > 0) {
            log('info', `按包名匹配到 ${resolved.matched.length} 个已加载插件（插件代码在项目里、加载路径不在项目内）`)
          }
        }
      } catch {
        // 兜底失败不影响原有路径匹配的结果
      }
    }

    if (!resolved.matched.length) {
      return { ok: false, workspace: resolved.workspace, dryRun: false, reloaded: [], skipped, failed: [], note: '没有匹配的插件（项目内没有已加载插件，也没有同名包）' }
    }

    // 手动限流：同一目标在 minReloadIntervalMs 内重复请求直接跳过（自动路径有自己的防抖，不受影响）。
    // 目的：连点按钮 / 模型反复调用时不去反复拆重建同一个插件。
    const minGap = Math.max(0, Number(cfg().minReloadIntervalMs) || 0)
    const now = Date.now()
    const throttled = []
    const ready = []
    for (const item of resolved.matched) {
      const root = item.target.root
      const last = manualLastAt.get(root) ?? 0
      const wait = minGap - (now - last)
      if (minGap > 0 && last > 0 && wait > 0) {
        throttled.push({ pkg: item.target.pkgName, root, reason: 'throttled', retryAfterMs: Math.round(wait) })
        continue
      }
      ready.push(item)
    }
    if (ready.length === 0) {
      return {
        ok: false,
        workspace: resolved.workspace,
        dryRun: false,
        reloaded: [],
        skipped: [...skipped, ...throttled],
        failed: [],
        note: `限流中：${throttled[0]?.pkg ?? '目标'} 刚重载过，${throttled[0]?.retryAfterMs ?? minGap}ms 后可再试`,
      }
    }

    const ownerList = ready.map((item) => ({ target: item.target, files: [] }))
    const results = await performReload(ownerList)
    const reloaded = results.filter((row) => row.ok && row.skipped !== true)
    const failed = results.filter((row) => row.ok !== true)
    for (const row of results) {
      if (row.ok === true && row.skipped !== true && typeof row.root === 'string') manualLastAt.set(row.root, Date.now())
    }
    const alsoSkipped = results.filter((row) => row.skipped === true).map((row) => ({ pkg: row.pkg, root: row.root, reason: row.reason }))
    const nothingDone = reloaded.length === 0 && failed.length === 0
    return {
      // 「有目标但一个都没真重载」不算成功：调用方（工具/HTTP）据此必须能看到没生效。
      ok: reloaded.length > 0 && failed.length === 0,
      workspace: resolved.workspace,
      dryRun: false,
      reloaded,
      skipped: [...skipped, ...throttled, ...alsoSkipped],
      failed,
      ...(nothingDone ? { note: '没有实际重载：命中的目标都被跳过（见 skipped）' } : {}),
    }
  }

  /**
   * 列出被监听的目标（HTTP GET /targets 与工具 action:"list" 共用）。
   *
   * 默认只列**真能重载**的条目：包根落在给定工作区内（或 allowForeignTargets 放行）、
   * 插件入口已激活（fiber 处于 active 且有 runtime）、且不是本插件自身。
   * 被滤掉的在 hidden 里按原因计数；all: true 时全部列出，每条带 reloadable（默认口径）、
   * manualReloadable（点名口径，GUI 用）与 blockedBy。
   * @param {{workspace?: string, all?: boolean}} [input]
   */
  async function listTargets({ workspace, all } = {}) {
    const ws = normalizePathForCompare(workspace || process.cwd()) || process.cwd()
    const allowForeign = cfg().allowForeignTargets === true
    const targets = await getTargets(true)
    // 项目归属：路径优先；路径不在项目内时，按「包名」再认一次（代码在项目、加载副本在 profile 的布局）。
    // 只在真的需要时扫描项目目录，避免每次列表都读盘。
    let projectNames
    const namesOf = () => {
      if (projectNames === undefined) projectNames = projectPackageNames(ws)
      return projectNames
    }
    const rows = targets.map((target) => {
      const root = normalizePathForCompare(target.root)
      let inWorkspace = isWithin(ws, root)
      if (inWorkspace !== true) {
        const bare = typeof target.pkgName === 'string' ? target.pkgName.split('/')[0] : ''
        const manifest = readPackageName(target.root)
        if (bare !== '' && namesOf().has(bare)) inWorkspace = true
        else if (typeof manifest === 'string' && manifest !== '' && namesOf().has(manifest)) inWorkspace = true
      }
      const self = root === SELF_ROOT || target.pkgName === name
      // 该行的插件入口是否真的活着：loader entry 的 fiber 处于 active(2) 且有 runtime。
      const activated = target.entries.some((item) => item?.entry?.fiber?.runtime != null && item.entry.fiber.state === 2)
      const blockedBy = self
        ? 'self'
        : (!inWorkspace && !allowForeign)
          ? 'outside-workspace'
          : (!activated ? 'not-activated' : undefined)
      return {
        pkg: target.pkgName,
        root: target.root,
        inWorkspace,
        activated,
        entries: target.entries.map((item) => item.specifier),
        /** 默认作用域内可直接重载（工具/HTTP 默认口径；hidden 统计也用它）。 */
        reloadable: blockedBy === undefined,
        /**
         * 「点名可重载」：只要求已激活且不是自身，与作用域无关。
         * 手动入口（GUI 点某一行）会带上该目标自己的包根作为 workspace，等于用户点名授权，
         * 所以工作区外的插件在这一栏是 true —— 界面据此给它「重载」按钮。
         */
        manualReloadable: self !== true && activated !== false,
        ...(blockedBy === undefined ? {} : { blockedBy }),
      }
    })
    const visible = all === true ? rows : rows.filter((row) => row.reloadable)
    const hiddenByReason = {}
    for (const row of rows) {
      if (row.reloadable) continue
      hiddenByReason[row.blockedBy] = (hiddenByReason[row.blockedBy] ?? 0) + 1
    }
    return {
      workspace: ws,
      listAll: all === true,
      targets: visible,
      hidden: { count: rows.length - visible.length, total: rows.length, byReason: hiddenByReason },
      autoEnabled: effectiveEnabled(),
      settingsAvailable: settingsBridge.available(),
      allowForeignTargets: allowForeign,
      // 开关状态一并返回：模型用 action:"list" 就能读到，不必调用会写盘的 auto。
      enabledSource: state.runtimeOverride === null ? 'config' : 'runtime',
      runtimeOverride: state.runtimeOverride,
      configEnabled: cfg().enabled === true,
      reloadSelf: cfg().reloadSelf === true,
      quiet: cfg().quiet === true,
    }
  }

  // ---------------------------------------------------------------- 启动

  ctx.effect(() => {
    stopped = false
    state.ready = false
    state.suspended = false
    baseline.clear()

    // 启动时扫一次并落盘（此刻内存里的代码 == 磁盘）：这是「关闭期间改动」的唯一参照物。
    const primeDelay = Math.min(1500, Math.max(120, Number(cfg().intervalMs) || 1000))
    primePromise = (async () => {
      await new Promise((resolve) => { const t = setTimeout(resolve, primeDelay); t.unref?.() })
      await primeSnapshot()
    })().catch((error) => {
      // 落盘失败只影响「关闭期间的差异比对」，不能变成 unhandledRejection 去打断宿主。
      log('error', `启动首扫落盘失败：${error?.message || error}`)
    })

    // 轮询间隔可热改：intervalMs 是 volatile，每轮 tick 前比对一次，变了就重挂定时器
    // （旧实现只在注册时读一次，改间隔必须重启宿主）。
    let tickTimer
    let armedMs = 0
    const armTicker = () => {
      const ms = Math.max(120, Number(cfg().intervalMs) || 1000)
      if (tickTimer !== undefined && ms === armedMs) return
      if (tickTimer !== undefined) clearInterval(tickTimer)
      armedMs = ms
      tickTimer = setInterval(() => {
        if (Math.max(120, Number(cfg().intervalMs) || 1000) !== armedMs) armTicker()
        void tick()
      }, ms)
      tickTimer.unref?.()
      log('info', `轮询间隔：${ms}ms`)
    }
    armTicker()
    // 首次等 loader 把 entries 都挂好，再建基线
    const boot = setTimeout(() => { void tick() }, 1200)
    boot.unref?.()

    log('info', `已启动：轮询 ${cfg().intervalMs}ms / 防抖 ${cfg().debounceMs}ms / 并行 ${cfg().reloadConcurrency} / 严格模式 ${cfg().checkStrict ? 'on' : 'off'}`)

    return () => {
      stopped = true
      clearInterval(tickTimer)
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
        // 只认前缀下的精确子路径：以前用 path.endsWith 匹配，会让 /x/reload 之类也命中，未知路径还会掉进状态页。
        const ROUTE_PREFIX = '/dsh-hot-reloader'
        const sub = path === ROUTE_PREFIX ? '' : (path.startsWith(ROUTE_PREFIX + '/') ? path.slice(ROUTE_PREFIX.length) : path)
        const method = String(request.method || 'GET').toUpperCase()
        const query = new URLSearchParams(String(request.url || '').split('?')[1] ?? '')
        try {

          /** 读请求体；读失败按空处理（POST 路由共用）。 */
          const readBody = async () => {
            let body = ''
            try {
              for await (const chunk of request) {
                body += chunk
                // 这些路由的 body 只有几十字节；给个上限，别让畸形请求吃内存。
                if (body.length > 64 * 1024) throw new Error('body too large (limit 64 KiB)')
              }
            } catch (error) {
              if (/too large/.test(String(error?.message))) throw error
              /* 读失败按空处理 */
            }
            return body
          }

          if (method === 'POST' && sub === '/reload') {
            let selectors = []
            const options = {}
            const body = await readBody()
            if (body) {
              try {
                const parsed = JSON.parse(body)
                if (Array.isArray(parsed)) selectors = parsed
                else {
                  if (Array.isArray(parsed?.targets)) selectors = parsed.targets
                  else if (Array.isArray(parsed?.packages)) selectors = parsed.packages
                  if (typeof parsed?.workspace === 'string' && parsed.workspace !== '') options.workspace = parsed.workspace
                  if (parsed?.dryRun === true) options.dryRun = true
                }
              } catch {
                // 非 JSON：容忍 "包名,包名" 这种最省事的写法
                selectors = body.split(',').map((s) => s.trim()).filter(Boolean)
              }
            }
            const workspace = options.workspace ?? query.get('workspace') ?? undefined
            const result = await manualReload(selectors, { ...options, workspace })
            response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
            response.end(JSON.stringify({ ok: true, ...result }, null, 2))
            return
          }

          // 语义不变：只在内存里翻转（不落盘）。持久开关请用 /auto 或宿主设置页。
          if (method === 'POST' && sub === '/toggle') {
            state.runtimeOverride = !effectiveEnabled()
            response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
            response.end(JSON.stringify({
              ok: true,
              enabled: effectiveEnabled(),
              runtimeOverride: state.runtimeOverride,
              configEnabled: cfg().enabled,
              note: '仅本次运行有效；要持久请用 POST /auto 或宿主设置页',
            }, null, 2))
            return
          }

          // 持久开关：写进 profile patch（宿主 settings 服务）。enabled 省略或为 null = 恢复默认。
          if (method === 'POST' && sub === '/auto') {
            const body = await readBody()
            let enabled = null
            if (body.trim() === '') {
              // 空 body 曾经被折成 null → 写 true，等于「静默打开自动重载」。必须显式拒绝。
              response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
              response.end(JSON.stringify({ ok: false, error: 'invalid-enabled', note: 'body 必须是 {"enabled": true|false|null}（null = 恢复默认）' }, null, 2))
              return
            }
            let parsed
            try {
              parsed = JSON.parse(body)
            } catch {
              response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
              response.end(JSON.stringify({ ok: false, error: 'invalid-body', note: 'body 必须是 JSON 对象 {"enabled": true|false|null}' }, null, 2))
              return
            }
            if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || !Object.hasOwn(parsed, 'enabled')) {
              response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
              response.end(JSON.stringify({ ok: false, error: 'invalid-enabled', note: '缺少 enabled 字段：只接受 true / false / null' }, null, 2))
              return
            }
            if (parsed.enabled !== true && parsed.enabled !== false && parsed.enabled !== null) {
              response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
              response.end(JSON.stringify({ ok: false, error: 'invalid-enabled', note: 'enabled 只接受 true / false / null（null = 恢复默认）' }, null, 2))
              return
            }
            enabled = parsed.enabled
            const result = await settingsBridge.write({ enabled })
            // 持久开关写成功后必须清掉内存覆盖：否则点过 /toggle 之后，设置页与 /auto 都再也压不动它。
            if (result.ok) state.runtimeOverride = null
            response.writeHead(result.ok ? 200 : (result.error === 'conflict' ? 409 : 400), { 'content-type': 'application/json; charset=utf-8' })
            response.end(JSON.stringify({ ...result, effectiveEnabled: effectiveEnabled(), configEnabled: cfg().enabled }, null, 2))
            return
          }

          // 列目标：默认只列可重载的；?all=1 连工作区外/未激活/自身一起列（与工具 action:"list" 同一实现）
          if (method === 'GET' && sub === '/targets') {
            const all = ['1', 'true'].includes(String(query.get('all') || '').toLowerCase())
            const data = await listTargets({ workspace: query.get('workspace') || undefined, all })
            response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
            response.end(JSON.stringify({ ok: true, ...data }, null, 2))
            return
          }

          // 显式重载本插件自身：默认自动重载不碰自己（避免自举抖动），
          // 但开发本插件时需要一个「改完即生效」的入口。
          if (method === 'POST' && sub === '/self-reload') {
            const result = await selfReload()
            // 失败时不能再包成 ok:true（selfReload 返回 {reloaded:false,error}）。
            response.writeHead(result.reloaded === true ? 200 : 500, { 'content-type': 'application/json; charset=utf-8' })
            response.end(JSON.stringify({ ok: result.reloaded === true, ...result }, null, 2))
            return
          }

          if (sub !== '' && sub !== '/') {
            response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
            response.end(JSON.stringify({ ok: false, error: 'not-found', path: sub }, null, 2))
            return
          }

          response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          response.end(JSON.stringify({
            ok: true,
            plugin: name,
            enabled: effectiveEnabled(),
            enabledSource: state.runtimeOverride === null ? 'config' : 'runtime',
            configEnabled: cfg().enabled,
            runtimeOverride: state.runtimeOverride,
            settingsAvailable: settingsBridge.available(),
            allowForeignTargets: cfg().allowForeignTargets === true,
            showHeaderButton: cfg().showHeaderButton !== false,
            // 浏览器半的磁盘版本：设置页卡片据此判断「我加载的那份是不是旧的」，
            // 从而提示用户重新加载界面（DSH 桌面版没有 F5 这种手动刷新入口）。
            clientScriptMtimeMs: (() => {
              try {
                return statSync(join(SELF_ROOT, 'lib', 'client.js')).mtimeMs
              } catch {
                return null
              }
            })(),
            // 自诊断：宿主 SettingsForms.describe() 里是否有本条目（决定设置页表单与 /auto 能否写；
            // 缺 Config 或 schema 无 volatile 字段时会被 describe() 跳过）。只报本条目，不摊开宿主全部插件。
            settingsRowForSelf: (() => {
              try {
                const row = (ctx.get('settings')?.describe() ?? []).find((item) => item.ns === ownEntryId())
                return row === undefined ? null : { ns: row.ns, revision: row.revision, autoGenerate: row.autoGenerate }
              } catch (error) { return String(error?.message || error) }
            })(),
            selfEntry: (() => {
              try {
                const id = ownEntryId()
                const entry = [...ctx.loader.entries()].find((item) => item?.options?.id === id)
                if (!entry) return null
                return {
                  id: entry.options.id,
                  name: entry.options.name,
                  parentEntryId: entry.parent?.tree?.ctx?.fiber?.entry?.id ?? null,
                  parentEntryName: entry.parent?.tree?.ctx?.fiber?.entry?.options?.name ?? null,
                  fiberState: entry.fiber?.state ?? null,
                  hasRowConfig: Object.hasOwn(entry.options, 'config'),
                  // 宿主 SettingsForms.describe() 的两道门：runtime.Config 与 volatileForm(schema)
                  configSchema: (() => {
                    const schema = entry.fiber?.runtime?.Config
                    if (schema === undefined) return null
                    const dict = schema?.dict ?? {}
                    return {
                      hasToJSON: typeof schema?.toJSON === 'function',
                      volatileKeys: Object.entries(dict).filter(([, field]) => field?.meta?.volatile === true).map(([key]) => key),
                      allKeys: Object.keys(dict),
                    }
                  })(),
                }
              } catch (error) { return String(error?.message || error) }
            })(),
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
              targets: 'GET  /dsh-hot-reloader/targets?workspace=<路径>   （列出目标与工作区归属）',
              reload: 'POST /dsh-hot-reloader/reload      body: ["包名"] | ["路径"] | {"targets":[...],"workspace":"...","dryRun":true}（留空 = 工作区内全部）',
              auto: 'POST /dsh-hot-reloader/auto        body: {"enabled":true|false|null}   （持久，写进 profile patch）',
              toggle: 'POST /dsh-hot-reloader/toggle      （仅内存翻转，不落盘）',
              selfReload: 'POST /dsh-hot-reloader/self-reload   （重载本插件自身，开发用）',
            },
          }, null, 2))

        // 统一兜底：宿主只会 warn + 回空 body 400，这里自己回 500 + JSON 并留一行日志。
        } catch (error) {
          state.failures += 1
          log('error', `HTTP 处理失败：${error?.message || error}`)
          try {
            if (!response.headersSent) {
              response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
              response.end(JSON.stringify({ ok: false, error: 'internal', message: String(error?.message || error) }, null, 2))
            }
          } catch { /* 连接已断，忽略 */ }
        }      },
    }), 'hot-reloader: http')

    log('info', 'HTTP 观测面：挂在宿主 webServer 上，路径 /dsh-hot-reloader（端口随宿主，不再写死）')
  })

  // 暴露为可选服务，便于其它插件主动触发；失败也不影响自动重载
  try {
    ctx.provide('hotReloader', {
      reload: manualReload,
      list: listTargets,
      setAuto: (enabled) => settingsBridge.write({ enabled }),
      auto: autoState,
      status: () => state,
      // live 取值：cfg() 每次解包 volatile，外部消费者读到的才是当前值（apply 期快照会永远停在挂载那一刻）。
      config: () => cfg(),
    })
  } catch (error) {
    log('info', `hotReloader 服务注册失败（不影响自动重载）：${error?.message || error}`)
  }

  // LLM 工具：让会话里的模型重载「它所在工作区」的插件。拿不到 tools 服务或 dsh-tools
  // 不可解析时只记一行日志 —— 自动/手动重载照常工作。
  void registerHotReloadTool(ctx, {
    version: '0.1.0',
    listTargets,
    reload: ({ selectors, workspace, dryRun }) => manualReload(selectors, { workspace, dryRun }),
    // 故意不注入 setAuto：LLM 工具只读开关（写入口留给用户：设置页 / HTTP POST /auto）。
    getAuto: autoState,
  }).then((result) => {
    if (result.registered) log('info', 'LLM 工具已注册：hot_reload')
    else log('info', `未注册 LLM 工具 hot_reload：${result.reason}`)
  }).catch((error) => {
    log('error', `注册 hot_reload 工具失败：${error?.message || error}`)
  })
}
// self-reload trigger 19:36:31