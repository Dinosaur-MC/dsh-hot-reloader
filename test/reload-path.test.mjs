import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseSnapshot } from '../lib/snapshot.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WS = path.join(HERE, 'fixtures', 'ws')
const PKG_A = path.join(WS, 'pkg-a')

/**
 * 模拟 Node ≥24 的 LoadCache：值是 `{ [type]: ModuleJob }`，而它**自己的** delete(url) 只把默认槽置 undefined
 * （不删整条记录）；set 还要求 type 参数。用来验证 clearPackageCache 用 Map.prototype.*.call 的正确性。
 */
class Node24LoadCache extends Map {
  /** 用 Map.prototype.set 装填：Map 构造器会调用被重写的 set（那条路是故意会抛的）。 */
  put(url, record) {
    Map.prototype.set.call(this, url, record)
    return this
  }

  delete(url) {
    const record = super.get(url)
    if (record !== null && typeof record === 'object' && ('javascript' in record || 'json' in record)) {
      record.javascript = undefined
      return true
    }
    return super.delete(url)
  }

  set() { throw new Error('Node 24 LoadCache.set 需要 type 参数，两参调用会抛') }
}

/** 装配一个能真正跑通「清缓存 → import → registry.delete → 重建 fiber」的桩宿主。 */
async function harness({ importThrows = false, deleteThrows = false, hmrThrows = false, config = {}, packages = ['pkg-a'], importDelayMs = 0 } = {}) {
  const mod = await import(new URL('../lib/index.js', import.meta.url).href)
  // 每个包各自一个包根 / 入口 / 旧 plugin 函数 —— 与真实宿主一样按「包根」分组重载。
  const specs = packages.map((name) => {
    const root = path.join(WS, name)
    return { name, root, url: pathToFileURL(path.join(root, 'lib', 'index.js')).href }
  })
  const url = specs[0].url
  const calls = { imports: [], deleted: [], rebuilt: [], routes: [], entries: 0, timeline: [], peak: 0 }

  const cache = new Node24LoadCache()
  for (const spec of specs) cache.put(spec.url, { javascript: { job: 'old-js' }, json: { job: 'old-json' } })
  const rebuiltFiber = { uid: 99, await: async () => {}, dispose() {} }
  const registry = {
    plugin(shape, cfg) { calls.rebuilt.push({ shape, cfg }); return { ctx: { fiber: rebuiltFiber } } },
    delete(plugin) {
      if (deleteThrows) throw new Error('dispose 挂了')
      calls.deleted.push(plugin)
    },
  }
  const entries = []
  const plugins = []
  for (const spec of specs) {
    const fiber = {
      uid: 1, state: 2, runtime: null, inject: { loader: null },
      await: async () => {}, dispose() {},
      parent: { fiber: { uid: 0 }, registry },
    }
    const apply = function fakeApplyMulti() {}
    fiber.runtime = { callback: apply, Config: { marker: 'old-schema' }, fibers: [fiber] }
    entries.push({ options: { name: spec.name, id: spec.name }, parent: { tree: { ctx: { baseUrl: pathToFileURL(WS).href } } }, fiber })
    plugins.push({ spec, apply })
  }
  const entry = entries[0]
  const previousFiber = entry.fiber
  const fakeApply = plugins[0].apply

  const loader = {
    entries() { calls.entries += 1; return entries },
    async import(u) {
      calls.imports.push(u)
      // 记录每个 import 的时间区间与并发峰值 —— 这是「并行 vs 串行」唯一的客观证据。
      calls.inFlight = (calls.inFlight ?? 0) + 1
      calls.peak = Math.max(calls.peak, calls.inFlight)
      const row = { url: u, start: Date.now(), end: 0 }
      calls.timeline.push(row)
      try {
        if (importThrows) throw new Error('BOOM 重新导入失败')
        if (importDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, importDelayMs))
        return function replacement() {}
      } finally {
        row.end = Date.now()
        calls.inFlight -= 1
      }
    },
    unwrapExports: (v) => v,
    async await() {},
    internal: {
      getOrCreateModuleJob() { return {} },
      resolveSync(_b, { specifier }) { return specs.find((spec) => spec.name === specifier)?.url },
      loadCache: cache,
    },
  }
  const webServer = { register(route) { calls.routes.push(route); return () => {} } }
  const ctx = {
    logger: { info() {}, warn() {} },
    effect: (fn) => fn(),
    inject(deps, cb) {
      if (deps.includes('webServer')) cb({ effect: (fn) => fn(), webServer })
      if (deps.includes('tools')) cb({ tools: { register: () => () => {} }, effect: (fn) => fn() })
    },
    get(name) {
      if (name === 'hmr' && hmrThrows) {
        // 模拟宿主 HMR 事务在「还没开始跑」之外的失败：这条错误必须被折成失败行，不能穿透给调用方。
        return { runExclusive: async () => { throw new Error('事务挂了') } }
      }
      return undefined
    },
    provide() {},
    loader,
    registry,
  }
  // 落盘基线会写到 profileDir：测试必须指到临时目录，否则会污染真实 profile。
  const profileDir = config.profileDir ?? mkdtempSync(path.join(tmpdir(), 'hr-test-'))
  mod.apply(ctx, { enabled: false, intervalMs: 50, profileDir, ...config })
  await new Promise((resolve) => setImmediate(resolve))
  const route = calls.routes[0]
  const call = async ({ method = 'GET', url: u = '/dsh-hot-reloader', body = '' } = {}) => {
    const chunks = body ? [Buffer.from(body)] : []
    const request = {
      method, url: u,
      headers: { host: '127.0.0.1:19387' },
      socket: { remoteAddress: '127.0.0.1' },
      async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk },
    }
    const response = { statusCode: 0, payload: '', writeHead(c) { this.statusCode = c }, end(t) { this.payload = t } }
    await route.handler(request, response)
    return { status: response.statusCode, json: response.payload ? JSON.parse(response.payload) : undefined }
  }
  return { mod, calls, cache, url, fakeApply, call, previousFiber, packages: specs }
}

