import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import {
  findVersionMoves,
  isWithin,
  matchTargetsByPackageName,
  normalizePathForCompare,
  projectPackageNames,
  readPackageName,
  resolveTargets,
} from '../lib/targets.js'

const BASE = path.join(os.tmpdir(), 'hot-reloader-targets-test')
const WS = path.join(BASE, 'ws')
const OUTSIDE = path.join(BASE, 'outside')
const p = (...parts) => path.join(...parts)

/** 三个假目标：两个在工作区内，一个在区外；其中一个同时挂两个 entry。 */
function fakeTargets() {
  return [
    { pkgName: 'dsh-our-free-model', root: p(WS, 'projects', '.thirdparty', 'dsh-our-free-model'), entries: [{ specifier: 'dsh-our-free-model' }] },
    { pkgName: 'dsh-onebot-qq', root: p(WS, 'pkg', 'dsh-onebot-qq'), entries: [
      { specifier: 'dsh-onebot-qq' },
      { specifier: 'dsh-onebot-qq/settings-remote' },
    ] },
    { pkgName: 'dsh-decision-tools', root: p(OUTSIDE, 'dsh-decision-tools'), entries: [{ specifier: 'dsh-decision-tools' }] },
  ]
}

const opts = (over = {}) => ({ selectors: [], workspace: WS, targets: fakeTargets(), allowForeign: false, ...over })
const names = (r) => r.matched.map((m) => m.target.pkgName).sort()
const reasons = (r) => r.skipped.map((s) => `${s.pkg}:${s.reason}`).sort()

test('isWithin：自身、子树为真；父级与兄弟为假', () => {
  assert.equal(isWithin(WS, WS), true)
  assert.equal(isWithin(WS, p(WS, 'a', 'b')), true)
  assert.equal(isWithin(p(WS, 'a'), WS), false)
  assert.equal(isWithin(p(WS, 'a'), p(WS, 'b')), false)
})

test('normalizePathForCompare：相对路径按基准解析，不存在也不抛', () => {
  assert.equal(normalizePathForCompare('a/b', WS), p(WS, 'a', 'b'))
  assert.equal(normalizePathForCompare(undefined, WS), undefined)
})

test('空选择器：等价于 workspace（未选中的区外目标不算被拦，只不入选）', () => {
  const r = resolveTargets(opts())
  assert.deepEqual(names(r), ['dsh-onebot-qq', 'dsh-our-free-model'])
  assert.deepEqual(reasons(r), [])
})

test('显式点名区外目标但未放行：记 outside-workspace', () => {
  const r = resolveTargets(opts({ selectors: ['dsh-decision-tools'] }))
  assert.deepEqual(names(r), [])
  assert.deepEqual(reasons(r), ['dsh-decision-tools:outside-workspace'])
})

test('workspace 关键字：只命中工作区内的目标', () => {
  const r = resolveTargets(opts({ selectors: ['workspace'] }))
  assert.deepEqual(names(r), ['dsh-onebot-qq', 'dsh-our-free-model'])
  assert.equal(r.matched[0].how, 'keyword')
})

test('all 关键字：未放行时区外目标仍被拦下', () => {
  const blocked = resolveTargets(opts({ selectors: ['all'] }))
  assert.deepEqual(names(blocked), ['dsh-onebot-qq', 'dsh-our-free-model'])
  assert.deepEqual(reasons(blocked), ['dsh-decision-tools:outside-workspace'])
  const allowed = resolveTargets(opts({ selectors: ['all'], allowForeign: true }))
  assert.deepEqual(names(allowed), ['dsh-decision-tools', 'dsh-onebot-qq', 'dsh-our-free-model'])
})

test('路径选择器：包内文件命中其包根', () => {
  const file = p(WS, 'pkg', 'dsh-onebot-qq', 'lib', 'split.js')
  const r = resolveTargets(opts({ selectors: [file] }))
  assert.deepEqual(names(r), ['dsh-onebot-qq'])
  assert.equal(r.matched[0].how, 'path')
})

test('路径选择器：目录选择器命中其下所有目标；相对路径按工作区解析', () => {
  const r = resolveTargets(opts({ selectors: [p(WS, 'projects')] }))
  assert.deepEqual(names(r), ['dsh-our-free-model'])
  const rel = resolveTargets(opts({ selectors: ['pkg/dsh-onebot-qq'] }))
  assert.deepEqual(names(rel), ['dsh-onebot-qq'])
})

