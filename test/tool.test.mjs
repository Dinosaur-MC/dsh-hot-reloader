import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { PARAMETERS, TOOL_DESCRIPTION, TOOL_NAME, registerHotReloadTool } from '../lib/tool.js'

/** DSH 现在只以 app.asar 形式存在：本机没有展开的 @deepseek-ai/dsh-tools 时，定义编译类断言无从执行，如实 skip 而不是假绿。 */
const PEER_READY = (() => {
  try {
    createRequire(import.meta.url).resolve('@deepseek-ai/dsh-tools')
    return true
  } catch {
    return false
  }
})()
const PEER_SKIP = PEER_READY ? false : 'requires an unpacked @deepseek-ai/dsh-tools (DSH ships inside app.asar on this machine)'
const t = (name, fn) => test(name, { skip: PEER_SKIP }, fn)

const WORKSPACE = 'F:\\AgentGarden'
const exec = { agent: { session: { header: { cwd: WORKSPACE } } } }

/** 桩 ctx：inject 立即用带 tools 的上下文回调（真实宿主在 tools 服务就绪后回调）。 */
function stubCtx() {
  const captured = { definition: undefined, disposers: 0 }
  const ctx = {
    inject(deps, callback) {
      assert.deepEqual(deps, ['tools'])
      callback({ tools: { register(definition) { captured.definition = definition; return () => { captured.disposers += 1 } } } })
    },
  }
  return { ctx, captured }
}

function stubDeps(over = {}) {
  const calls = { list: [], reload: [], auto: [] }
  return {
    calls,
    deps: {
      version: '0.1.0',
      async listTargets(input) { calls.list.push(input); return { targets: [{ pkg: 'dsh-our-free-model', root: 'F:\\AgentGarden\\projects\\x', inWorkspace: true }] } },
      async reload(input) { calls.reload.push(input); return { reloaded: [{ pkg: 'dsh-our-free-model', ms: 12, fibers: 1 }], skipped: [], failed: [] } },
      async setAuto(input) { calls.auto.push(input); return { ok: true, enabled: input.enabled, entryId: 'dsh-hot-reloader' } },
      async getAuto() { calls.getAuto = (calls.getAuto ?? 0) + 1; return { enabled: false, source: 'config', runtimeOverride: null, configEnabled: false, reloadSelf: false, allowForeignTargets: false, quiet: false, settingsAvailable: true } },
      ...over,
    },
  }
}

const register = async (deps, importer) => {
  const { ctx, captured } = stubCtx()
  const result = await registerHotReloadTool(ctx, deps, importer ? { importer } : undefined)
  return { result, definition: captured.definition, captured }
}

t('PARAMETERS / description 符合 DSH 方言与安全口径', () => {
  assert.equal(TOOL_NAME, 'hot_reload')
  assert.match(TOOL_DESCRIPTION, /内存状态/)
  assert.deepEqual(PARAMETERS.action.enum, ['list', 'reload', 'auto'])
  assert.equal(PARAMETERS.targets.type, 'array')
  assert.equal(PARAMETERS.targets.items.type, 'string')
  assert.equal(PARAMETERS.dryRun.type, 'boolean')
  assert.equal(PARAMETERS.enabled, undefined, 'LLM 对开关只读：不暴露 enabled 参数')
  assert.equal(PARAMETERS.all.type, 'boolean')
  for (const [key, spec] of Object.entries(PARAMETERS)) {
    if (spec.type === 'object') assert.ok(Object.hasOwn(spec, 'additionalProperties'), key + ' 缺 additionalProperties')
    if (spec.oneOf) assert.ok(spec.oneOf.length >= 2, key + ' 的 oneOf 分支不足 2 个')
  }
})

