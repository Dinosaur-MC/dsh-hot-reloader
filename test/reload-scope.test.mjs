import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIX = path.join(HERE, 'fixtures')
const WS = path.join(FIX, 'ws')
const SELF = path.join(HERE, '..')
const PKG_A = path.join(WS, 'pkg-a')
const PKG_B = path.join(FIX, 'outside', 'pkg-b')
const entryUrl = (pkg) => pathToFileURL(path.join(pkg, 'lib', 'index.js')).href

/**
 * 装配一个桩宿主：捕获定时器、HTTP 路由、tools 注册，loader 树里只有两个假插件。
 * 不启动真实定时器（用桩替换），tick 由测试手动驱动。
 */
async function harness({ config = {}, settings, fiber = false } = {}) {
  const mod = await import(new URL('../lib/index.js', import.meta.url).href)
  const calls = { entries: 0, imports: [], provides: [], routes: [], tools: [] }
  const timers = { intervals: [], timeouts: [] }
  const realSetInterval = globalThis.setInterval
  const realSetTimeout = globalThis.setTimeout
  globalThis.setInterval = (fn, ms) => { timers.intervals.push({ fn, ms }); return { unref() {} } }
  globalThis.setTimeout = (fn, ms) => { timers.timeouts.push({ fn, ms }); return { unref() {} } }

  const specifiers = [
    { name: 'pkg-a', url: entryUrl(PKG_A) },
    { name: 'pkg-b', url: entryUrl(PKG_B) },
  ]
  const entries = specifiers.map(({ name, url }) => ({
    options: { name, id: name },
    parent: { tree: { ctx: { baseUrl: pathToFileURL(WS).href } } },
    // fiber=true 时装一个「活的」入口（state 2 + runtime），用来验 list 的默认过滤。
    fiber: fiber ? { state: 2, runtime: { callback: function fakeApply() {} } } : undefined,
    url,
  }))

  const loader = {
    entries() { calls.entries += 1; return entries.map(({ options, parent, fiber: f }) => ({ options, parent, fiber: f })) },
    async import(url) { calls.imports.push(url); return function fake() {} },
    unwrapExports: (value) => value,
    async await() {},
    internal: {
      // 现代 Node 是 v2 形状（resolve 私有、改用 resolveSync）；两个都提供，避免误判分支。
      getOrCreateModuleJob() { return {} },
      resolveSync(_baseUrl, { specifier }) { return specifiers.find((row) => row.name === specifier)?.url },
      async resolve(_baseUrl, { specifier }) { return specifiers.find((row) => row.name === specifier)?.url },
      loadCache: new Map(),
    },
  }
  const webServer = { register(route) { calls.routes.push(route); return () => {} } }
  const tools = { register(definition) { calls.tools.push(definition); return () => {} } }
  const ctx = {
    logger: { info() {}, warn() {} },
    effect(fn) { return fn() },
    inject(deps, callback) {
      if (deps.includes('webServer')) callback({ effect(fn) { return fn() }, webServer })
      if (deps.includes('tools')) callback({ tools })
    },
    get(name) { return name === 'settings' ? settings : undefined },
    provide(name, value) { calls.provides.push({ name, value }) },
    loader,
  }
  try {
    mod.apply(ctx, { enabled: true, intervalMs: 100000, ...config })
  } finally {
    globalThis.setInterval = realSetInterval
    globalThis.setTimeout = realSetTimeout
  }
  // 让 fire-and-forget 的工具注册跑完
  await new Promise((resolve) => setImmediate(resolve))
  const route = calls.routes[0]
  const tick = () => timers.intervals[0].fn()
  const call = async ({ method = 'GET', url = '/dsh-hot-reloader', body = '' } = {}) => {
    const chunks = body ? [Buffer.from(body)] : []
    const request = {
      method, url,
      headers: { host: '127.0.0.1:19387' },
      socket: { remoteAddress: '127.0.0.1' },
      async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk },
    }
    const response = {
      statusCode: 0, payload: '',
      writeHead(code) { this.statusCode = code },
      end(text) { this.payload = text },
    }
    await route.handler(request, response)
    return { status: response.statusCode, json: response.payload ? JSON.parse(response.payload) : undefined }
  }
  return { mod, calls, timers, route, tick, call }
}

