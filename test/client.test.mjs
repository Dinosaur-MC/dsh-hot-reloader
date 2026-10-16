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
const primitives = { Checkbox: 'Checkbox', Button: 'Button' }

/**
 * 客户端半是 `window.__ModuleLoader__.load({id, factory})` 形状；ESM 有缓存，只能 import 一次。
 * 之后每个用例调用 factory 重新拿一份全新的 exports（factory 每次执行都会重建内部状态）。
 */
let definition
globalThis.window = { __ModuleLoader__: { load: (value) => { definition = value } } }
await import('../lib/client.js')
delete globalThis.window
assert.ok(definition, '客户端半没有调用 window.__ModuleLoader__.load')
const loadClientHalf = () => definition.factory((specifier) =>
  specifier === 'react' ? React : specifier === '@deepseek-ai/dsh-client-ui-primitives' ? primitives : undefined)

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
    locale: { register: (ns, dicts) => { calls.locales.push({ ns, dicts }); return () => {} } },
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

/** 按平台的方式把卡片 Props 组起来：槽 inject 的门面 + 平台注入的 t / view / useRowForm。 */
function cardProps(calls, view = 'page') {
  const face = calls.registered[0].options.inject()
  return {
    ...face,
    view,
    t: (key) => key,
    useRowForm: (select) => select(face.hooks.rowForm.getSnapshot()),
  }
}

test('客户端半：导出 apply/inject，inject 只要三个服务', () => {
  const mod = loadClientHalf()
  assert.equal(typeof mod.apply, 'function')
  assert.deepEqual(mod.inject, ['slots', 'locale', 'configForms'])
})

test('注册：行键是 <包名>#<行 id>，只挂在 plugins.row.config 槽上', () => {
  const mod = loadClientHalf()
  const { ctx, calls } = stubCtx()
  mod.apply(ctx)
  assert.equal(calls.get, 'dsh-hot-reloader')
  assert.deepEqual(calls.whileServed, ['dsh-hot-reloader'])
  assert.equal(calls.registered.length, 1)
  const { options, component } = calls.registered[0]
  assert.equal(options.name, 'plugins.row.config')
  assert.equal(options.key, 'dsh-hot-reloader#dsh-hot-reloader')
  assert.equal(options.locale, mod.NS)
  assert.equal(typeof component, 'function')
  assert.ok(calls.locales.some((row) => row.ns === mod.NS && row.dicts.zh && row.dicts.en), '应注册中英词典')
})

test('摘要视图：插件页列表里那一行返回摘要文案', () => {
  const mod = loadClientHalf()
  const { ctx, calls } = stubCtx()
  mod.apply(ctx)
  assert.equal(calls.registered[0].component(cardProps(calls, 'summary')), 'summary')
})

test('卡片渲染：开关勾选态来自宿主快照，标签走词典', () => {
  const mod = loadClientHalf()
  const { ctx, calls } = stubCtx()
  mod.apply(ctx)
  const tree = calls.registered[0].component(cardProps(calls))
  const checkbox = tree.props.children[0].props.children[0]
  assert.equal(checkbox.type, 'Checkbox')
  assert.equal(checkbox.props.checked, true)
  assert.equal(checkbox.props.disabled, false)
  assert.equal(checkbox.props.label, 'autoReload')
})

test('拨动开关：走平台的带 revision 栅栏写入（op=set path=[enabled]）', async () => {
  const mod = loadClientHalf()
  const { ctx, calls } = stubCtx()
  mod.apply(ctx)
  await cardProps(calls).setEnabled(false)
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
  await cardProps(calls).setEnabled(false)
  // React 桩把 key 留在 props 里（真 React 会把它抽走），断言读 props.key。
  const keys = calls.registered[0].component(cardProps(calls)).props.children.map((child) => child.props.key)
  assert.ok(keys.includes('failed'), '被拒绝时应有失败提示：' + JSON.stringify(keys))
})
