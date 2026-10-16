import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CLIENT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js')

/** 极简 React 桩：可选的 useState 值队列，便于把组件渲染到指定状态。 */
function makeReact(seq = []) {
  return {
    createElement: (type, props, ...children) => ({
      type,
      props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children },
    }),
    useState: (initial) => [seq.length > 0 ? seq.shift() : (typeof initial === 'function' ? initial() : initial), () => {}],
    useEffect: () => {},
  }
}
const primitives = { Checkbox: function Checkbox() {}, Button: function Button() {} }

let definition
globalThis.window = { __ModuleLoader__: { load: (value) => { definition = value } } }
await import('../lib/client.js')
delete globalThis.window
assert.ok(definition, '客户端半没有调用 window.__ModuleLoader__.load')
const loadClientHalf = (options = {}) => definition.factory((specifier) => {
  if (specifier === 'react') return options.react ?? makeReact(options.seq)
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') {
    if (options.noPrimitives === true) throw new Error('module not found')
    return options.primitives ?? primitives
  }
  return undefined
})

function stubCtx(over = {}) {
  const calls = { mutate: [], registered: [], locales: [] }
  const snapshot = {
    status: over.status ?? 'ready',
    writable: over.writable ?? true,
    revision: 7,
    value: { enabled: over.enabled ?? true },
    base: {},
    user: {},
  }
  const scope = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    mutate: async (ops, revision) => { calls.mutate.push({ ops, revision }); return over.mutateAccepts !== false },
  }
  const ctx = {
    effect: (fn) => fn(),
    locale: {
      register: (ns, dicts) => { calls.locales.push({ ns, dicts }); return () => {} },
      bind: () => (key) => key,
    },
    configForms: {
      get: (id) => { calls.get = id; if (over.getThrows) throw new Error('未服务'); return scope },
      whileServed: (ids, cb) => { calls.whileServed = ids; return cb() },
    },
    slots: {
      inject: (name, cb) => cb(),
      register: (options, component) => { calls.registered.push({ options, component }); return () => {} },
    },
  }
  return { ctx, calls, snapshot }
}

const sectionOf = (calls) => calls.registered.find((row) => row.options.name === 'settings.section')
const rowConfigOf = (calls) => calls.registered.find((row) => row.options.name === 'plugins.row.config')
const cardProps = (entry, view = 'page') => ({ ...entry.options.inject(), view, t: (key) => key })

function findAll(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out)
    return out
  }
  if (predicate(node)) out.push(node)
  if (node.props !== undefined && node.props.children !== undefined) findAll(node.props.children, predicate, out)
  return out
}
const textOf = (node) => {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (node === null || node === undefined || typeof node !== 'object') return ''
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.props?.children)
}
const text = (tree) => textOf(tree)
const byClass = (tree, className) => findAll(tree, (node) => String(node.props?.className || '').includes(className))

test('回归守卫：浏览器半绝不再调用 location.reload（会崩 DSH）', () => {
  const mod = loadClientHalf()
  assert.equal(mod.__internals.reloadInterface, undefined, '不许再导出刷新界面的入口')
  const code = fs.readFileSync(CLIENT_PATH, 'utf8')
  const codeLines = code.split('\n').filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
  const offenders = codeLines.filter((line) => line.includes('.reload(') || line.includes('location.href =') || line.includes('location.assign('))
  assert.deepEqual(offenders, [], '浏览器半不得做任何页面导航/刷新')
})

test('客户端半：导出 apply/inject，inject 只要三个服务', () => {
  const mod = loadClientHalf()
  assert.equal(typeof mod.apply, 'function')
  assert.deepEqual(mod.inject, ['slots', 'locale', 'configForms'])
})

test('注册两个座位：settings.section 与 plugins.row.config', () => {
  const mod = loadClientHalf()
  const { ctx, calls } = stubCtx()
  mod.apply(ctx)
  assert.equal(calls.get, 'dsh-hot-reloader')
  assert.equal(calls.registered.length, 2)
  const section = sectionOf(calls)
  assert.equal(section.options.id, 'hot-reloader')
  assert.equal(typeof section.options.order, 'number')
  assert.equal(section.options.locale, mod.NS)
  assert.equal(section.options.label(), 'title')
  assert.equal(rowConfigOf(calls).options.key, 'dsh-hot-reloader#dsh-hot-reloader')
  assert.deepEqual(calls.whileServed, ['dsh-hot-reloader'])
})

