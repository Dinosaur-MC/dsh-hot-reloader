import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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
async function harness({ importThrows = false, deleteThrows = false, config = {} } = {}) {
  const mod = await import(new URL('../lib/index.js', import.meta.url).href)
  const url = pathToFileURL(path.join(PKG_A, 'lib', 'index.js')).href
  const calls = { imports: [], deleted: [], rebuilt: [], routes: [], entries: 0 }

  const cache = new Node24LoadCache().put(url, { javascript: { job: 'old-js' }, json: { job: 'old-json' } })
  const rebuiltFiber = { uid: 99, await: async () => {}, dispose() {} }
  const registry = {
    plugin(shape, cfg) { calls.rebuilt.push({ shape, cfg }); return { ctx: { fiber: rebuiltFiber } } },
    delete(plugin) {
      if (deleteThrows) throw new Error('dispose 挂了')
      calls.deleted.push(plugin)
    },
  }
  const previousFiber = {
    uid: 1, state: 2,
    runtime: null, inject: { loader: null },
    await: async () => {}, dispose() {},
    parent: { fiber: { uid: 0 }, registry },
  }
  const fakeApply = function fakeApply() {}
  previousFiber.runtime = { callback: fakeApply, Config: { marker: 'old-schema' }, fibers: [previousFiber] }
  const entry = {
    options: { name: 'pkg-a', id: 'pkg-a' },
    parent: { tree: { ctx: { baseUrl: pathToFileURL(WS).href } } },
    fiber: previousFiber,
  }

  const loader = {
    entries() { calls.entries += 1; return [entry] },
    async import(u) {
      calls.imports.push(u)
      if (importThrows) throw new Error('BOOM 重新导入失败')
      return function replacement() {}
    },
    unwrapExports: (v) => v,
    async await() {},
    internal: {
      getOrCreateModuleJob() { return {} },
      resolveSync(_b, { specifier }) { return specifier === 'pkg-a' ? url : undefined },
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
    get() { return undefined },
    provide() {},
    loader,
    registry,
  }
  mod.apply(ctx, { enabled: false, ...config })
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
  return { mod, calls, cache, url, fakeApply, call, previousFiber }
}

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