test('enabled=false：tick 完全不触达 loader（自动重载被关掉）', async () => {
  const h = await harness({ config: { enabled: false } })
  const before = h.calls.entries
  await h.tick()
  await h.tick()
  assert.equal(h.calls.entries, before)
})

test('/targets：列出两个目标并标出工作区归属', async () => {
  const h = await harness()
  const { json } = await h.call({ url: '/dsh-hot-reloader/targets?all=1&workspace=' + encodeURIComponent(WS) })
  assert.equal(json.ok, true)
  const byName = Object.fromEntries(json.targets.map((row) => [row.pkg, row]))
  assert.equal(byName['pkg-a'].inWorkspace, true)
  assert.equal(byName['pkg-b'].inWorkspace, false)
  assert.equal(json.autoEnabled, true)
  assert.equal(json.settingsAvailable, false)
})

test('/reload：旧 body 形态（["包名"]）仍然按包名定位', async () => {
  const h = await harness()
  const { json } = await h.call({ method: 'POST', url: '/dsh-hot-reloader/reload', body: '["pkg-a"]' })
  assert.equal(json.ok, true)
  assert.equal(json.workspace, process.cwd())
  // fixture 的 entry 没有 fiber ⇒ reloadTarget 明确跳过（不是静默成功）
  assert.equal(json.skipped[0].pkg, 'pkg-a')
  assert.match(json.skipped[0].reason, /entry 未激活/)
})

test('/reload：dryRun 只回报命中集合，且不真的 import', async () => {
  const h = await harness()
  const { json } = await h.call({
    method: 'POST', url: '/dsh-hot-reloader/reload',
    body: JSON.stringify({ targets: ['workspace'], workspace: WS, dryRun: true }),
  })
  assert.equal(json.dryRun, true)
  assert.deepEqual(json.reloaded, [])
  const a = json.skipped.find((row) => row.pkg === 'pkg-a')
  assert.equal(a.reason, 'dry-run')
  assert.equal(h.calls.imports.length, 0)
})

test('/reload：工作区外的目标默认被拦下，给出明确 reason', async () => {
  const h = await harness()
  const { json } = await h.call({
    method: 'POST', url: '/dsh-hot-reloader/reload',
    body: JSON.stringify({ targets: ['pkg-b'], workspace: WS }),
  })
  assert.deepEqual(json.reloaded, [])
  assert.equal(json.skipped[0].pkg, 'pkg-b')
  assert.equal(json.skipped[0].reason, 'outside-workspace')
})

test('/reload：显式给 workspace 时，区外目标成为合法目标', async () => {
  const h = await harness()
  const { json } = await h.call({
    method: 'POST', url: '/dsh-hot-reloader/reload',
    body: JSON.stringify({ targets: ['pkg-b'], workspace: FIX }),
  })
  assert.equal(json.skipped[0].pkg, 'pkg-b')
  assert.match(json.skipped[0].reason, /entry 未激活/)
})

test('/auto：经 settings 服务持久写入，并回报生效值', async () => {
  const updates = []
  const settings = {
    describe: () => [{ ns: 'dsh-hot-reloader', revision: 7, value: { enabled: true } }],
    async update(ns, patch, revision) { updates.push({ ns, patch, revision }) },
  }
  const h = await harness({ settings })
  const { status, json } = await h.call({ method: 'POST', url: '/dsh-hot-reloader/auto', body: '{"enabled":false}' })
  assert.equal(status, 200)
  assert.deepEqual(updates, [{ ns: 'dsh-hot-reloader', patch: { enabled: false }, revision: 7 }])
  assert.equal(json.ok, true)
  // 桩 settings 不会真的改写运行中配置，所以生效值仍是配置里的 true；
  // 「写完后 volatile 引用即时翻转」属真机验收项（spec §8 的 S-2）。
  assert.equal(json.effectiveEnabled, true)
})

test('/auto：宿主没有 settings 服务时返回可诊断的错误（不静默）', async () => {
  const h = await harness()
  const { status, json } = await h.call({ method: 'POST', url: '/dsh-hot-reloader/auto', body: '{"enabled":false}' })
  assert.equal(status, 400)
  assert.equal(json.ok, false)
  assert.equal(json.error, 'settings-unavailable')
})