test('词典：值全是字符串，且 zh/en 键完全对称', () => {
  const mod = loadClientHalf()
  const { ctx, calls } = stubCtx()
  mod.apply(ctx)
  const { zh, en } = calls.locales[0].dicts
  for (const [lang, dict] of [['zh', zh], ['en', en]]) {
    for (const [key, value] of Object.entries(dict)) {
      assert.equal(typeof value, 'string', `${lang}.${key} 必须是字符串，实为 ${typeof value}`)
    }
  }
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
})

test('摘要视图：返回摘要文案', () => {
  const mod = loadClientHalf()
  const { ctx, calls } = stubCtx()
  mod.apply(ctx)
  assert.equal(sectionOf(calls).component(cardProps(sectionOf(calls), 'summary')), 'summary')
})

test('卡片：标题、勾选框（状态来自宿主快照）、手动重载区都在', () => {
  const mod = loadClientHalf()
  const { ctx, calls } = stubCtx()
  mod.apply(ctx)
  const tree = sectionOf(calls).component(cardProps(sectionOf(calls)))
  assert.match(text(tree), /title/)
  assert.match(text(tree), /manualTitle/)
  const checkbox = byClass(tree, 'dshhr-checkbox')[0]
  assert.equal(checkbox.props.checked, true)
  assert.equal(checkbox.props.disabled, false)
  assert.equal(checkbox.props.label, 'autoReload')
})

test('目标列表：每行一个插件，可重载的给按钮，自身只给说明', () => {
  const mod = loadClientHalf({ seq: [undefined, null, false, null, {
    failed: false,
    rows: [
      { pkg: 'pkg-a', root: 'F:\\ws\\pkg-a', inWorkspace: true, activated: true, reloadable: true },
      { pkg: 'pkg-b', root: 'C:\\profile\\pkg-b', inWorkspace: false, activated: true, reloadable: true, blockedBy: 'outside-workspace' },
      { pkg: 'dsh-hot-reloader', root: 'F:\\ws\\self', inWorkspace: true, activated: true, reloadable: true, blockedBy: 'self' },
    ],
  }, null, null] })
  const { ctx, calls } = stubCtx()
  mod.apply(ctx)
  const tree = sectionOf(calls).component(cardProps(sectionOf(calls)))
  assert.match(text(tree), /pkg-a/)
  assert.match(text(tree), /pkg-b/)
  const buttons = findAll(tree, (node) => String(node.props?.className || '').includes('dshhr-button') && text(node) === 'reloadOne')
  assert.equal(buttons.length, 2, '只有非自身目标给按钮')
  assert.match(text(tree), /tagSelf/, '自身那行只给说明（t 在测试里返回 key）')
})

test('点某行的「重载」：POST /reload，带该目标自己的包根作为作用域', async () => {
  const mod = loadClientHalf({ seq: [undefined, null, false, null, {
    failed: false,
    rows: [{ pkg: 'pkg-b', root: 'C:\\profile\\pkg-b', inWorkspace: false, activated: true, reloadable: true }],
  }, null, null] })
  const { ctx, calls } = stubCtx()
  mod.apply(ctx)
  const seen = []
  globalThis.fetch = async (url, init) => {
    seen.push({ url, init })
    return { json: async () => (String(url).includes('/targets') ? { targets: [] } : { ok: true, reloaded: [{ pkg: 'pkg-b' }], failed: [] }) }
  }
  try {
    const tree = sectionOf(calls).component(cardProps(sectionOf(calls)))
    const button = findAll(tree, (node) => String(node.props?.className || '').includes('dshhr-button') && text(node) === 'reloadOne')[0]
    assert.ok(button, '应有重载按钮')
    await button.props.onClick()
  } finally {
    delete globalThis.fetch
  }
  const reloadCall = seen.find((call) => call.url === '/dsh-hot-reloader/reload')
  assert.ok(reloadCall, '必须 POST 到 /reload')
  assert.equal(reloadCall.init.method, 'POST')
  assert.deepEqual(JSON.parse(reloadCall.init.body), { targets: ['pkg-b'], workspace: 'C:\\profile\\pkg-b' })
})

