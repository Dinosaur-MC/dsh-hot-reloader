/**
 * LLM 工具 hot_reload：让会话里的模型主动触发重载，默认作用域是当前会话工作区。
 *
 * 三条设计约束：
 *   1. 不静态 import dsh-tools —— peer 解析失败必须只让「工具没注册」，不能让插件加载失败；
 *      因此用动态 import + 可注入的 importer（测试与降级都靠它）。
 *   2. 作用域与护栏全部委托 lib/targets.js 与调用方注入的 deps，本模块不做策略判断，
 *      这样 HTTP 路由与工具走的是同一套语义。
 *   3. 工作区取自 exec.agent.session.header.cwd（每个会话/每次执行都不同）。
 */

export const TOOL_NAME = 'hot_reload'

export const TOOL_DESCRIPTION = [
  '热重载宿主里已加载的 DSH 插件：让磁盘上的插件源码改动在当前宿主进程中生效，不重启宿主。',
  '',
  '作用域',
  '- 默认（未给 targets）只处理「包根落在当前会话工作区内」的插件；',
  '- 跨工作区目标需要宿主配置 allowForeignTargets: true 才会执行，否则记 skipped:outside-workspace；',
  '- 本插件自身永远不会被本工具重载（记 skipped:self）；开发它请用 POST /dsh-hot-reloader/self-reload。',
  '',
  '破坏性',
  '- 重载会丢弃目标插件持有的内存状态（连接、定时器、缓存），长连接类插件会短暂中断；',
  '- 不确定时先 action:"list" 看清目标（默认只列可重载的），或先 dryRun:true 试算命中集合（不执行重载）。',
  '- action:"list" 想连工作区外 / 入口未激活 / 本插件自身的条目一起看，传 all:true。',
  '',
  'targets 元素语法：包名（含 pkg/sub 子路径入口）、文件或目录路径（相对路径按会话工作区解析）、关键词 workspace / all。',
  'action:"auto" 用于开关自动重载（写进 profile patch，持久）；不要用它代替 reload。',
].join('\n')

/** DSH 的紧凑 schema 方言（ParameterSchemaSpec），纯数据便于单独断言。 */
export const PARAMETERS = {
  action: {
    type: 'string',
    enum: ['list', 'reload', 'auto'],
    description: 'list=只列出可重载目标与工作区归属；reload（默认）=执行重载；auto=开关自动重载（需同时给 enabled）。',
  },
  targets: {
    type: 'array',
    items: { type: 'string' },
    description: '要重载的目标：包名、文件/目录路径、或关键词 workspace / all。留空等价于 ["workspace"]。',
  },
  dryRun: {
    type: 'boolean',
    description: 'true = 只解析并回报会命中/被拦下的目标，不真的重载。',
  },
  enabled: {
    type: 'boolean',
    description: '仅 action:"auto" 使用：true 打开自动重载，false 关闭。',
  },
  all: {
    type: 'boolean',
    description: '仅 action:"list" 使用：true = 连「工作区外 / 入口未激活 / 本插件自身」的条目一起列出（每条带 blockedBy 与 reloadable）；默认只列可重载的目标。',
  },
}

/** 把结果值渲染成人/模型可读的文本；外面再包成宿主要求的 [{ type: 'text', text }] 内容块。 */
function renderValue(value) {
  if (value === null || typeof value !== 'object') return String(value)
  const lines = [`workspace: ${value.workspace ?? '(未提供，宿主按自身 cwd 回落)'}`]
  if (value.action === 'list') {
    const targets = Array.isArray(value.targets) ? value.targets : []
    const hidden = value.hidden ?? {}
    const scope = value.listAll === true ? '（全部条目）' : '可重载目标'
    lines.push(`watched: ${targets.length} 个${scope}${value.autoEnabled === undefined ? '' : ` · 自动重载 ${value.autoEnabled ? '开' : '关'}`}`)
    for (const item of targets) {
      const why = item.blockedBy === 'outside-workspace' ? '工作区外'
        : item.blockedBy === 'self' ? '本插件自身'
          : item.blockedBy === 'not-activated' ? '入口未激活'
            : item.blockedBy
      const mark = why ? `（${why}）` : item.inWorkspace === false ? '（工作区外）' : ''
      lines.push(`  - ${item.pkg}${mark}  ${item.root ?? ''}`)
    }
    if (value.listAll !== true && (hidden.count ?? 0) > 0) {
      const detail = Object.entries(hidden.byReason ?? {}).map(([key, count]) => `${key} ${count}`).join(' · ')
      lines.push(`hidden: ${hidden.count} 个（${detail}）· 传 all:true 看全部`)
    }
    return lines.join('\n')
  }
  if (value.action === 'auto') {
    const auto = value.auto ?? {}
    lines.push(auto.ok === true
      ? `自动重载已${auto.enabled ? '打开' : '关闭'}（写入条目 ${auto.entryId ?? '?'}）`
      : `开关未生效：${auto.error ?? 'unknown'}${auto.message ? ` — ${auto.message}` : ''}`)
    return lines.join('\n')
  }
  if (value.error !== undefined && value.ok === false && value.reloaded === undefined) {
    lines.push(`失败：${value.error}`)
    return lines.join('\n')
  }
  const reloaded = Array.isArray(value.reloaded) ? value.reloaded : []
  const skipped = Array.isArray(value.skipped) ? value.skipped : []
  const failed = Array.isArray(value.failed) ? value.failed : []
  for (const item of reloaded) lines.push(`reloaded: ${item.pkg}${item.ms === undefined ? '' : ` (${item.ms}ms)`}${item.fibers === undefined ? '' : ` · ${item.fibers} 个 fiber`}`)
  for (const item of skipped) lines.push(`skipped:  ${item.pkg} — ${item.reason}`)
  for (const item of failed) lines.push(`failed:   ${item.pkg} — ${item.error}`)
  if (reloaded.length === 0 && skipped.length === 0 && failed.length === 0) lines.push('no-op: 没有命中任何目标')
  if (value.dryRun === true) lines.push('(dry-run：以上仅为解析结果，未执行重载)')
  return lines.join('\n')
}