test('/toggle：仅内存翻转，并与持久配置形成优先级（runtime > config）', async () => {
  const h = await harness({ config: { enabled: false } })
  await h.tick()
  assert.equal(h.calls.entries, 0, '配置关掉时不该扫描')
  const on = await h.call({ method: 'POST', url: '/dsh-hot-reloader/toggle' })
  assert.equal(on.json.enabled, true)
  assert.equal(on.json.enabledSource, undefined)
  assert.equal(on.json.configEnabled, false)
  await h.tick()
  assert.ok(h.calls.entries > 0, '运行期覆盖为 true 后应当恢复扫描')
  const off = await h.call({ method: 'POST', url: '/dsh-hot-reloader/toggle' })
  assert.equal(off.json.enabled, false)
})

test('状态接口带全部开关来源字段', async () => {
  const h = await harness()
  const { json } = await h.call({ url: '/dsh-hot-reloader' })
  assert.equal(json.enabled, true)
  assert.equal(json.enabledSource, 'config')
  assert.equal(json.configEnabled, true)
  assert.equal(json.runtimeOverride, null)
  assert.equal(json.settingsAvailable, false)
  assert.equal(json.allowForeignTargets, false)
})

test('注册了 hot_reload 工具，默认作用域 = 会话工作区', async () => {
  const h = await harness()
  assert.equal(h.calls.tools.length, 1)
  const definition = h.calls.tools[0]
  assert.equal(definition.name, 'hot_reload')
  const exec = { agent: { session: { header: { cwd: WS } } } }
  const value = await definition.execute({ action: 'reload', dryRun: true }, exec)
  assert.equal(value.workspace, WS)
  assert.equal(value.action, 'reload')
  assert.equal(value.skipped.find((row) => row.pkg === 'pkg-a').reason, 'dry-run')
  const listed = await definition.execute({ action: 'list', all: true }, exec)
  assert.equal(listed.targets.find((row) => row.pkg === 'pkg-b').inWorkspace, false)
})

test('暴露 hotReloader 服务（其它插件可手动触发）', async () => {
  const h = await harness()
  const provided = h.calls.provides.find((row) => row.name === 'hotReloader')
  assert.ok(provided, '应提供 hotReloader 服务')
  assert.equal(typeof provided.value.reload, 'function')
  assert.equal(typeof provided.value.list, 'function')
  assert.equal(typeof provided.value.setAuto, 'function')
  assert.equal(provided.value.config.enabled, true)
})
test('/targets：默认只列可重载的，工作区外与未激活的进 hidden 汇总', async () => {
  const h = await harness({ fiber: true })
  const { json } = await h.call({ url: '/dsh-hot-reloader/targets?workspace=' + encodeURIComponent(WS) })
  assert.equal(json.listAll, false)
  assert.deepEqual(json.targets.map((row) => row.pkg), ['pkg-a'])
  assert.equal(json.targets[0].reloadable, true)
  assert.equal(json.hidden.count, 1)
  assert.deepEqual(json.hidden.byReason, { 'outside-workspace': 1 })
})

test('/targets?all=1：全部条目都列，并标出被拦的原因', async () => {
  const h = await harness({ fiber: true })
  const { json } = await h.call({ url: '/dsh-hot-reloader/targets?all=1&workspace=' + encodeURIComponent(WS) })
  assert.equal(json.listAll, true)
  const byName = Object.fromEntries(json.targets.map((row) => [row.pkg, row]))
  assert.equal(byName['pkg-a'].blockedBy, undefined)
  assert.equal(byName['pkg-b'].blockedBy, 'outside-workspace')
})

test('/targets：入口未激活的（没有 fiber）默认不列，all=1 时标 not-activated', async () => {
  const h = await harness()
  const filtered = await h.call({ url: '/dsh-hot-reloader/targets?workspace=' + encodeURIComponent(WS) })
  assert.deepEqual(filtered.json.targets, [])
  assert.deepEqual(filtered.json.hidden.byReason, { 'outside-workspace': 1, 'not-activated': 1 })
  const all = await h.call({ url: '/dsh-hot-reloader/targets?all=1&workspace=' + encodeURIComponent(WS) })
  assert.deepEqual(all.json.targets.map((row) => row.blockedBy).sort(), ['not-activated', 'outside-workspace'])
})