test('路径选择器：反斜杠与正斜杠、盘符大小写都等价', () => {
  const windowsStyle = p(WS, 'pkg', 'dsh-onebot-qq').replace(/\//g, '\\')
  assert.deepEqual(names(resolveTargets(opts({ selectors: [windowsStyle] }))), ['dsh-onebot-qq'])
  if (process.platform === 'win32') {
    const upper = (WS + '\\PKG\\DSH-ONEBOT-QQ').toUpperCase()
    assert.deepEqual(names(resolveTargets(opts({ selectors: [upper] }))), ['dsh-onebot-qq'])
  }
})

test('包名选择器：匹配 specifier 与子路径 entry', () => {
  assert.deepEqual(names(resolveTargets(opts({ selectors: ['dsh-onebot-qq'] }))), ['dsh-onebot-qq'])
  assert.deepEqual(names(resolveTargets(opts({ selectors: ['dsh-onebot-qq/settings-remote'] }))), ['dsh-onebot-qq'])
  assert.deepEqual(names(resolveTargets(opts({ selectors: ['dsh-decision-tools'], allowForeign: true }))), ['dsh-decision-tools'])
})

test('命中自身记 self（默认拒绝重载本插件）', () => {
  const selfRoot = p(WS, 'pkg', 'dsh-onebot-qq')
  const r = resolveTargets(opts({ selectors: ['dsh-onebot-qq'], selfRoot }))
  assert.deepEqual(names(r), [])
  assert.deepEqual(reasons(r), ['dsh-onebot-qq:self'])
})

test('未知选择器记 no-match，且不影响其它选择器', () => {
  const r = resolveTargets(opts({ selectors: ['dsh-nope', 'dsh-onebot-qq'] }))
  assert.deepEqual(names(r), ['dsh-onebot-qq'])
  assert.deepEqual(reasons(r), ['dsh-nope:no-match'])
})

test('同一目标被多个选择器命中只出现一次', () => {
  const r = resolveTargets(opts({ selectors: ['dsh-onebot-qq', p(WS, 'pkg', 'dsh-onebot-qq')] }))
  assert.deepEqual(names(r), ['dsh-onebot-qq'])
  assert.equal(r.matched.length, 1)
})
test('findVersionMoves：同键换包根 = 版本切换', () => {
  const prev = new Map([['pkg-a', 'C:/p/pnpm/pkg-a@1.0.0/node_modules/pkg-a']])
  const rows = [{ key: 'pkg-a', root: 'C:/p/pnpm/pkg-a@1.1.0/node_modules/pkg-a' }]
  const moved = findVersionMoves(prev, rows)
  assert.deepEqual(moved.get('pkg-a'), { from: 'C:/p/pnpm/pkg-a@1.0.0/node_modules/pkg-a', to: 'C:/p/pnpm/pkg-a@1.1.0/node_modules/pkg-a' })
})

test('findVersionMoves：包根没变时不算迁移', () => {
  const prev = new Map([['pkg-a', '/r']])
  assert.equal(findVersionMoves(prev, [{ key: 'pkg-a', root: '/r' }]).size, 0)
})

test('findVersionMoves：首次见到的键不算迁移（新装插件不能误判）', () => {
  assert.equal(findVersionMoves(new Map(), [{ key: 'pkg-b', root: '/x' }]).size, 0)
})

test('findVersionMoves：缺参照物或无键的行都跳过', () => {
  assert.equal(findVersionMoves(undefined, [{ key: 'pkg-a', root: '/r' }]).size, 0)
  assert.equal(findVersionMoves(new Map([['pkg-a', '/r']]), [{ key: '', root: '/r' }]).size, 0)
  assert.equal(findVersionMoves(new Map([['pkg-a', '/r']]), [{ root: '/r' }]).size, 0)
})
test('projectPackageNames：深度优先找包名，跳过 node_modules，尊重上限', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hr-proj-'))
  const makePkg = (rel, name) => {
    const dir = path.join(root, rel)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name }), 'utf8')
  }
  makePkg('a', 'pkg-a')
  makePkg(path.join('deep', 'b'), 'pkg-b')
  makePkg(path.join('node_modules', 'c'), 'pkg-hidden')
  const names = projectPackageNames(root)
  assert.ok(names.has('pkg-a'))
  assert.ok(names.has('pkg-b'), '深层目录里的包也要找到')
  assert.equal(names.has('pkg-hidden'), false, 'node_modules 要跳过')
  const shallow = projectPackageNames(root, { maxDepth: 1 })
  assert.equal(shallow.has('pkg-b'), false, '受 maxDepth 约束')
})

test('matchTargetsByPackageName：按 manifest 名或 pkgName 裸名匹配已加载目标', () => {
  const names = new Set(['dsh-alpha', 'dsh-beta'])
  const targets = [
    { pkgName: 'dsh-alpha', root: 'C:\\p\\dsh-alpha', packageName: 'dsh-alpha' },
    { pkgName: 'dsh-beta/sub', root: 'C:\\p\\dsh-beta' },
    { pkgName: 'dsh-gamma', root: 'C:\\p\\dsh-gamma', packageName: 'dsh-gamma' },
  ]
  const hit = matchTargetsByPackageName(targets, names).map((item) => item.pkgName)
  assert.deepEqual(hit, ['dsh-alpha', 'dsh-beta/sub'], '子路径 entry 用裸名匹配')
  assert.deepEqual(matchTargetsByPackageName(targets, new Set()), [])
  assert.deepEqual(matchTargetsByPackageName(targets, undefined), [])
})

test('readPackageName：读不到返回 undefined', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hr-pkg-'))
  assert.equal(readPackageName(root), undefined)
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'x-y' }), 'utf8')
  assert.equal(readPackageName(root), 'x-y')
  assert.equal(readPackageName(''), undefined)
})
