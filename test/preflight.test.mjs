import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkSnapshot, extensionOf, isCheckable } from '../lib/preflight.js'

function workspace() {
  return mkdtempSync(join(tmpdir(), 'hr-preflight-'))
}

test('extensionOf / isCheckable：只认 js 与 json', () => {
  assert.equal(extensionOf('/a/b/c.MJS'), '.mjs')
  assert.equal(isCheckable('/a/x.js'), true)
  assert.equal(isCheckable('/a/x.json'), true)
  assert.equal(isCheckable('/a/x.md'), false)
})

test('checkSnapshot：正常 CJS + ESM + JSON 全部通过', async () => {
  const dir = workspace()
  const cjs = join(dir, 'ok.cjs')
  const esm = join(dir, 'ok.mjs')
  const json = join(dir, 'ok.json')
  writeFileSync(cjs, 'module.exports = 1\n')
  writeFileSync(esm, 'export const a = 1\nexport default function f() {}\n')
  writeFileSync(json, '{"a":1}\n')
  const report = await checkSnapshot([cjs, esm, json], { settleMs: 0 })
  assert.equal(report.ok, true, JSON.stringify(report.problems))
  assert.equal(report.checked, 3)
})

test('checkSnapshot：ESM 语法错误会被拒绝', async () => {
  const dir = workspace()
  const bad = join(dir, 'bad.mjs')
  writeFileSync(bad, 'export const a = (\n')
  const report = await checkSnapshot([bad], { settleMs: 0 })
  assert.equal(report.ok, false)
  assert.equal(report.problems[0].code, 'syntax')
  assert.match(report.problems[0].message, /./)
})

test('checkSnapshot：JSON 语法错误会被拒绝', async () => {
  const dir = workspace()
  const bad = join(dir, 'bad.json')
  writeFileSync(bad, '{"a":}\n')
  const report = await checkSnapshot([bad], { settleMs: 0 })
  assert.equal(report.ok, false)
  assert.equal(report.problems[0].code, 'syntax')
})

test('checkSnapshot：空文件判为截断（且可重试）', async () => {
  const dir = workspace()
  const empty = join(dir, 'empty.js')
  writeFileSync(empty, '')
  const report = await checkSnapshot([empty], { settleMs: 0 })
  assert.equal(report.ok, false)
  assert.equal(report.problems[0].code, 'empty')
  assert.equal(report.retryable, true)
})

test('checkSnapshot：mtime 太新判为「还在写」', async () => {
  const dir = workspace()
  const fresh = join(dir, 'fresh.js')
  writeFileSync(fresh, 'export const a = 1\n')
  const report = await checkSnapshot([fresh], { settleMs: 60_000 })
  assert.equal(report.ok, false)
  assert.equal(report.problems[0].code, 'unsettled')
  assert.equal(report.retryable, true)
})

test('checkSnapshot：非 js/json 与超大文件跳过而不是失败', async () => {
  const dir = workspace()
  const md = join(dir, 'notes.md')
  const big = join(dir, 'big.js')
  writeFileSync(md, '# hi\n')
  writeFileSync(big, 'x'.repeat(2048))
  const report = await checkSnapshot([md, big], { settleMs: 0, maxBytes: 1024 })
  assert.equal(report.ok, true)
  assert.equal(report.skipped.length, 2)
})

test('checkSnapshot：超过 maxFiles 的条目进 skipped 而不是被静默丢掉', async () => {
  const dir = workspace()
  const files = ['a.js', 'b.js', 'c.js'].map((name) => {
    const file = join(dir, name)
    writeFileSync(file, 'export const x = 1\n')
    return file
  })
  const report = await checkSnapshot(files, { settleMs: 0, maxFiles: 2 })
  assert.equal(report.ok, true)
  assert.equal(report.skipped.length, 1)
  assert.equal(report.checked, 2)
})