t('注册：defineTool 编译出合法 definition 并挂进 tools.register', async () => {
  const { deps } = stubDeps()
  const { result, definition } = await register(deps)
  assert.equal(result.registered, true)
  assert.equal(definition.name, 'hot_reload')
  assert.equal(definition.parameters.type, 'object')
  assert.deepEqual(definition.parameters.properties.action.enum, ['list', 'reload', 'auto'])
  assert.equal(typeof definition.output.render, 'function')
  // 权限：LLM 对开关只读 —— 连「写开关」的参数都不存在
  assert.equal(definition.parameters.properties.enabled, undefined, '不应暴露 enabled 参数')
})

t('execute：默认 action=reload 且必须显式 targets，工作区取自会话', async () => {
  const { deps, calls } = stubDeps()
  const { definition } = await register(deps)
  const value = await definition.execute({ targets: ['dsh-our-free-model'] }, exec)
  assert.deepEqual(calls.reload, [{ selectors: ['dsh-our-free-model'], workspace: WORKSPACE, dryRun: false }])
  assert.equal(value.ok, true)
  assert.equal(value.action, 'reload')
  assert.equal(value.workspace, WORKSPACE)
  assert.equal(value.reloaded[0].pkg, 'dsh-our-free-model')
})

t('渲染：只读模式输出开关状态（自动重载/自身/跨工作区）', async () => {
  const { deps } = stubDeps()
  const { definition } = await register(deps)
  const value = await definition.execute({ action: 'auto' }, exec)
  const blocks = definition.output.render({ action: 'auto' }, value)
  assert.equal(Array.isArray(blocks), true)
  assert.equal(blocks[0].type, 'text')
  assert.match(blocks[0].text, /自动重载：关/)
  assert.match(blocks[0].text, /自身自动重载：关/)
  assert.match(blocks[0].text, /跨工作区：关/)
})

t('权限：传 enabled 被拒绝（开关只读）且不写盘', async () => {
  const { deps, calls } = stubDeps()
  const { definition } = await register(deps)
  const value = await definition.execute({ action: 'auto', enabled: true }, exec)
  assert.equal(value.ok, false)
  assert.equal(value.error, 'read-only')
  assert.equal(calls.auto.length, 0, '不得写盘')
})

t('权限：reload 必须显式 targets（留空/空白 = targets-required）', async () => {
  const { deps, calls } = stubDeps()
  const { definition } = await register(deps)
  assert.equal((await definition.execute({ action: 'reload' }, exec)).error, 'targets-required')
  assert.equal((await definition.execute({ action: 'reload', targets: ['  '] }, exec)).error, 'targets-required')
  assert.equal(calls.reload.length, 0, '没有显式目标时不得触发重载')
})

t('权限：不接受 workspace / all 这类「全部」语义', async () => {
  const { deps, calls } = stubDeps()
  const { definition } = await register(deps)
  for (const keyword of ['workspace', 'ALL']) {
    const value = await definition.execute({ targets: [keyword] }, exec)
    assert.equal(value.error, 'broad-target-rejected')
  }
  assert.equal(calls.reload.length, 0)
})

t('execute：action=list 只列目标，不触发重载', async () => {
  const { deps, calls } = stubDeps()
  const { definition } = await register(deps)
  const value = await definition.execute({ action: 'list' }, exec)
  assert.deepEqual(calls.list, [{ workspace: WORKSPACE, all: false }])
  assert.equal(calls.reload.length, 0)
  assert.equal(value.targets[0].inWorkspace, true)
})

t('execute：dryRun 透传，且失败集合非空时 ok=false', async () => {
  const { deps, calls } = stubDeps({
    async reload(input) { calls.reload.push(input); return { reloaded: [], skipped: [], failed: [{ pkg: 'x', error: 'boom' }] } },
  })
  const { definition } = await register(deps)
  const value = await definition.execute({ targets: ['x'], dryRun: true }, exec)
  assert.deepEqual(calls.reload[0], { selectors: ['x'], workspace: WORKSPACE, dryRun: true })
  assert.equal(value.ok, false)
})