test('/targets?all=1：工作区外的目标 reloadable=false 但 manualReloadable=true（GUI 点行即授权）', async () => {
  const h = await harness()
  const other = path.join(HERE, 'fixtures', 'outside')
  const { json } = await h.call({ url: '/dsh-hot-reloader/targets?all=1&workspace=' + encodeURIComponent(other) })
  const row = json.targets.find((item) => item.pkg === 'pkg-a')
  assert.ok(row, 'pkg-a 应在 all 列表里')
  assert.equal(row.inWorkspace, false)
  assert.equal(row.reloadable, false, '默认作用域内不可重载')
  assert.equal(row.manualReloadable, true, '已激活且非自身 ⇒ 点名可重载')
  assert.equal(row.blockedBy, 'outside-workspace')
  // 开关状态随列表一起返回：模型用 list 就能读到，不必调用会写盘的 auto
  assert.equal(typeof json.autoEnabled, 'boolean')
  assert.equal(typeof json.reloadSelf, 'boolean')
  assert.equal(json.quiet, false)
})

test('真重载路径：清缓存 → 重新 import → registry.delete → 重建 fiber', async () => {
  const h = await harness()
  const { json } = await h.call({ method: 'POST', url: '/dsh-hot-reloader/reload', body: JSON.stringify({ targets: ['pkg-a'], workspace: WS }) })
  assert.equal(h.calls.imports.length, 1, '必须真的重新 import 一次')
  assert.equal(h.calls.imports[0], h.url)
  assert.deepEqual(h.calls.deleted, [h.fakeApply], 'registry.delete 必须拿到旧 plugin')
  assert.equal(h.calls.rebuilt.length, 1, '必须重建出一个 fiber')
  assert.equal(json.ok, true)
  assert.equal(json.reloaded[0].fibers, 1)
})

test('Node ≥24 LoadCache：整条记录被删除（默认槽与 json 槽一起失效）', async () => {
  const h = await harness()
  await h.call({ method: 'POST', url: '/dsh-hot-reloader/reload', body: JSON.stringify({ targets: ['pkg-a'], workspace: WS }) })
  const left = Map.prototype.get.call(h.cache, h.url)
  assert.equal(left, undefined, 'LoadCache 里那条 URL 记录必须整条消失（含 json 槽）')
})