/**
 * 注册 hot_reload 工具。
 * @param {object} ctx cordis 上下文
 * @param {object} deps 由装配层注入：{ version, listTargets, reload, setAuto }
 * @param {{importer?: (specifier: string) => Promise<any>}} [options] importer 仅测试与降级用
 * @returns {Promise<{registered: boolean, reason?: string, definition?: object, dispose?: Function}>}
 */
export async function registerHotReloadTool(ctx, deps = {}, options = {}) {
  const importer = options.importer ?? ((specifier) => import(specifier))
  let defineTool
  try {
    const mod = await importer('@deepseek-ai/dsh-tools')
    defineTool = mod?.defineTool
  } catch (error) {
    return { registered: false, reason: `dsh-tools 不可解析：${error?.message || error}` }
  }
  if (typeof defineTool !== 'function') return { registered: false, reason: 'dsh-tools 没有导出 defineTool' }

  const definition = defineTool({
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: PARAMETERS,
    output: {
      schema: { type: 'json' },
      // 契约：render 必须返回内容块数组 —— 宿主拿到 content 后会直接 content.some(...) 检查 image 块，
      // 返回裸字符串会抛 "content.some is not a function"（本机真机验收实测）。
      render: (_args, value) => [{ type: 'text', text: renderValue(value) }],
    },
    async execute(args = {}, exec) {
      const workspace = typeof exec?.agent?.session?.header?.cwd === 'string'
        ? exec.agent.session.header.cwd
        : undefined
      const action = args?.action === 'list' || args?.action === 'auto' ? args.action : 'reload'

      if (action === 'auto') {
        if (typeof args?.enabled !== 'boolean') {
          return { ok: false, action, workspace, error: 'enabled-required', note: 'action:"auto" 需要同时给 enabled: true|false' }
        }
        const auto = await deps.setAuto({ enabled: args.enabled })
        return { ok: auto?.ok === true, action, workspace, auto }
      }

      if (action === 'list') {
        const data = await deps.listTargets({ workspace, all: args?.all === true })
        return { ok: true, action, workspace, ...data }
      }

      const selectors = Array.isArray(args?.targets) ? args.targets : []
      const data = await deps.reload({ selectors, workspace, dryRun: args?.dryRun === true })
      const failed = Array.isArray(data?.failed) ? data.failed : []
      const reloaded = Array.isArray(data?.reloaded) ? data.reloaded : []
      // ok：调用方给了明确的 ok=false（例如「命中但全被跳过」）就照用；否则要求「有真重载且无失败」。
      const ok = data?.ok === false ? false : failed.length === 0 && reloaded.length > 0
      return { ok, action, workspace, ...data }
    },
  })

  let dispose
  // tools 服务可能晚于本插件就绪（headless 宿主甚至没有）：用可选注入，拿到才注册。
  // 注册要挂在本 fiber 的 effect 上：tools.register 返回的 disposer 归 tools 服务所有，不显式回收的话，
  // /self-reload 之后会留下悬空注册（同名再注册会抛，且旧定义闭包着已 dispose 的 fiber ⇒ 静默假成功）。
  ctx.inject(['tools'], (toolCtx) => {
    dispose = typeof toolCtx.effect === 'function'
      ? toolCtx.effect(() => toolCtx.tools.register(definition))
      : toolCtx.tools.register(definition)
  })
  return { registered: true, definition, dispose: () => dispose?.() }
}