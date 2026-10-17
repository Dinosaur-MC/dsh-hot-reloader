import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_SNAPSHOT_BYTES, diffSnapshots, parseSnapshot, serializeSnapshot } from '../lib/snapshot.js'

const mk = (entries) => new Map(entries.map(([root, files]) => [root, new Map(files)]))

test('serialize → parse 往返一致', () => {
  const before = mk([['F:/ws/pkg-a', [['/a/index.js', '1:10'], ['/a/lib/x.js', '2:20']]]])
  const after = parseSnapshot(serializeSnapshot(before))
  assert.equal(after.size, 1)
  assert.deepEqual([...after.get('F:/ws/pkg-a')], [['/a/index.js', '1:10'], ['/a/lib/x.js', '2:20']])
})

test('parse 容错：空/垃圾/版本不符/超限 一律返回 undefined', () => {
  assert.equal(parseSnapshot(''), undefined)
  assert.equal(parseSnapshot(undefined), undefined)
  assert.equal(parseSnapshot('{ 半截'), undefined)
  assert.equal(parseSnapshot(JSON.stringify({ version: 99, roots: {} })), undefined)
  assert.equal(parseSnapshot(JSON.stringify({ version: 1, roots: null })), undefined)
  assert.equal(parseSnapshot('x'.repeat(MAX_SNAPSHOT_BYTES + 1)), undefined)
})

test('parse 丢弃非法条目而不是整体失败', () => {
  const text = JSON.stringify({ version: 1, at: 1, roots: { '/r': { '/r/a.js': '1:1', '/r/bad.js': 7 }, '': { '/x': '1:1' } } })
  const parsed = parseSnapshot(text)
  assert.deepEqual([...parsed.keys()], ['/r'])
  assert.deepEqual([...parsed.get('/r')], [['/r/a.js', '1:1']])
})

test('diffSnapshots：改过 / 新增 / 删除 都算改动', () => {
  const before = mk([['/r', [['/r/a.js', '1:1'], ['/r/b.js', '2:2'], ['/r/gone.js', '3:3']]]])
  const after = mk([['/r', [['/r/a.js', '9:9'], ['/r/b.js', '2:2'], ['/r/new.js', '4:4']]]])
  const changed = diffSnapshots(before, after)
  assert.deepEqual(changed.get('/r').sort(), ['/r/a.js', '/r/gone.js', '/r/new.js'])
})

test('diffSnapshots：完全一致时没有条目', () => {
  const same = mk([['/r', [['/r/a.js', '1:1']]]])
  assert.equal(diffSnapshots(same, same).size, 0)
})

test('diffSnapshots：快照里没有的包根（新装插件）不参与比较', () => {
  const before = mk([['/old', [['/old/a.js', '1:1']]]])
  const after = mk([['/old', [['/old/a.js', '1:1']]], ['/new', [['/new/a.js', '1:1']]]])
  assert.equal(diffSnapshots(before, after).size, 0)
})

test('diffSnapshots：缺失参照物时返回空（不能把整包当改动）', () => {
  const after = mk([['/r', [['/r/a.js', '1:1']]]])
  assert.equal(diffSnapshots(undefined, after).size, 0)
})