test('重新导入失败时回滚：LoadCache 记录原样恢复（两参 set 会抛，必须用 Map.prototype.set）', async () => {
  const h = await harness({ importThrows: true })
  const { json } = await h.call({ method: 'POST', url: '/dsh-hot-reloader/reload', body: JSON.stringify({ targets: ['pkg-a'], workspace: WS }) })
  const restored = Map.prototype.get.call(h.cache, h.url)
  assert.deepEqual(restored, { javascript: { job: 'old-js' }, json: { job: 'old-json' } }, '回滚必须把整条记录放回去')
  assert.equal(json.ok, false)
  assert.match(json.failed[0].error, /重新导入失败/)
})

test('未预期异常不穿透：批次抛错时返回逐目标失败行（HTTP 仍是 200，不是 500）', async () => {
  const h = await harness({ hmrThrows: true })
  const { status, json } = await h.call({ method: 'POST', url: '/dsh-hot-reloader/reload', body: JSON.stringify({ targets: ['pkg-a'], workspace: WS }) })
  assert.equal(status, 200, '重载失败不能让 HTTP 层变成 500（开启开关时更不能把错误抛回宿主）')
  assert.equal(json.ok, false)
  assert.match(json.failed[0].error, /事务挂了/)
})

test('dispose 失败不许报成功：ok=false 且 reason 说明已拆状态', async () => {
  const h = await harness({ deleteThrows: true })
  const { json } = await h.call({ method: 'POST', url: '/dsh-hot-reloader/reload', body: JSON.stringify({ targets: ['pkg-a'], workspace: WS }) })
  assert.equal(json.ok, false)
  assert.match(JSON.stringify(json), /dispose 旧插件失败/)
  assert.equal(h.calls.rebuilt.length, 0, 'dispose 失败后不应继续重建')
})

test('路由：非回环来源 403、未知子路径 404（精确匹配）', async () => {
  const h = await harness()
  const forbidden = await (async () => {
    const route = h.calls.routes[0]
    const request = { method: 'GET', url: '/dsh-hot-reloader', headers: { host: '10.0.0.1:19387' }, socket: { remoteAddress: '10.0.0.1' }, async *[Symbol.asyncIterator]() {} }
    const response = { statusCode: 0, payload: '', writeHead(c) { this.statusCode = c }, end(t) { this.payload = t } }
    await route.handler(request, response)
    return { status: response.statusCode, json: JSON.parse(response.payload) }
  })()
  assert.equal(forbidden.status, 403)
  const notFound = await h.call({ url: '/dsh-hot-reloader/nope' })
  assert.equal(notFound.status, 404)
  assert.equal(notFound.json.error, 'not-found')
  const sneaky = await h.call({ method: 'POST', url: '/dsh-hot-reloader/x/reload', body: '[]' })
  assert.equal(sneaky.status, 404, '子路径必须精确匹配，/x/reload 不能再命中 /reload')
})

