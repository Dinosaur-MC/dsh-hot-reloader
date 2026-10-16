import test from 'node:test'
import assert from 'node:assert/strict'
import { pluginShape } from '../lib/index.js'

const z = { fake: 'schemastery' }

test('pluginShape：对象形状带 Config 时必须原样带过去', () => {
  const apply = function apply() {}
  const shaped = pluginShape({ name: 'x', inject: ['loader'], Config: z, apply }, ['loader'])
  assert.equal(shaped.Config, z, '丢了 Config ⇒ 宿主 SettingsForms 认为该插件不可配置、设置页里会消失')
  assert.deepEqual(shaped.inject, ['loader'])
  assert.equal(shaped.apply, apply)
})

test('pluginShape：函数形状用 fallbackConfig 补 Config', () => {
  const fn = function fast() {}
  const shaped = pluginShape(fn, ['loader'], z)
  assert.equal(shaped.Config, z)
  assert.deepEqual(shaped.inject, ['loader'])
  assert.equal(shaped.apply, fn)
})

test('pluginShape：对象自带的 Config 优先于 fallback', () => {
  const own = { own: true }
  const shaped = pluginShape({ inject: ['a'], Config: own, apply() {} }, ['a'], z)
  assert.equal(shaped.Config, own)
})

test('pluginShape：既无 inject 也无 Config 时原样返回（不做无谓包装）', () => {
  const fn = function f() {}
  assert.equal(pluginShape(fn, [], undefined), fn)
})

test('pluginShape：只有 Config、inject 为空时也要包装出 Config', () => {
  const fn = function f() {}
  const shaped = pluginShape(fn, [], z)
  assert.equal(shaped.Config, z)
  assert.equal(shaped.inject, undefined)
})