test('tagKeyOf：工作区外 / 未激活 / 可重载 三种标签', () => {
  const mod = loadClientHalf()
  const { tagKeyOf } = mod.__internals
  assert.equal(tagKeyOf({ inWorkspace: true, activated: true, reloadable: true }), 'tagReloadable')
  assert.equal(tagKeyOf({ inWorkspace: false, activated: true, reloadable: false }), 'tagOutside')
  assert.equal(tagKeyOf({ inWorkspace: true, activated: false, reloadable: false }), 'tagNotActivated')
})

test('三态：loading 显示「读取中」，不冒充「该行未加载」', () => {
  const mod = loadClientHalf()
  const { ctx, calls } = stubCtx({ status: 'loading' })
  mod.apply(ctx)
  const out = text(sectionOf(calls).component(cardProps(sectionOf(calls))))
  assert.match(out, /loading/)
  assert.doesNotMatch(out, /unavailable/)
})

test('三态：unavailable 才显示「未加载」并禁用勾选框', () => {
  const mod = loadClientHalf()
  const { ctx, calls } = stubCtx({ status: 'unavailable' })
  mod.apply(ctx)
  const tree = sectionOf(calls).component(cardProps(sectionOf(calls)))
  assert.match(text(tree), /unavailable/)
  assert.equal(byClass(tree, 'dshhr-checkbox')[0].props.disabled, true)
})

test('只读部署：ready 但 writable=false 时说明只读且禁用勾选框', () => {
  const mod = loadClientHalf()
  const { ctx, calls } = stubCtx({ writable: false })
  mod.apply(ctx)
  const tree = sectionOf(calls).component(cardProps(sectionOf(calls)))
  assert.match(text(tree), /readOnly/)
  assert.equal(byClass(tree, 'dshhr-checkbox')[0].props.disabled, true)
})

test('状态行走平台插值：t(key, params) 拿到 targets/files/reloads', () => {
  const mod = loadClientHalf({ seq: [undefined, { watch: [1, 2, 3], scannedFiles: 42, reloads: 5 }, false, null, null, null, null] })
  const { ctx, calls } = stubCtx()
  mod.apply(ctx)
  const entry = sectionOf(calls)
  const tt = (key, params) => params === undefined ? key : `${params.targets}|${params.files}|${params.reloads}`
  const tree = entry.component({ ...entry.options.inject(), t: tt })
  const status = byClass(tree, 'dshhr-status').find((node) => text(node).includes('|'))
  assert.ok(status, '状态行应走 t(key, params)')
  assert.equal(text(status), '3|42|5')
})

test('过期提示是文字（没有刷新按钮）：mtime 不同即提示重启', () => {
  const mod = loadClientHalf({ seq: [undefined, { clientScriptMtimeMs: 200 }, false, 100, null, null, null] })
  const { ctx, calls } = stubCtx()
  mod.apply(ctx)
  const tree = sectionOf(calls).component(cardProps(sectionOf(calls)))
  assert.match(text(tree), /staleClient/)
})

test('拿不到首方 primitives 时回落到纯 DOM input（卡片仍可渲染）', () => {
  const mod = loadClientHalf({ noPrimitives: true })
  const { ctx, calls } = stubCtx()
  mod.apply(ctx)
  const tree = sectionOf(calls).component(cardProps(sectionOf(calls)))
  const boxes = byClass(tree, 'dshhr-checkbox')
  assert.equal(boxes.length, 1)
  assert.equal(boxes[0].type, 'input')
  assert.equal(boxes[0].props.checked, true)
})

test('宿主没服务该行时 get() 抛错：安静退出，不注册任何槽、不冒泡', () => {
  const mod = loadClientHalf()
  const { ctx, calls } = stubCtx({ getThrows: true })
  assert.doesNotThrow(() => mod.apply(ctx))
  assert.equal(calls.registered.length, 0)
})

test('渲染期异常兜底：画成可见的错误文字，而不是空白', () => {
  const brokenReact = { ...makeReact(), useState: () => { throw new Error('boom') } }
  const mod = loadClientHalf({ react: brokenReact })
  const { ctx, calls } = stubCtx()
  mod.apply(ctx)
  const out = JSON.stringify(sectionOf(calls).component(cardProps(sectionOf(calls))))
  assert.match(out, /card error/)
  assert.match(out, /boom/)
})