test('/auto：非法入参一律 400，绝不静默写成 true', async () => {
  const h = await harness()
  for (const body of ['', 'not json', '{"enabled":0}', '{"enabled":"false"}', '{}', '[]']) {
    const { status, json } = await h.call({ method: 'POST', url: '/dsh-hot-reloader/auto', body })
    assert.equal(status, 400, 'body=' + JSON.stringify(body) + ' 应被拒绝')
    assert.match(json.error, /invalid-(enabled|body)/)
  }
})
test('启动扫一次并落盘快照：写到配置的 profileDir，且能被解析回来', async () => {
  const profileDir = mkdtempSync(path.join(tmpdir(), 'hr-snap-'))
  const h = await harness({ config: { profileDir } })
  const file = path.join(profileDir, 'dsh-hot-reloader.baseline.json')
  const deadline = Date.now() + 3000
  while (Date.now() < deadline && !existsSync(file)) await new Promise((r) => setTimeout(r, 40))
  assert.ok(existsSync(file), '启动后应写出落盘基线')
  const parsed = parseSnapshot(readFileSync(file, 'utf8'))
  assert.ok(parsed !== undefined, '落盘内容应可解析')
  assert.ok(parsed.has(PKG_A), '应包含当前已加载的 fixture 包根')
  // 关闭期不扫盘：scans 不应随着时间增长
  const before = (await h.call({ url: '/dsh-hot-reloader' })).json.scans
  await new Promise((r) => setTimeout(r, 400))
  const after = (await h.call({ url: '/dsh-hot-reloader' })).json.scans
  assert.equal(after, before, '关闭时不得持续扫盘')
})
test('快照体检：入口语法错误时拒绝重载、且不触发 import；dry-run 同样报告', async () => {
  const h = await harness({ config: { checkSettleMs: 0, checkBeforeReload: true } })
  const entry = path.join(PKG_A, 'lib', 'index.js')
  const original = readFileSync(entry, 'utf8')
  const before = h.calls.imports.length
  try {
    writeFileSync(entry, 'export default function broken( {\n')
    const real = await h.call({ method: 'POST', url: '/dsh-hot-reloader/reload', body: JSON.stringify({ targets: ['pkg-a'] }) })
    assert.equal(real.json.ok, false, '坏快照不得算成功')
    assert.equal(real.json.failed.length, 1)
    assert.match(String(real.json.failed[0].error), /^preflight:syntax/)
    assert.equal(h.calls.imports.length, before, '体检失败时不得 import（更不能先清缓存）')
    const dry = await h.call({ method: 'POST', url: '/dsh-hot-reloader/reload', body: JSON.stringify({ targets: ['pkg-a'], dryRun: true }) })
    assert.equal(dry.json.ok, false, 'dry-run 也要报告坏快照')
    assert.match(JSON.stringify(dry.json.failed), /preflight:syntax/)
  } finally {
    writeFileSync(entry, original)
  }
  const healed = await h.call({ method: 'POST', url: '/dsh-hot-reloader/reload', body: JSON.stringify({ targets: ['pkg-a'], dryRun: true }) })
  assert.equal(healed.json.ok, true, '恢复后 dry-run 应通过')
})
test('严格模式：配置的检查命令失败即拒绝重载；通过则照常', async () => {
  const failing = await harness({ config: { checkSettleMs: 0, checkStrict: true, strictCommands: ['node -e process.exit(1)'], strictTimeoutMs: 15000 } })
  const before = failing.calls.imports.length
  const bad = await failing.call({ method: 'POST', url: '/dsh-hot-reloader/reload', body: JSON.stringify({ targets: ['pkg-a'] }) })
  assert.equal(bad.json.ok, false)
  assert.match(String(bad.json.failed[0].error), /^preflight:strict/)
  assert.equal(failing.calls.imports.length, before, '严格模式失败时不得 import')
  const passing = await harness({ config: { checkSettleMs: 0, checkStrict: true, strictCommands: ['node -e process.exit(0)'], strictTimeoutMs: 15000 } })
  const good = await passing.call({ method: 'POST', url: '/dsh-hot-reloader/reload', body: JSON.stringify({ targets: ['pkg-a'] }) })
  assert.equal(good.json.ok, true, JSON.stringify(good.json.failed))
  assert.equal(passing.calls.imports.length > 0, true, '通过严格模式后应正常 import')
})
test('每插件并行：两个插件同批时 import 区间重叠、峰值并发 2，结果按输入顺序', async () => {
  const h = await harness({
    packages: ['pkg-a', 'pkg-a2'],
    importDelayMs: 120,
    config: { reloadConcurrency: 3, checkSettleMs: 0, checkBeforeReload: false },
  })
  const { json } = await h.call({ method: 'POST', url: '/dsh-hot-reloader/reload', body: JSON.stringify({ targets: ['pkg-a', 'pkg-a2'], workspace: WS }) })
  assert.equal(json.ok, true, JSON.stringify(json.failed))
  assert.equal(json.reloaded.length, 2)
  assert.deepEqual(json.reloaded.map((row) => row.pkg), ['pkg-a', 'pkg-a2'], '结果必须与输入同序')
  assert.equal(h.calls.timeline.length, 2)
  const rows = [...h.calls.timeline].sort((a, b) => a.start - b.start)
  assert.ok(rows[0].start < rows[1].end && rows[1].start < rows[0].end, '并行时两个 import 的时间区间必须重叠：' + JSON.stringify(rows))
  assert.equal(h.calls.peak, 2, '峰值并发应为 2')
})

