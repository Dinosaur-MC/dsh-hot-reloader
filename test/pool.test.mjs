import test from 'node:test'
import assert from 'node:assert/strict'
import { clampConcurrency, runPool } from '../lib/pool.js'

test('clampConcurrency：非法/过小回落到 1，过大被压到上限', () => {
  assert.equal(clampConcurrency(undefined), 1)
  assert.equal(clampConcurrency(0), 1)
  assert.equal(clampConcurrency(-3), 1)
  assert.equal(clampConcurrency('abc'), 1)
  assert.equal(clampConcurrency(2.9), 2)
  assert.equal(clampConcurrency(99), 8)
})

test('runPool：结果与输入同序（即使完成顺序相反）', async () => {
  const items = [30, 10, 20]
  const out = await runPool(items, 3, async (ms) => {
    await new Promise((resolve) => setTimeout(resolve, ms))
    return ms
  })
  assert.deepEqual(out, [30, 10, 20])
})

test('runPool：并发不超过上限', async () => {
  let inFlight = 0
  let peak = 0
  const items = Array.from({ length: 8 }, (_, i) => i)
  await runPool(items, 3, async () => {
    inFlight += 1
    peak = Math.max(peak, inFlight)
    await new Promise((resolve) => setTimeout(resolve, 10))
    inFlight -= 1
  })
  assert.equal(peak, 3)
})

test('runPool：limit=1 退化为严格串行', async () => {
  const order = []
  await runPool([1, 2, 3], 1, async (n) => {
    order.push(n)
    await new Promise((resolve) => setTimeout(resolve, 5))
  })
  assert.deepEqual(order, [1, 2, 3])
})

test('runPool：空输入直接返回空数组', async () => {
  assert.deepEqual(await runPool([], 4, async () => 1), [])
  assert.deepEqual(await runPool(undefined, 4, async () => 1), [])
})

test('runPool：每个元素只被执行一次', async () => {
  const seen = []
  const items = Array.from({ length: 20 }, (_, i) => i)
  await runPool(items, 5, async (n) => { seen.push(n) })
  assert.equal(seen.length, 20)
  assert.equal(new Set(seen).size, 20)
})