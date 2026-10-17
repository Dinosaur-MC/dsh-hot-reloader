/**
 * 重载前的「快照体检」：把不完整 / 有语法错误的改动挡在重载之外。
 *
 * 为什么需要：编辑器保存是「截断-重写」，扫描与重载之间随时可能读到半截文件；直接 import
 * 半截文件会把正在正常工作的插件顶掉。宁可这次不重载，也不要换上一个坏的。
 *
 * 三条判据（都很便宜）：
 *   1. 写入未稳定：文件 mtime 距现在 < settleMs ⇒ 还在写，先拒绝（可稍后重试）。
 *   2. 明显截断：大小为 0 ⇒ 拒绝。
 *   3. 语法错误：.json 用 JSON.parse；.js/.mjs/.cjs 用 vm.SourceTextModule **只解析不执行**；
 *      整批交给一个 node 子进程，避免每文件一次 spawn。
 *
 * 不做的：类型检查、lint、依赖图校验 —— 都太慢，不适合每次保存都跑。
 */
import { readFileSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

export const DEFAULT_LIMITS = { settleMs: 150, maxBytes: 2 * 1024 * 1024, maxFiles: 200, timeoutMs: 4000 }
export const CHECKABLE_EXTENSIONS = ['.js', '.mjs', '.cjs', '.json']

/** 解析器脚本：一次进程内把整批当 ESM 解析（SourceTextModule 构造时即解析，不执行）。 */
const PARSER_SCRIPT = [
  "const vm=require('node:vm'),fs=require('node:fs');const out=[];",
  "for(const f of process.argv.slice(1)){",
  "try{new vm.SourceTextModule(fs.readFileSync(f,'utf8'),{identifier:f});out.push({file:f,ok:true})}",
  "catch(e){out.push({file:f,ok:false,message:String((e&&e.message)||e)})}}",
  "process.stdout.write(JSON.stringify(out))",
].join('')

export function extensionOf(file) {
  const text = String(file ?? '')
  const index = text.lastIndexOf('.')
  return index < 0 ? '' : text.slice(index).toLowerCase()
}

export function isCheckable(file) {
  return CHECKABLE_EXTENSIONS.includes(extensionOf(file))
}

function defaultStat(file) {
  // 只在需要时才 stat：调用方通常已经扫过盘，但仍然以当前磁盘状态为准。
  return statSync(file)
}

function defaultRunParser(files, timeoutMs) {
  const result = spawnSync(process.execPath, ['--experimental-vm-modules', '-e', PARSER_SCRIPT, ...files], {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  })
  if (result.error || result.status !== 0) return { ok: false, reason: String(result.error?.message || result.stderr || 'parser-failed') }
  try {
    return { ok: true, rows: JSON.parse(result.stdout) }
  } catch (error) {
    return { ok: false, reason: `parser-output: ${error?.message || error}` }
  }
}

/**
 * 体检一批文件。
 * @param {string[]} files 绝对路径（重复会被去掉）
 * @param {{settleMs?: number, maxBytes?: number, maxFiles?: number, timeoutMs?: number, now?: number, stat?: Function, runParser?: Function}} [options]
 * @returns {Promise<{ok: boolean, checked: number, skipped: string[], problems: Array<{file: string, code: string, message: string}>, retryable: boolean, degraded?: boolean}>}
 */
export async function checkSnapshot(files, options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...options }
  const now = typeof limits.now === 'number' ? limits.now : Date.now()
  const stat = typeof limits.stat === 'function' ? limits.stat : defaultStat
  const runParser = typeof limits.runParser === 'function' ? limits.runParser : defaultRunParser
  const problems = []
  const skipped = []
  const jsFiles = []
  let retryable = false
  let jsonChecked = 0

  const unique = []
  for (const file of Array.isArray(files) ? files : []) {
    if (typeof file !== 'string' || file === '') continue
    if (!unique.includes(file)) unique.push(file)
  }
  const limited = unique.slice(0, limits.maxFiles)
  for (const file of unique.slice(limits.maxFiles)) skipped.push(file)

  for (const file of limited) {
    if (!isCheckable(file)) { skipped.push(file); continue }
    let info
    try {
      info = stat(file)
    } catch (error) {
      problems.push({ file, code: 'missing', message: String(error?.message || error) })
      continue
    }
    // 1) 还在写：mtime 太新
    const age = now - Number(info?.mtimeMs ?? 0)
    // 注意负数：Windows 上刚写完的文件 mtime 可能略超前于 now，同样属于「刚写完」。
    if (Number.isFinite(age) && limits.settleMs > 0 && age < limits.settleMs) {
      problems.push({ file, code: 'unsettled', message: `文件刚被写过（${Math.max(0, Math.round(age))}ms 前），可能还没写完` })
      retryable = true
      continue
    }
    // 2) 明显截断
    if (!Number(info?.size)) {
      problems.push({ file, code: 'empty', message: '文件为空（可能正在被重写）' })
      retryable = true
      continue
    }
    if (info.size > limits.maxBytes) { skipped.push(file); continue }
    if (extensionOf(file) === '.json') {
      // JSON 便宜，进程内直接解析。
      try {
        JSON.parse(readFileSync(file, 'utf8'))
        jsonChecked += 1
      } catch (error) {
        problems.push({ file, code: 'syntax', message: String(error?.message || error) })
      }
      continue
    }
    jsFiles.push(file)
  }

  let degraded = false
  if (jsFiles.length > 0) {
    const parsed = runParser(jsFiles, limits.timeoutMs)
    if (parsed.ok !== true) {
      // 体检器本身不可用：不假装通过，也不因此把插件锁死 —— 标 degraded 让调用方自己决定并记录。
      degraded = true
      skipped.push(...jsFiles)
    } else {
      for (const row of parsed.rows ?? []) {
        if (row?.ok === true) continue
        problems.push({ file: String(row?.file ?? ''), code: 'syntax', message: String(row?.message ?? 'syntax error') })
      }
    }
  }

  return {
    ok: problems.length === 0,
    checked: jsonChecked + (degraded ? 0 : jsFiles.length),
    skipped,
    problems,
    retryable,
    ...(degraded ? { degraded: true } : {}),
  }
}