test('每插件并行：reloadConcurrency=1 时严格串行（区间不重叠、峰值 1）', async () => {
  const h = await harness({
    packages: ['pkg-a', 'pkg-a2'],
    importDelayMs: 60,
    config: { reloadConcurrency: 1, checkSettleMs: 0, checkBeforeReload: false },
  })
  const { json } = await h.call({ method: 'POST', url: '/dsh-hot-reloader/reload', body: JSON.stringify({ targets: ['pkg-a', 'pkg-a2'], workspace: WS }) })
  assert.equal(json.reloaded.length, 2)
  assert.equal(h.calls.peak, 1, 'limit=1 时不应并发')
  const rows = h.calls.timeline
  assert.ok(rows[0].end <= rows[1].start || rows[1].end <= rows[0].start, '串行时区间不应重叠：' + JSON.stringify(rows))
})
test('手动限流：同一目标在间隔内重复重载被跳过，并给出 retryAfterMs', async () => {
  const h = await harness({ config: { minReloadIntervalMs: 600, checkBeforeReload: false } })
  const body = JSON.stringify({ targets: ['pkg-a'], workspace: WS })
  const first = await h.call({ method: 'POST', url: '/dsh-hot-reloader/reload', body })
  assert.equal(first.json.ok, true, '第一次应正常重载')
  const second = await h.call({ method: 'POST', url: '/dsh-hot-reloader/reload', body })
  assert.equal(second.json.ok, false, '限流内第二次不得报成功')
  assert.equal(second.json.reloaded.length, 0)
  const row = second.json.skipped.find((item) => item.pkg === 'pkg-a')
  assert.ok(row, '被限流的目标要出现在 skipped 里')
  assert.equal(row.reason, 'throttled')
  assert.ok(row.retryAfterMs > 0, '要告诉调用方多久后可重试')
  assert.equal(h.calls.imports.length, 1, '被限流时不得真的重新 import')
})

test('手动限流：minReloadIntervalMs=0 时关闭限流', async () => {
  const h = await harness({ config: { minReloadIntervalMs: 0, checkBeforeReload: false } })
  const body = JSON.stringify({ targets: ['pkg-a'], workspace: WS })
  await h.call({ method: 'POST', url: '/dsh-hot-reloader/reload', body })
  await h.call({ method: 'POST', url: '/dsh-hot-reloader/reload', body })
  assert.equal(h.calls.imports.length, 2, '关闭限流后两次都应真的重载')
})
test('同一插件两次并发重载不交叠：排队执行、峰值并发 1、两次都成功', async () => {
  const h = await harness({ importDelayMs: 120, config: { minReloadIntervalMs: 0, checkBeforeReload: false } })
  const body = JSON.stringify({ targets: ['pkg-a'], workspace: WS })
  const [a, b] = await Promise.all([
    h.call({ method: 'POST', url: '/dsh-hot-reloader/reload', body }),
    h.call({ method: 'POST', url: '/dsh-hot-reloader/reload', body }),
  ])
  assert.equal(h.calls.timeline.length, 2, '两次都要真的执行（不是丢一次）')
  assert.equal(h.calls.peak, 1, '同一包根的重载不得交叠')
  const rows = h.calls.timeline
  assert.ok(rows[0].end <= rows[1].start || rows[1].end <= rows[0].start, '两次 import 的区间必须不重叠')
  assert.equal(a.json.ok, true)
  assert.equal(b.json.ok, true)
})
test('/targets：项目里只有同名项目目录时，已加载插件也算属于该项目（按包名兜底）', async () => {
  const h = await harness()
  const named = path.join(HERE, 'fixtures', 'outside-named')
  const { json } = await h.call({ url: '/dsh-hot-reloader/targets?workspace=' + encodeURIComponent(named) })
  const row = json.targets.find((item) => item.pkg === 'pkg-a')
  assert.ok(row, '默认列表就应出现 pkg-a（不必传 all）')
  assert.equal(row.inWorkspace, true, '包名匹配到了项目里的 pkg-a/package.json')
  assert.equal(row.reloadable, true)
})