t('execute：action=auto 省略 enabled = 只读当前状态', async () => {
  const { deps, calls } = stubDeps()
  const { definition } = await register(deps)
  const missing = await definition.execute({ action: 'auto' }, exec)
  // 省略 enabled = 只读当前状态（旧行为是报 enabled-required，模型既读不到、还可能为了读而写）
  assert.equal(missing.ok, true)
  assert.equal(missing.auto.readOnly, true)
  assert.equal(missing.auto.enabled, false)
  assert.equal(missing.auto.reloadSelf, false)
  assert.equal(calls.auto.length, 0, '只读不得写盘')
  assert.equal(calls.getAuto, 1, '只读应调用 getAuto 一次')
  assert.equal(calls.auto.length, 0)
  // 写开关的请求被拒绝（权限：开关只读，写入口只留给用户）
  const written = await definition.execute({ action: 'auto', enabled: false }, exec)
  assert.equal(written.ok, false)
  assert.equal(written.error, 'read-only')
  assert.equal(calls.auto.length, 0, '不得写盘')
})

t('execute：没有会话工作区时按 undefined 传下去（由上层回落 cwd）', async () => {
  const { deps, calls } = stubDeps()
  const { definition } = await register(deps)
  await definition.execute({ targets: ['dsh-our-free-model'] }, {})
  assert.equal(calls.reload[0].workspace, undefined)
})

t('render：返回 [{ type: "text", text }] 内容块数组（宿主对其调 .some）', async () => {
  const { deps } = stubDeps()
  const { definition } = await register(deps)
  const value = await definition.execute({ targets: ['dsh-our-free-model'] }, exec)
  const content = definition.output.render({}, value)
  assert.ok(Array.isArray(content), 'render 必须返回内容块数组，返回裸字符串会让宿主抛 content.some is not a function')
  assert.ok(content.length >= 1)
  for (const block of content) assert.equal(block.type, 'text')
  const text = content.map((block) => block.text).join('\n')
  assert.match(text, /dsh-our-free-model/)
  assert.match(text, /F:\\AgentGarden/)
})

t('dsh-tools 不可解析：返回 registered:false 而不是抛错', async () => {
  const { deps } = stubDeps()
  const failing = async () => { throw new Error('ERR_MODULE_NOT_FOUND') }
  const result = await registerHotReloadTool(stubCtx().ctx, deps, { importer: failing })
  assert.equal(result.registered, false)
  assert.match(result.reason, /dsh-tools/)
})
t('execute：action=list 的 all 透传，渲染给出 hidden 汇总', async () => {
  const { deps, calls } = stubDeps({
    async listTargets(input) {
      calls.list.push(input)
      return {
        targets: [
          { pkg: 'a', root: '/ws/a', inWorkspace: true, reloadable: true },
          { pkg: 'dsh-ops/file', root: 'C:\\Users\\x\\.dsh\\profiles\\desktop\\node_modules\\dsh-ops\\lib\\components\\file', inWorkspace: true, reloadable: true },
        ],
        hidden: { count: 2, total: 3, byReason: { 'outside-workspace': 1, 'not-activated': 1 } },
        listAll: input.all === true,
        autoEnabled: true,
      }
    },
  })
  const { definition } = await register(deps)
  const value = await definition.execute({ action: 'list', all: true }, exec)
  assert.deepEqual(calls.list, [{ workspace: WORKSPACE, all: true }])
  assert.equal(value.listAll, true)
  const text = definition.output.render({}, value).map((block) => block.text).join('\n')
  assert.match(text, /全部条目/)
  const filtered = { ...value, listAll: false }
  const text2 = definition.output.render({}, filtered).map((block) => block.text).join('\n')
  assert.match(text2, /hidden: 2 个（/)
  assert.doesNotMatch(text2, /all:true/, '输出不再邀请模型传 all=true')
  assert.doesNotMatch(text, /C:\\Users|\/ws\/a/, '列表文本里不出现绝对路径')
  assert.match(text, /- dsh-ops\/file/, '包名本身就是短标识')
})