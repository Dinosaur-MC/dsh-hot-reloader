import test from 'node:test'
import assert from 'node:assert/strict'

/** 极简 React 桩：只造可断言的树；useState/useEffect 不跑真副作用。 */
const React = {
  createElement: (type, props, ...children) => ({
    type,
    props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children },
  }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
}
const primitives = { Checkbox: function Checkbox() {}, Button: function Button() {} }

/**
 * 客户端半是 `window.__ModuleLoader__.load({id, factory})` 形状；ESM 有缓存，只能 import 一次。
 * 之后每个用例调用 factory 重新拿一份全新的 exports（factory 每次执行都会重建内部状态）。
 */
let definition
globalThis.window = { __ModuleLoader__: { load: (value) => { definition = value } } }
await import('../lib/client.js')
delete globalThis.window
assert.ok(definition, '客户端半没有调用 window.__ModuleLoader__.load')
const loadClientHalf = (options = {}) => definition.factory((specifier) => {
  if (specifier === 'react') return React
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') {
    if (options.noPrimitives === true) throw new Error('module not found')
    return primitives
  }
  return undefined
})

/** 桩 ctx：捕获槽注册、locale、以及设置表单（scope）的写入。 */
function stubCtx(over = {}) {
  const calls = { mutate: [], registered: [], locales: [] }
  const snapshot = {
    status: 'ready',
    writable: true,
    revision: 7,
    value: { enabled: true },
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
      bind: (ns) => (key) => key,
    },
    configForms: {
      get: (id) => { calls.get = id; if (over.getThrows) throw new Error('not served'); return scope },
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
/** 按平台的方式把卡片 Props 组起来：槽 inject 的门面 + 平台注入的 t / view。 */
function cardProps(entry, view = 'page') {
  return { ...entry.options.inject(), view, t: (key) => key }
}

test('客户端半：导出 apply/inject，inject 只要三个服务', () => {
  const mod = loadClientHalf()
  assert.equal(typeof mod.apply, 'function')
  assert.deepEqual(mod.inject, ['slots', 'locale', 'configForms'])
})

test('注册两个座位：settings.section（本部署真正渲染的）与 plugins.row.config', () => {
  const mod = loadClientHalf()
  const { ctx, calls } = stubCtx()
  mod.apply(ctx)
  assert.equal(calls.get, 'dsh-hot-reloader')
  assert.equal(calls.registered.length, 2)
  const section = sectionOf(calls)
  assert.ok(section, '必须注册 settings.section —— 本部署不渲染 plugins.row.config')
  assert.equal(section.options.id, 'hot-reloader')
  assert.equal(typeof section.options.order, 'number')
  assert.equal(section.options.locale, mod.NS)
  assert.equal(typeof section.options.label, 'function')
  assert.equal(section.options.label(), 'title')
  assert.equal(typeof section.component, 'function')
  const rowConfig = rowConfigOf(calls)
  assert.equal(rowConfig.options.key, 'dsh-hot-reloader#dsh-hot-reloader')
  assert.deepEqual(calls.whileServed, ['dsh-hot-reloader'])
  assert.ok(calls.locales.some((row) => row.ns === mod.NS && row.dicts.zh && row.dicts.en), '应注册中英词典')
})

test('摘要视图：插件页列表里那一行返回摘要文案', () => {
  const mod = loadClientHalf()
  const { ctx, calls } = stubCtx()
  mod.apply(ctx)
  assert.equal(sectionOf(calls).component(cardProps(sectionOf(calls), 'summary')), 'summary')
})

test('卡片渲染：开关勾选态来自宿主快照，标签走词典', () => {
  const mod = loadClientHalf()
  const { ctx, calls } = stubCtx()
  mod.apply(ctx)
  const tree = sectionOf(calls).component(cardProps(sectionOf(calls)))
  const checkbox = tree.props.children[0].props.children[0]
  assert.equal(checkbox.type, primitives.Checkbox)
  assert.equal(checkbox.props.checked, true)
  assert.equal(checkbox.props.disabled, false)
  assert.equal(checkbox.props.label, 'autoReload')
})

test('拨动开关：走平台的带 revision 栅栏写入（op=set path=[enabled]）', async () => {
  const mod = loadClientHalf()
  const { ctx, calls } = stubCtx()
  mod.apply(ctx)
  await cardProps(sectionOf(calls)).setEnabled(false)
  assert.deepEqual(calls.mutate, [{ ops: [{ op: 'set', path: ['enabled'], value: false }], revision: 7 }])
})

test('宿主没服务该行：安静退出，不注册任何槽', () => {
  const mod = loadClientHalf()
  const { ctx, calls } = stubCtx({ getThrows: true })
  assert.doesNotThrow(() => mod.apply(ctx))
  assert.equal(calls.registered.length, 0)
})

test('写入被宿主拒绝：卡片出现失败提示，不假装成功', async () => {
  const mod = loadClientHalf()
  const { ctx, calls } = stubCtx({ mutateAccepts: false })
  mod.apply(ctx)
  await cardProps(sectionOf(calls)).setEnabled(false)
  const keys = sectionOf(calls).component(cardProps(sectionOf(calls))).props.children.map((child) => child.props.key)
  assert.ok(keys.includes('failed'), '被拒绝时应有失败提示：' + JSON.stringify(keys))
})

test('卡片在拿不到 hooks 糖时也能渲染（自己订阅 store）', () => {
  const mod = loadClientHalf()
  const { ctx, calls } = stubCtx()
  mod.apply(ctx)
  const face = sectionOf(calls).options.inject()
  assert.equal(typeof face.snapshot, 'function')
  assert.equal(typeof face.subscribe, 'function')
  const tree = sectionOf(calls).component({ ...face, t: (key) => key })
  assert.equal(tree.type, 'div')
})
test('拿不到首方 primitives 时回落到纯 DOM input（卡片仍然可渲染）', () => {
  const mod = loadClientHalf({ noPrimitives: true })
  const { ctx, calls } = stubCtx()
  mod.apply(ctx)
  const tree = sectionOf(calls).component(cardProps(sectionOf(calls)))
  const label = tree.props.children[0].props.children[0]
  assert.equal(label.type, 'label')
  const input = label.props.children[0]
  assert.equal(input.type, 'input')
  assert.equal(input.props.checked, true)
})

test('注册的是兜底组件：渲染抛错时输出可见的错误文字，而不是空白', () => {
  const mod = loadClientHalf()
  const { ctx, calls } = stubCtx()
  mod.apply(ctx)
  const entry = sectionOf(calls)
  assert.equal(entry.component, mod.__internals.HotReloadCardSafe)
  // 传入会让渲染抛错的 props（snapshot 抛）
  const broken = { ...entry.options.inject(), t: (key) => key, snapshot: () => { throw new Error('boom') } }
  const tree = entry.component(broken)
  const text = JSON.stringify(tree)
  assert.match(text, /card error/)
  assert.match(text, /boom/)
})
