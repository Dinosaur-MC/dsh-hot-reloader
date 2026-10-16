import test from 'node:test'
import assert from 'node:assert/strict'
import { createSettingsBridge } from '../lib/settings-bridge.js'

const ENTRY = 'dsh-hot-reloader'

/** 桩 settings 服务：只实现 bridge 用到的 describe/update。 */
function stubService(over = {}) {
  const calls = { updates: [] }
  const service = {
    describe() {
      if (over.describeThrows) throw new Error('describe blew up')
      return over.descriptors ?? [{ ns: ENTRY, revision: 3, value: { enabled: true } }]
    },
    async update(ns, patch, revision) {
      calls.updates.push({ ns, patch, revision })
      if (over.conflict) {
        const error = new Error(`settings namespace "${ns}" changed since it was read (expected revision ${revision}, now 9)`)
        error.name = 'SettingsConflictError'
        error.actual = 9
        throw error
      }
      if (over.updateThrows) throw new Error('disk full')
      return undefined
    },
  }
  return { service, calls }
}

const bridgeFor = (over = {}, entryId = ENTRY) => {
  const { service, calls } = stubService(over)
  const bridge = createSettingsBridge({
    getService: () => (over.noService ? undefined : service),
    entryId,
    logger: { warn() {}, info() {} },
  })
  return { bridge, calls }
}

test('available()：服务缺失时为 false', () => {
  assert.equal(bridgeFor({ noService: true }).bridge.available(), false)
  assert.equal(bridgeFor().bridge.available(), true)
})

test('write：把 enabled 写进该条目并带上 describe 的 revision', async () => {
  const { bridge, calls } = bridgeFor()
  const result = await bridge.write({ enabled: false })
  assert.deepEqual(result, { ok: true, enabled: false, entryId: ENTRY })
  assert.deepEqual(calls.updates, [{ ns: ENTRY, patch: { enabled: false }, revision: 3 }])
})

test('write：enabled=null 视为恢复默认（写回 schema 默认值 true）', async () => {
  const { bridge, calls } = bridgeFor()
  const result = await bridge.write({ enabled: null })
  assert.deepEqual(result, { ok: true, enabled: true, entryId: ENTRY })
  assert.deepEqual(calls.updates[0].patch, { enabled: true })
})

test('write：服务缺失时返回显式错误，不抛', async () => {
  const { bridge } = bridgeFor({ noService: true })
  assert.deepEqual(await bridge.write({ enabled: false }), { ok: false, error: 'settings-unavailable' })
})

test('write：条目不在可配置列表里 → not-configurable', async () => {
  const { bridge } = bridgeFor({ descriptors: [{ ns: 'other-plugin', revision: 1 }] })
  assert.deepEqual(await bridge.write({ enabled: false }), { ok: false, error: 'not-configurable', entryId: ENTRY })
})

test('write：版本冲突 → conflict，带最新 revision', async () => {
  const { bridge } = bridgeFor({ conflict: true })
  assert.deepEqual(await bridge.write({ enabled: false }), { ok: false, error: 'conflict', entryId: ENTRY, revision: 9 })
})

test('write：其它异常 → write-failed，带 message', async () => {
  const { bridge } = bridgeFor({ updateThrows: true })
  const result = await bridge.write({ enabled: false })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'write-failed')
  assert.match(result.message, /disk full/)
})

test('entryId 可以是函数（从 loader 树里现取）', async () => {
  const { bridge, calls } = bridgeFor({}, () => ENTRY)
  assert.deepEqual(await bridge.write({ enabled: true }), { ok: true, enabled: true, entryId: ENTRY })
  assert.equal(calls.updates[0].ns, ENTRY)
})

test('entryId 取不到时 → entry-not-found，且不调 update', async () => {
  const { bridge, calls } = bridgeFor({}, () => undefined)
  assert.deepEqual(await bridge.write({ enabled: false }), { ok: false, error: 'entry-not-found' })
  assert.equal(calls.updates.length, 0)
})

test('readEnabled()：从 describe 的 value 读当前持久值', () => {
  assert.equal(bridgeFor().bridge.readEnabled(), true)
  const { bridge } = bridgeFor({ descriptors: [{ ns: ENTRY, revision: 1, value: { enabled: false } }] })
  assert.equal(bridge.readEnabled(), false)
  const missing = bridgeFor({ descriptors: [{ ns: 'other', revision: 1 }] }).bridge
  assert.equal(missing.readEnabled(), undefined)
})