test('hook 数恒定：首帧 snapshot 抛错也不改变 hook 顺序', () => {
  const mod = loadClientHalf()
  const { ctx, calls } = stubCtx()
  mod.apply(ctx)
  const entry = sectionOf(calls)
  let n = 0
  const face = { ...entry.options.inject(), t: (key) => key }
  const flaky = { ...face, snapshot: () => { n += 1; if (n === 1) throw new Error('first render boom'); return face.snapshot() } }
  assert.doesNotThrow(() => entry.component(flaky))
  assert.doesNotThrow(() => entry.component(flaky))
})

test('t() 抛错时卡片照样渲染（退回 key，不整页炸）', () => {
  const mod = loadClientHalf()
  const { ctx, calls } = stubCtx()
  mod.apply(ctx)
  const entry = sectionOf(calls)
  const face = { ...entry.options.inject(), t: () => { throw new Error('template.replace is not a function') } }
  const tree = entry.component(face)
  assert.equal(tree.type, 'div')
  assert.equal(byClass(tree, 'dshhr-checkbox')[0].props.label, 'autoReload')
})

test('isClientStale：只有两次 mtime 都是数字且不同才算过期', () => {
  const mod = loadClientHalf()
  const { isClientStale } = mod.__internals
  assert.equal(isClientStale(null, 100), false)
  assert.equal(isClientStale(100, null), false)
  assert.equal(isClientStale(100, 100), false)
  assert.equal(isClientStale(100, 200), true)
})

test('可访问性：勾选框关联提示；写入被拒时失败行是 role=alert', async () => {
  const mod = loadClientHalf()
  const { ctx, calls } = stubCtx({ mutateAccepts: false })
  mod.apply(ctx)
  const entry = sectionOf(calls)
  const face = entry.options.inject()
  await face.setEnabled(false)
  const tree = entry.component({ ...face, t: (key) => key })
  const checkbox = byClass(tree, 'dshhr-checkbox')[0]
  const hint = byClass(tree, 'dshhr-hint').find((node) => node.props?.id !== undefined)
  assert.equal(checkbox.props['aria-describedby'], hint.props.id)
  const alerts = findAll(tree, (node) => node.props?.role === 'alert')
  assert.equal(alerts.length, 1)
  assert.equal(text(alerts[0]), 'saveFailed')
})

test('shortPath：长路径只留末两段，短路径原样（列表不再糊成一片）', () => {
  const mod = loadClientHalf()
  const { shortPath } = mod.__internals
  const BS = String.fromCharCode(92)
  assert.equal(shortPath(['C:', 'Users', 'Dinos', '.dsh', 'profiles', 'desktop', 'node_modules', 'pkg-a'].join(BS)), `…${BS}node_modules${BS}pkg-a`)
  assert.equal(shortPath(['F:', 'ws', 'pkg-a'].join(BS)), ['F:', 'ws', 'pkg-a'].join(BS))
  assert.equal(shortPath(''), '')
  assert.equal(shortPath(null), '')
  assert.equal(shortPath('/home/u/plugins/plug'), '…/plugins/plug')
})

test('列表行结构：内容列 + 操作列，显示短路径、完整路径进 title', () => {
  const BS = String.fromCharCode(92)
  const root = ['C:', 'Users', 'Dinos', '.dsh', 'profiles', 'desktop', 'node_modules', 'pkg-b'].join(BS)
  const mod = loadClientHalf({ seq: [undefined, null, false, null, {
    failed: false,
    rows: [{ pkg: 'pkg-b', root, inWorkspace: false, activated: true, reloadable: true }],
  }, null, null] })
  const { ctx, calls } = stubCtx()
  mod.apply(ctx)
  const tree = sectionOf(calls).component(cardProps(sectionOf(calls)))
  assert.equal(byClass(tree, 'dshhr-item-main').length, 1)
  assert.equal(byClass(tree, 'dshhr-item-action').length, 1)
  const rootNode = byClass(tree, 'dshhr-root')[0]
  assert.equal(rootNode.props.title, root, '完整路径进 title')
  assert.match(text(rootNode), /^…/, '显示的是短路径')
  const actionColumn = byClass(tree, 'dshhr-item-action')[0]
  const actionButtons = findAll(actionColumn, (node) => String(node.props?.className || '').includes('dshhr-button'))
  assert.equal(actionButtons.length, 1, '操作列里是重载按钮')
})
