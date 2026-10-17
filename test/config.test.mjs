import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULTS, Config, unwrapVolatile, makeConfigReader } from '../lib/config.js'

test('unwrapVolatile：普通值原样返回', () => {
  assert.equal(unwrapVolatile('x'), 'x')
  assert.equal(unwrapVolatile(0), 0)
  assert.equal(unwrapVolatile(false), false)
  assert.equal(unwrapVolatile(null), null)
  assert.equal(unwrapVolatile(undefined), undefined)
})

test('unwrapVolatile：解包 get() 引用', () => {
  assert.equal(unwrapVolatile({ get: () => 5 }), 5)
})

test('unwrapVolatile：嵌套引用逐层解包', () => {
  const value = { a: { get: () => ({ b: { get: () => 1 } }) } }
  assert.deepEqual(unwrapVolatile(value), { a: { b: 1 } })
})

test('unwrapVolatile：数组内的引用也解包', () => {
  assert.deepEqual(unwrapVolatile([{ get: () => 1 }, 'x', [{ get: () => 2 }]]), [1, 'x', [2]])
})

test('makeConfigReader：缺字段回落默认值', () => {
  const read = makeConfigReader({})
  assert.deepEqual(read(), { ...DEFAULTS })
})

test('makeConfigReader：显式 false / 0 / 空数组不被默认值吃掉', () => {
  const read = makeConfigReader({ enabled: false, intervalMs: 0, only: [], quiet: false })
  const cfg = read()
  assert.equal(cfg.enabled, false)
  assert.equal(cfg.intervalMs, 0)
  assert.deepEqual(cfg.only, [])
  assert.equal(cfg.quiet, false)
})

test('makeConfigReader：显式 undefined 不覆盖默认值', () => {
  const read = makeConfigReader({ enabled: undefined, maxDepth: undefined })
  const cfg = read()
  assert.equal(cfg.enabled, true)
  assert.equal(cfg.maxDepth, 8)
})

test('makeConfigReader：运行期读取（volatile 改动立刻可见）', () => {
  const ref = { value: true, get() { return this.value } }
  const read = makeConfigReader({ enabled: ref })
  assert.equal(read().enabled, true)
  ref.value = false
  assert.equal(read().enabled, false)
})

/** schemastery 的对象 schema 把子节点挂在 .dict 上（dsh-settings 也这么读）。 */
const dictOf = (schema) => schema?.dict ?? schema?.meta?.dict ?? {}

test('Config：已导出且只把选定的字段标为 volatile', () => {
  assert.notEqual(Config, undefined, 'Config 未导出：peer 解析或 schemastery.volatile() 不可用')
  const dict = dictOf(Config)
  assert.equal(dict.enabled?.meta?.volatile, true)
  assert.equal(dict.quiet?.meta?.volatile, true)
  assert.equal(dict.allowForeignTargets?.meta?.volatile, true)
  assert.equal(dict.intervalMs?.meta?.volatile, true, 'intervalMs 每轮 tick 前重读 ⇒ 标 volatile，改间隔不必重启宿主')
  assert.equal(dict.checkStrict?.meta?.volatile, true)
  assert.equal(dict.strictCommands?.meta?.volatile, true)
  assert.equal(dict.reloadConcurrency?.meta?.volatile, true)
  assert.equal(dict.reloadSelf?.meta?.volatile, true, 'reloadSelf 每轮扫描都重读 ⇒ 标 volatile，GUI 开关才写得进去')
})

test('Config：schema 覆盖全部 DEFAULTS 键（否则被 cordis 裁掉）', () => {
  const dict = dictOf(Config)
  for (const key of Object.keys(DEFAULTS)) {
    assert.ok(Object.hasOwn(dict, key), `DEFAULTS 的 ${key} 未写进 Config schema`)
  }
})

test('Config：解析时补默认值并保留显式值', () => {
  const resolved = unwrapVolatile(Config({ only: ['a'], enabled: false }))
  assert.equal(resolved.enabled, false)
  assert.deepEqual(resolved.only, ['a'])
  assert.equal(resolved.maxDepth, 8)
  assert.equal(resolved.allowForeignTargets, false)
})
