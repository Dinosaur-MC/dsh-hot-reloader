/**
 * dsh-hot-reloader — 浏览器半。
 *
 * 宿主半把「自动重载开关」声明成 Config schema 里的 volatile 字段，于是它被平台的设置服务寻址
 * （浏览器侧 `ctx.configForms.get(entryId)`，宿主侧 `settings`）。这一半把它渲染出来：
 * 自动重载开关 + 状态行 + **手动重载指定插件的目标列表**。
 *
 * 座位：`settings.section`（本部署真正渲染的设置页座位，主入口）与 `plugins.row.config`（首方 UI 的
 * 插件行 Configure 页）。取证见 docs/acceptance-2026-10-17.md §8。
 *
 * 四条纪律（都是踩坑换来的）：
 *   1. 词典**值必须是字符串**：平台 t() 会把它当模板串 replace；要参数化就用 `{name}` + `t(key, params)`。
 *   2. **绝不调用 `location.reload()` / 任何页面导航**：DSH 桌面窗口的会话凭据由宿主在开窗时注入，
 *      导航会让窗口以未授权状态重载、把整个 DSH 带崩（2026-10-17 真机事故）。刷新界面只能由宿主提供。
 *   3. 座位/依赖都可能不存在：卡片自己订阅 store，不依赖平台 hooks→useXxx 糖，也不依赖首方 primitives。
 *   4. 失败要可见：任何渲染异常都画成一行文字，绝不留给用户一片空白。
 *
 * 手动重载走**本插件自己的 HTTP 面**（同源、仅回环）：GET /targets?all=1 列目标、
 * POST /reload {targets, workspace} 重载指定目标 —— 与 hot_reload 工具、命令行同一实现。
 *
 * @module dsh-hot-reloader/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-hot-reloader',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    // primitives 可选：不同 UI 聚合方式不同，拿不到就回落到纯 DOM 实现。
    let primitives = {}
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives') || {}
    } catch {
      primitives = {}
    }
    const h = React.createElement

    const NS = 'settings.hot-reloader'
    const PACKAGE_NAME = 'dsh-hot-reloader'
    const ROW_ID = 'dsh-hot-reloader'
    const ROW_KEY = `${PACKAGE_NAME}#${ROW_ID}`
    const SECTION_ID = 'hot-reloader'
    const SECTION_ORDER = 160
    /** 本插件自己的 HTTP 面（同源、仅回环）。 */
    const STATUS_URL = '/dsh-hot-reloader'
    const HINT_ID = 'dshhr-hint'

    const inject = ['slots', 'locale', 'configForms']

    // 词典**只放字符串**（zh/en 键必须完全对称，有测试守卫）。
    const zh = {
      title: '热重载器',
      summary: '改完插件源码让宿主原地重载，不用重启。',
      hint: '正在盯住所有已安装插件的包根。关掉它只停自动轮询；下面的手动重载与 hot_reload 工具照常可用。',
      autoReload: '自动热重载',
      autoReloadSelf: '自动重载本插件自身',
      autoReloadSelfHint: '改本插件的代码也自动生效（默认关：避免保存到一半就被重载；自升级失败时需要重启 DSH 恢复）。只有上面的「自动热重载」打开时才生效。',
  allowForeign: '允许模型重载项目外的插件',
  allowForeignHint: '默认关：模型只能重载当前项目目录里的插件。打开后，模型也能重载其它目录里已加载的插件（例如放在别的盘上开发中的插件）。',
  strict: '严格模式（类型检查 / lint）',
  strictHint: '默认关：重载前只做语法与完整性体检。打开后，还会在插件目录执行你配置的检查命令（strictCommands），任一条失败就不重载。',
  interval: '扫描间隔（毫秒）',
  intervalHint: '改完下一轮扫描就生效（最小 120ms）。越小越灵敏，但更费 IO。',
  limitInterval: '手动重载限流（毫秒）',
  limitIntervalHint: '同一插件在这个间隔内重复点重载会被跳过（默认 800ms，0 = 关闭）。',
  reloadProject: '重载当前项目插件',
  reloadProjectHint: '重载当前对话所属项目里的插件（其它项目不受影响）。',
  reloadProjectBusy: '重载中…',
  reloadProjectDone: '已重载 {count} 个',
  reloadProjectNone: '没有可重载的插件',
  reloadProjectFailedShort: '重载失败',
  reloadProjectNoProject: '当前对话还没有关联项目',
  reloadProjectThrottled: '稍后再试',
  reloadProjectNoTarget: '这个项目没有已加载的插件',
  showHeader: '显示会话头部快捷按钮',
  showHeaderHint: '关闭后对话头部不再出现该按钮（设置页里仍可手动重载）。',
  reloadProjectFailed: '重载失败：{reason}',
  reloadProjectTip: '重载「{project}」里的插件',
  reloadProjectTipHint: '只影响这个项目；插件会立即用磁盘上的最新代码重建。',
  reloadProjectErrorTitle: '重载失败（点「复制错误」把全文发给别人）',
  reloadProjectCopy: '复制错误',
  reloadProjectCopied: '已复制',
  reloadProjectDismiss: '关闭',
      loading: '正在读取设置…',
      unavailable: '该插件行当前未加载，无法配置。',
      readOnly: '本部署的设置是只读的。',
      saveFailed: '宿主没有接受这次改动，开关保持原样。',
      writing: '正在应用…',
      status: '正在监听 {targets} 个插件目录 · {files} 个文件 · 启动以来重载 {reloads} 次',
      statusUnavailable: '状态不可用（宿主没在跑？）。',
      staleClient: '界面代码已在磁盘上更新：宿主会自动下发，通常无需操作；若界面仍是旧的，刷新页面即可（本插件不提供刷新按钮）。',
      manualTitle: '手动重载指定插件',
      manualHint: '点某一行的「重载」即可重载该插件；也可以直接用 hot_reload 工具，或 POST /dsh-hot-reloader/reload。',
      reloadOne: '重载',
      refreshList: '刷新列表',
      noTargets: '没有可列出的插件目标。',
      listFailed: '取目标列表失败。',
      loadingList: '正在读取目标列表…',
      reloading: '重载中…',
      reloadOk: '已重载',
      reloadSkipped: '已跳过',
      reloadFailed: '重载失败',
      tagReloadable: '可重载',
      tagNotActivated: '未激活',
      tagSelf: '本插件自身',
      reasonNotActivated: '未激活（当前没有可重建的实例，重载无效果）',
      tagsHint: '「未激活」的行无法重载：宿主当前没有可重建的实例（例如该插件已被禁用），先启用它再重载。',
    }
    const en = {
      title: 'Hot reloader',
      summary: 'Edit plugin source and let the host reload it in place — no restart.',
      hint: 'Watching every installed plugin package root. Turning this off stops the automatic polling; manual reloads below and the hot_reload tool keep working.',
      autoReload: 'Automatic hot reload',
      autoReloadSelf: 'Auto-reload this plugin itself',
      autoReloadSelfHint: 'Your edits to this plugin take effect automatically too (off by default: avoids reloading mid-save; if a self-upgrade fails you must restart DSH). Only applies while “Automatic hot reload” is on.',
      allowForeign: 'Let the model reload plugins outside this project',
      allowForeignHint: 'Off by default: the model can only reload plugins that live inside the current project folder. When on, it may also reload loaded plugins kept in other folders (for example a plugin under development on another drive).',
      strict: 'Strict mode (typecheck / lint)',
      strictHint: 'Off by default: only syntax and completeness are checked. When on, the check commands configured in strictCommands run in the plugin folder first, and any failure blocks the reload.',
      interval: 'Scan interval (ms)',
      intervalHint: 'Takes effect on the next scan (minimum 120 ms). Smaller is more responsive but costs more IO.',
      limitInterval: 'Manual reload throttle (ms)',
      limitIntervalHint: 'Repeat reloads of the same plugin inside this window are skipped (default 800 ms, 0 = off).',
      reloadProject: 'Reload this project',
      reloadProjectHint: 'Reloads plugins belonging to the project of the current conversation; other projects are untouched.',
      reloadProjectBusy: 'Reloading…',
      reloadProjectDone: 'Reloaded {count}',
      reloadProjectNone: 'Nothing to reload',
      reloadProjectFailedShort: 'Reload failed',
      reloadProjectNoProject: 'This conversation has no project yet',
      reloadProjectThrottled: 'Try again shortly',
      reloadProjectNoTarget: 'No loaded plugin in this project',
      showHeader: 'Show the conversation-header button',
      showHeaderHint: 'When off, the button disappears from the conversation header (manual reload stays available in settings).',
      reloadProjectFailed: 'Reload failed: {reason}',
      reloadProjectTip: 'Reload plugins in “{project}”',
      reloadProjectTipHint: 'Affects this project only; plugins are rebuilt from the latest code on disk right away.',
      reloadProjectErrorTitle: 'Reload failed (use “Copy error” to share the full text)',
      reloadProjectCopy: 'Copy error',
      reloadProjectCopied: 'Copied',
      reloadProjectDismiss: 'Dismiss',
      loading: 'Reading settings…',
      unavailable: 'This plugin row is not loaded, so it cannot be configured.',
      readOnly: 'This deployment stores settings read-only.',
      saveFailed: 'The deployment rejected the change; the switch is unchanged.',
      writing: 'Applying…',
      status: 'Watching {targets} plugin folders · {files} files · {reloads} reloads since start',
      statusUnavailable: 'Status unavailable (host not running?).',
      staleClient: 'The interface code on disk is newer: the host ships it automatically, so normally nothing to do; if the UI still looks stale, refresh the page (this plugin has no refresh button).',
      manualTitle: 'Reload a specific plugin',
      manualHint: 'Click “Reload” on a row to reload that plugin; the hot_reload tool or POST /dsh-hot-reloader/reload works too.',
      reloadOne: 'Reload',
      refreshList: 'Refresh list',
      noTargets: 'No plugin targets to list.',
      listFailed: 'Could not load the target list.',
      loadingList: 'Loading target list…',
      reloading: 'Reloading…',
      reloadOk: 'Reloaded',
      reloadSkipped: 'Skipped',
      reloadFailed: 'Reload failed',
      tagReloadable: 'reloadable',
      tagNotActivated: 'not activated',
      tagSelf: 'this plugin',
      reasonNotActivated: 'not activated (no live instance to rebuild)',
      tagsHint: 'Rows tagged “not activated” cannot be reloaded: the host has no live instance to rebuild (for example the plugin is disabled). Enable it first.',
    }

    const STYLE_ID = 'hot-reloader-card'
    const CSS = [
      '.dshhr-card{margin:0 0 14px}',
      '.dshhr-title{margin:0 0 8px;font-size:14px;font-weight:600}',
      '.dshhr-row{display:flex;align-items:center;gap:6px;font-size:13px}',
      '.dshhr-hint{margin:6px 0 0;font-size:12px;opacity:.65;line-height:1.5}',
      '.dshhr-status{margin:8px 0 0;font-size:12px;opacity:.75;font-variant-numeric:tabular-nums}',
      '.dshhr-stale,.dshhr-result{opacity:.9}',
      '.dshhr-error{color:var(--dsw-alias-state-warn-primary,inherit)}',
      '.dshhr-toolbar{margin:16px 0 6px;display:flex;align-items:center;justify-content:space-between;gap:12px}',
      '.dshhr-toolbar-title{margin:0;font-size:13px;font-weight:600}',
      '.dshhr-button{flex:none;font:inherit;font-size:12px;cursor:pointer;background:transparent;border:1px solid rgba(127,127,127,.45);border-radius:6px;padding:2px 10px;opacity:.85}',
      '.dshhr-button:hover{opacity:1;border-color:currentColor}',
      '.dshhr-button:disabled{opacity:.4;cursor:default}',
      '.dshhr-list{margin:10px 0 0;padding:0;list-style:none;border:1px solid rgba(127,127,127,.25);border-radius:8px;overflow:hidden}',
      '.dshhr-item{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px 16px;align-items:center;padding:8px 12px}',
      '.dshhr-item+.dshhr-item{border-top:1px solid rgba(127,127,127,.2)}',
      '.dshhr-item:hover{background:rgba(127,127,127,.07)}',
      '.dshhr-item-main{min-width:0}',
      '.dshhr-item-head{display:flex;align-items:center;gap:8px;min-width:0}',
      '.dshhr-item-action{flex:none;display:flex;align-items:center}',
      '.dshhr-pkg{font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dshhr-note{font-size:11px;opacity:.55}',
      '.dshhr-result{margin-top:2px;font-size:11px;opacity:.9}',
      '.dshhr-tag{flex:none;border:1px solid rgba(127,127,127,.45);border-radius:999px;padding:0 6px;font-size:10px;opacity:.7;line-height:16px}',
      // 会话头部快捷按钮：自绘 tooltip（原生 title 在视口边缘会被裁掉，dsh-save-money 同样踩过）
      '.dshhr-header{position:relative;display:inline-flex;align-items:center;gap:8px}',
      '.dshhr-header-button{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 9px;border-radius:7px;border:1px solid transparent;background:transparent;color:inherit;font:inherit;font-size:12px;line-height:1;cursor:pointer;transition:background .12s ease,border-color .12s ease,opacity .12s ease}',
      '.dshhr-header-button:hover{background:var(--dsw-alias-button-ghost-active-hover,rgba(127,127,127,.14));border-color:var(--dsw-alias-border-l1,rgba(127,127,127,.25))}',
      '.dshhr-header-button:active{background:var(--dsw-alias-button-ghost-active-fill,rgba(127,127,127,.2))}',
      '.dshhr-header-button:focus-visible{outline:2px solid var(--dsw-alias-brand-text,currentColor);outline-offset:2px}',
      '.dshhr-header-button:disabled{opacity:.5;cursor:default}',
      '.dshhr-header-button[data-failed="true"]{color:var(--dsw-alias-state-warn-primary,inherit)}',
      '.dshhr-header-icon{width:14px;height:14px;flex:none}',
      // 宽度锁死：所有候选文案叠在同一格（grid），只有当前那条可见；格子宽 = 最宽候选，
      // 所以换文案时按钮宽度不变，右对齐的头部不会跟着挪（用户反馈的「长度在闪」）。
      '.dshhr-header-stack{display:grid;align-items:center}',
      '.dshhr-header-label-item{grid-area:1/1;white-space:nowrap}',
      '.dshhr-header-label-item:not(.is-on){visibility:hidden}',
      '.dshhr-header-tip{position:absolute;top:calc(100% + 8px);right:0;z-index:10001;min-width:180px;max-width:280px;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-3,#1f2328);border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));box-shadow:0 10px 28px rgba(0,0,0,.28);display:flex;flex-direction:column;gap:3px;opacity:0;visibility:hidden;transform:translateY(-3px);transition:opacity .12s ease,transform .12s ease,visibility .12s}',
      '.dshhr-header-tip-title{font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshhr-header-tip-hint{font-size:11px;opacity:.7;line-height:1.45}',
      '.dshhr-header:hover .dshhr-header-tip,.dshhr-header:focus-within .dshhr-header-tip{opacity:1;visibility:visible;transform:translateY(0)}',
      // 失败详情面板：与 tooltip 同款绝对定位（同一容器里验证过不会被裁），失败时不显示 tooltip。
      '.dshhr-header.has-error:hover .dshhr-header-tip,.dshhr-header.has-error:focus-within .dshhr-header-tip{opacity:0;visibility:hidden}',
      '.dshhr-header-error{position:absolute;top:calc(100% + 8px);right:0;z-index:10002;width:min(520px,86vw);padding:10px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-3,#1f2328);border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.35));box-shadow:0 12px 32px rgba(0,0,0,.32);display:flex;flex-direction:column;gap:6px}',
      '.dshhr-header-error-head{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:600}',
      '.dshhr-header-error-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshhr-header-error-actions{display:flex;gap:6px;flex:none}',
      '.dshhr-header-error-body{margin:0;max-height:240px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11.5px;line-height:1.5;white-space:pre-wrap;word-break:break-word;user-select:text;cursor:text}',
      '.dshhr-header-error-button{font:inherit;font-size:11px;cursor:pointer;background:transparent;border:1px solid rgba(127,127,127,.45);border-radius:6px;padding:1px 8px;color:inherit;opacity:.85}',
      '.dshhr-header-error-button:hover{opacity:1;border-color:currentColor}',
    ].join('')

    /** 注入一次卡片样式；没有 document（或没有 head）时安静跳过。 */
    function installStyles() {
      if (typeof document === 'undefined' || document.head === undefined || document.head === null) return () => {}
      if (document.querySelector(`style[data-plugin='${PACKAGE_NAME}']`) !== null) return () => {}
      const tag = document.createElement('style')
      tag.dataset.plugin = PACKAGE_NAME
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => { tag.remove() }
    }

    /** 按钮旁提示的存在时长：成功/无事可做 2.5s，失败 6s（留够读错误）。纯函数，便于单测。 */
    function noteTtlMs(failed) {
      return failed === true ? 6000 : 2500
    }

    /** 浏览器半是否已过期（与自己加载时记下的 mtime 比对）。纯函数，便于单测。 */
    function isClientStale(loadedAt, current) {
      return typeof loadedAt === 'number' && typeof current === 'number' && loadedAt !== current
    }

    /** 请求本插件自己的 HTTP 面（同源）。失败返回 null，由调用方渲染成文字。 */
    async function requestJson(url, init) {
      try {
        const response = await fetch(url, init)
        return await response.json()
      } catch {
        return null
      }
    }

    /** 极简快照 store：一份缓存快照，publish 时重算并通知。 */
    function storeOf(compute) {
      let snapshot = compute()
      const listeners = new Set()
      return {
        getSnapshot: () => snapshot,
        subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
        publish: () => { snapshot = compute(); for (const listener of [...listeners]) listener() },
      }
    }

    /** 取一次快照，失败也不抛（渲染期不许因为表单层抖动而炸掉卡片）。 */
    function safeSnapshot(face) {
      try {
        return typeof face.snapshot === 'function' ? face.snapshot() : null
      } catch {
        return null
      }
    }

    /** 三态兜底：loading / ready / unavailable。 */
    const FALLBACK_STATE = { status: 'loading', writable: false, enabled: false }

    /**
     * 目标行的标签文案 key。
     * **这里刻意不看 inWorkspace**：「工作区」是会话/宿主的概念（工具默认只重载会话工作区内的插件），
     * 而在插件配置页里用户点某一行的「重载」本身就是点名授权 —— 显示「工作区外」只会让人困惑。
     */
    function tagKeyOf(target) {
      if (target.blockedBy === 'self' || target.pkg === PACKAGE_NAME) return 'tagSelf'
      if (target.activated === false) return 'tagNotActivated'
      return 'tagReloadable'
    }

    /** 开关控制器：把平台设置表单（scope）投影成卡片状态，并做一次带 revision 栅栏的写入。 */
    class ToggleController {
      constructor(scope) {
        this.scope = scope
        this.writing = false
        this.failed = false
        this.store = storeOf(() => this.project())
        this.unsubscribe = scope.subscribe(() => this.store.publish())
      }
      project() {
        const snapshot = this.scope.getSnapshot()
        // 三态透出：loading（表单镜像还在路上）≠ unavailable（命名空间真缺席）≠ ready。
        const status = snapshot.status === 'ready' || snapshot.status === 'loading' || snapshot.status === 'unavailable'
          ? snapshot.status
          : 'unavailable'
        return {
          status,
          available: status === 'ready',
          writable: snapshot.writable === true,
          enabled: snapshot.value !== null && typeof snapshot.value === 'object' && snapshot.value.enabled === true,
          reloadSelf: snapshot.value !== null && typeof snapshot.value === 'object' && snapshot.value.reloadSelf === true,
          allowForeign: snapshot.value !== null && typeof snapshot.value === 'object' && snapshot.value.allowForeignTargets === true,
          strict: snapshot.value !== null && typeof snapshot.value === 'object' && snapshot.value.checkStrict === true,
          intervalMs: snapshot.value !== null && typeof snapshot.value === 'object' && typeof snapshot.value.intervalMs === 'number' ? snapshot.value.intervalMs : 1000,
          minReloadIntervalMs: snapshot.value !== null && typeof snapshot.value === 'object' && typeof snapshot.value.minReloadIntervalMs === 'number' ? snapshot.value.minReloadIntervalMs : 800,
          showHeader: snapshot.value !== null && typeof snapshot.value === 'object' ? snapshot.value.showHeaderButton !== false : true,
          writing: this.writing,
          failed: this.failed,
        }
      }
      /** 写一个 volatile 字段（field 就是 schema 里的键名）。 */
      async setField(field, next) {
        const snapshot = this.scope.getSnapshot()
        if (snapshot.writable !== true || this.writing) return
        this.writing = true
        this.failed = false
        this.store.publish()
        let accepted = false
        try {
          accepted = await this.scope.mutate([{ op: 'set', path: [field], value: next }], snapshot.revision)
        } catch {
          accepted = false
        }
        this.writing = false
        this.failed = !accepted
        this.store.publish()
      }
      setEnabled(next) { return this.setField('enabled', next) }

      setReloadSelf(next) { return this.setField('reloadSelf', next) }

      setAllowForeign(next) { return this.setField('allowForeignTargets', next) }

      setStrict(next) { return this.setField('checkStrict', next) }

      /** 手动限流间隔：取整并钳到 [0, 60000]（0 = 关闭），非法输入直接忽略（不回写）。 */
      /** 头部按钮显隐：立刻作用到同一个 bundle 的 headerUi（无需重挂），再持久化到配置。 */
      setShowHeader(next) {
        headerUiSet({ hidden: next !== true })
        return this.setField('showHeaderButton', next)
      }

      setMinReloadIntervalMs(next) {
        const parsed = Math.round(Number(next))
        if (!Number.isFinite(parsed)) return undefined
        return this.setField('minReloadIntervalMs', Math.min(60_000, Math.max(0, parsed)))
      }

      /** 扫描间隔：取整并钳到 [120, 60000]，非法输入直接忽略（不回写）。 */
      setIntervalMs(next) {
        const parsed = Math.round(Number(next))
        if (!Number.isFinite(parsed)) return undefined
        return this.setField('intervalMs', Math.min(60_000, Math.max(120, parsed)))
      }

      inject() {
        return {
          hooks: { rowForm: this.store },
          snapshot: () => this.store.getSnapshot(),
          subscribe: (listener) => this.store.subscribe(listener),
          setEnabled: (next) => this.setEnabled(next),
          setReloadSelf: (next) => this.setReloadSelf(next),
          setAllowForeign: (next) => this.setAllowForeign(next),
          setStrict: (next) => this.setStrict(next),
          setIntervalMs: (next) => this.setIntervalMs(next),
          setMinReloadIntervalMs: (next) => this.setMinReloadIntervalMs(next),
          setShowHeader: (next) => this.setShowHeader(next),
        }
      }
      dispose() { this.unsubscribe() }
    }

    /** 勾选框：有首方组件就用，没有就回落纯 DOM（label + input，键盘可用）。 */
    function toggleNode({ checked, disabled, onToggle, label }) {
      const usable = typeof primitives.Checkbox === 'function' || typeof primitives.Checkbox === 'object'
      if (usable) {
        return h(primitives.Checkbox, {
          className: 'dshhr-checkbox',
          label, checked, disabled,
          'aria-describedby': HINT_ID,
          onChange: (next) => onToggle(next),
        })
      }
      return h('label', { className: 'dshhr-row' },
        h('input', {
          className: 'dshhr-checkbox',
          type: 'checkbox', checked, disabled,
          'aria-label': label,
          'aria-describedby': HINT_ID,
          onChange: (event) => onToggle(event?.target?.checked === true),
        }),
        ' ', label,
      )
    }

    /** 数字输入：首方没有对应组件，用原生 input；失焦或回车才提交，避免每敲一个字符就写一次配置。 */
    function numberNode({ key, label, value, disabled, min, max, step, onCommit }) {
      const commit = (event) => {
        const parsed = Number(event?.target?.value)
        if (!Number.isFinite(parsed)) return
        onCommit(Math.min(max, Math.max(min, Math.round(parsed))))
      }
      return h('label', { key, className: 'dshhr-row dshhr-number' },
        label,
        ' ',
        // 必须非受控：卡片定时轮询 /status 会重渲染，受控 input 的 value 会把正在输入的内容盖回去
        // （用户实测「改不了、立刻被重置」）。用 value 作 key：外部值变了才重挂显示新值，
        // 正在输入时 key 不变、文本保留。
        h('input', {
          key: `${key}-${value}`,
          className: 'dshhr-number-input',
          type: 'number', defaultValue: value, disabled, min, max, step,
          'aria-label': label,
          onBlur: commit,
          onKeyDown: (event) => { if (event?.key === 'Enter') commit(event) },
        }),
      )
    }

    /** 普通按钮（首方 Button 可用就用）。 */
    function actionButton({ key, label, onClick, disabled, className }) {
      const usable = typeof primitives.Button === 'function' || typeof primitives.Button === 'object'
      const cls = `dshhr-button ${className || ''}`.trim()
      if (usable) return h(primitives.Button, { key, className: cls, variant: 'ghost', size: 'sm', type: 'button', disabled, onClick }, label)
      return h('button', { key, className: cls, type: 'button', disabled, onClick }, label)
    }

    /** 设置页 section / 插件行 Configure 页共用的卡片。 */
    function HotReloadCard(props) {
      // t 兜底：拿不到或抛错都退回 key，绝不让卡片因为一句文案而渲染失败。
      const t = (key, params) => {
        try {
          const value = typeof props.t === 'function' ? props.t(key, params) : key
          return value === undefined || value === null ? key : String(value)
        } catch {
          return key
        }
      }
      // hook 顺序与数量必须恒定（初始化/订阅内部都 try/catch，避免首帧抛错改变 hook 链）。
      const [state, setState] = React.useState(() => safeSnapshot(props) ?? FALLBACK_STATE)
      const [status, setStatus] = React.useState(null)
      const [statusFailed, setStatusFailed] = React.useState(false)
      const [loadedMtime, setLoadedMtime] = React.useState(null)
      const [targets, setTargets] = React.useState(null)
      const [busy, setBusy] = React.useState(null)
      const [result, setResult] = React.useState(null)

      React.useEffect(() => {
        if (typeof props.subscribe !== 'function') return undefined
        return props.subscribe(() => setState(safeSnapshot(props) ?? FALLBACK_STATE))
      }, [])

      const loadStatus = async () => {
        try {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
        } catch { /* ignore */ }
        const body = await requestJson(STATUS_URL, { headers: { accept: 'application/json' } })
        if (body === null) {
          setStatusFailed(true)
          return
        }
        setStatus(body)
        setStatusFailed(false)
        setLoadedMtime((previous) => (previous === null && typeof body.clientScriptMtimeMs === 'number' ? body.clientScriptMtimeMs : previous))
      }

      const loadTargets = async () => {
        const body = await requestJson(`${STATUS_URL}/targets?all=1`, { headers: { accept: 'application/json' } })
        setTargets(body === null ? { failed: true, rows: [] } : { failed: false, rows: Array.isArray(body.targets) ? body.targets : [] })
      }

      React.useEffect(() => {
        let alive = true
        const tick = async () => { if (alive) await loadStatus() }
        void tick()
        const timer = setInterval(tick, 5000)
        return () => { alive = false; clearInterval(timer) }
      }, [])

      React.useEffect(() => {
        let alive = true
        void (async () => { if (alive) await loadTargets() })()
        return () => { alive = false }
      }, [])

      if (props.view === 'summary') return t('summary')
      const snapshot = state ?? FALLBACK_STATE
      const ready = snapshot.status === 'ready'
      const disabled = snapshot.writable !== true || ready !== true
      const stale = isClientStale(loadedMtime, status === null ? null : status.clientScriptMtimeMs)
      const lines = [
        h('h2', { key: 'title', className: 'dshhr-title' }, t('title')),
        h('div', { key: 'toggle-row', className: 'dshhr-row' },
          toggleNode({ checked: snapshot.enabled === true, disabled, onToggle: (next) => props.setEnabled(next), label: t('autoReload') })),
        h('div', { key: 'toggle-self-row', className: 'dshhr-row' },
          toggleNode({ checked: snapshot.reloadSelf === true, disabled, onToggle: (next) => props.setReloadSelf(next), label: t('autoReloadSelf') })),
        h('p', { key: 'self-hint', className: 'dshhr-hint' }, t('autoReloadSelfHint')),
        h('div', { key: 'toggle-foreign-row', className: 'dshhr-row' },
          toggleNode({ checked: snapshot.allowForeign === true, disabled, onToggle: (next) => props.setAllowForeign(next), label: t('allowForeign') })),
        h('p', { key: 'foreign-hint', className: 'dshhr-hint' }, t('allowForeignHint')),
        h('div', { key: 'toggle-strict-row', className: 'dshhr-row' },
          toggleNode({ checked: snapshot.strict === true, disabled, onToggle: (next) => props.setStrict(next), label: t('strict') })),
        h('p', { key: 'strict-hint', className: 'dshhr-hint' }, t('strictHint')),
        h('div', { key: 'header-toggle' },
          toggleNode({ checked: snapshot.showHeader !== false, disabled, onToggle: (next) => props.setShowHeader(next), label: t('showHeader') })),
        h('p', { key: 'header-toggle-hint', className: 'dshhr-hint' }, t('showHeaderHint')),
        h('div', { key: 'interval-row', className: 'dshhr-row' },
          numberNode({
            key: 'interval-input',
            label: t('interval'),
            value: snapshot.intervalMs,
            disabled,
            min: 120, max: 60000, step: 50,
            onCommit: (next) => props.setIntervalMs(next),
          })),
        h('p', { key: 'interval-hint', className: 'dshhr-hint' }, t('intervalHint')),
        h('div', { key: 'limit-row', className: 'dshhr-row' },
          numberNode({
            key: 'limit-input',
            label: t('limitInterval'),
            value: snapshot.minReloadIntervalMs,
            disabled,
            min: 0, max: 60000, step: 100,
            onCommit: (next) => props.setMinReloadIntervalMs(next),
          })),
        h('p', { key: 'limit-hint', className: 'dshhr-hint' }, t('limitIntervalHint')),
      ]
      const hint = snapshot.status === 'loading' ? t('loading') : (ready ? t('hint') : t('unavailable'))
      lines.push(h('p', { key: 'hint', id: HINT_ID, className: 'dshhr-hint' }, hint))
      if (ready && snapshot.writable !== true) lines.push(h('p', { key: 'readonly', className: 'dshhr-hint' }, t('readOnly')))
      if (stale) lines.push(h('p', { key: 'stale', className: 'dshhr-status dshhr-stale', 'aria-live': 'polite' }, t('staleClient')))
      if (snapshot.writing) lines.push(h('p', { key: 'writing', className: 'dshhr-hint', 'aria-live': 'polite' }, t('writing')))
      if (snapshot.failed) lines.push(h('p', { key: 'failed', className: 'dshhr-hint dshhr-error', role: 'alert' }, t('saveFailed')))
      if (statusFailed) {
        lines.push(h('p', { key: 'nostatus', className: 'dshhr-status', 'aria-live': 'polite' }, t('statusUnavailable')))
      } else if (status !== null) {
        const count = Array.isArray(status.watch) ? status.watch.length : 0
        const files = typeof status.scannedFiles === 'number' ? status.scannedFiles : 0
        const reloads = typeof status.reloads === 'number' ? status.reloads : 0
        lines.push(h('p', { key: 'status', className: 'dshhr-status', 'aria-live': 'polite' },
          t('status', { targets: count, files, reloads })))
      }

      // ---- 手动重载指定插件 ----
      const rows = targets === null ? [] : (targets.rows || [])
      const reload = async (row) => {
        setBusy(row.pkg)
        setResult(null)
        const body = await requestJson(`${STATUS_URL}/reload`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          // 显式带上该目标自己的包根作为作用域：这就是「用户点名重载这一个」的授权，
          // 否则工作区外的插件（npm 装进 profile 的那些）会被护栏跳过。
          body: JSON.stringify({ targets: [row.pkg], workspace: row.root }),
        })
        setBusy(null)
        if (body === null) {
          setResult({ pkg: row.pkg, ok: false, text: t('reloadFailed') })
        } else {
          const failed = Array.isArray(body.failed) && body.failed.length > 0
          const reloaded = Array.isArray(body.reloaded) && body.reloaded.length > 0
          setResult({
            pkg: row.pkg,
            ok: body.ok === true && !failed && reloaded,
            text: failed
              ? `${t('reloadFailed')}: ${body.failed[0].error}`
              : (reloaded ? t('reloadOk') : t('reloadSkipped')),
          })
        }
        void loadTargets()
      }
      lines.push(h('div', { key: 'manual-head', className: 'dshhr-toolbar' },
        h('h3', { key: 'manual-title', className: 'dshhr-toolbar-title' }, t('manualTitle')),
        actionButton({ key: 'refresh', label: t('refreshList'), disabled: busy !== null, onClick: () => { setResult(null); void loadTargets() } })))
      lines.push(h('p', { key: 'manual-hint', className: 'dshhr-hint' }, t('manualHint')))
      if (targets === null) {
        lines.push(h('p', { key: 'list-loading', className: 'dshhr-hint' }, t('loadingList')))
      } else if (targets.failed) {
        lines.push(h('p', { key: 'list-failed', className: 'dshhr-hint dshhr-error', role: 'alert' }, t('listFailed')))
      } else if (rows.length === 0) {
        lines.push(h('p', { key: 'list-empty', className: 'dshhr-hint' }, t('noTargets')))
      } else {
        lines.push(h('ul', { key: 'list', className: 'dshhr-list' }, rows.map((row) => {
          const tag = tagKeyOf(row)
          const isSelf = row.blockedBy === 'self' || row.pkg === PACKAGE_NAME
          const hit = result !== null && result.pkg === row.pkg
          // 能不能重载只看宿主报的「该插件是否在运行」（activated）：与目录、作用域无关。
          // ① **作用域（工作区）是 hot_reload 工具的门限**，不是插件配置页要展示的东西；点行时界面会把
          //    该目标自己的包根作为 scope 传下去，所以作用域对用户是透明的。
          // ② 也不能依赖 manualReloadable：那是较新宿主才有的字段，宿主半没自升级时不会报它；
          //    activated 一直都有，用它判断才不会出现「明明在运行却说无法重载」。
          const canReloadRow = isSelf !== true && row.activated !== false
          return h('li', { key: row.pkg, className: 'dshhr-item' },
            h('div', { key: 'main', className: 'dshhr-item-main' },
              h('div', { key: 'head', className: 'dshhr-item-head' },
                h('span', { key: 'pkg', className: 'dshhr-pkg' }, row.pkg),
                tag === undefined ? null : h('span', { key: 'tag', className: 'dshhr-tag' }, t(tag))),
              hit
                ? h('div', { key: 'result', className: `dshhr-result ${result.ok ? '' : 'dshhr-error'}`.trim(), role: result.ok ? undefined : 'alert' }, result.text)
                : null),
            h('div', { key: 'action', className: 'dshhr-item-action' },
              canReloadRow
                ? actionButton({ key: 'reload', label: busy === row.pkg ? t('reloading') : t('reloadOne'), disabled: busy !== null, onClick: () => { void reload(row) } })
                : (isSelf ? null : h('span', { key: 'note', className: 'dshhr-note' }, t('reasonNotActivated')))),
          )
        })))
      }
      if (rows.length > 0) lines.push(h('p', { key: 'tags-hint', className: 'dshhr-hint' }, t('tagsHint')))
      return h('div', { className: 'dshhr-card' }, lines)
    }

    /** 兜底渲染：任何异常都变成可见文字（空白页是最难排查的失败形态）。 */
    const EMPTY_WORKSPACES = []

    /**
     * 头部按钮的 UI 记忆：放在 apply 闭包里（有主的共享状态）。
     * 平台在会话/槽位刷新时可能注销再重建贡献、组件随之重挂；状态若只在组件内，重挂就会丢，
     * 首帧再因「查不到项目」返回 null ⇒ 视觉上就是「消失一瞬又出现」。放这里就不会。
     */
    const headerUi = { project: null, hidden: false, busy: false, flash: '', failed: false, reason: '', error: '', listeners: new Set() }
    const headerUiSet = (patch) => {
      Object.assign(headerUi, patch)
      for (const listener of [...headerUi.listeners]) {
        try { listener() } catch { /* 单个订阅者出错不影响其他订阅者 */ }
      }
    }

    /**
     * 会话头部右侧的快捷按钮：重载「当前对话所属项目」里的插件。
     *
     * 注册到 conversation.session.header.utilities —— 与 dsh-save-money 同款做法：
     * 它是 kind:'list'、scope:'session' 的列表槽，允许多个贡献；不要往
     * conversation.header（kind:'single'）里注册，那会让首方 ui-conversation 激活失败（实测崩过）。
     */
    function ReloadProjectButton(props) {
      const t = (key, params) => {
        try {
          const value = typeof props.t === 'function' ? props.t(key, params) : key
          return value === undefined || value === null ? key : String(value)
        } catch {
          return key
        }
      }
      // 座位存在与否交给不同组件处理：组件类型不同 ⇒ 切换时各自的 hooks 数量稳定，不会违反 hooks 规则。
      return typeof props.useWorkspaces === 'function'
        ? h(ReloadProjectButtonWithSeat, { ...props, t })
        : h(ReloadProjectButtonNoSeat, { ...props, t })
    }

    function ReloadProjectButtonWithSeat(props) {
      const items = props.useWorkspaces((snapshot) => (snapshot && Array.isArray(snapshot.items) ? snapshot.items : EMPTY_WORKSPACES))
      const sessionId = props.sessionId
      const lookup = Array.isArray(items) && typeof sessionId === 'string'
        ? items.find((item) => Array.isArray(item?.sessionIds) && item.sessionIds.includes(sessionId))
        : undefined
      // 同一帧内先写记忆再渲染子组件：子组件首帧就能拿到项目，不会返回 null。
      if (lookup !== undefined && typeof lookup?.path === 'string' && lookup.path !== '') headerUi.project = lookup
      return h(HeaderButtonBody, props)
    }

    function ReloadProjectButtonNoSeat(props) {
      return h(HeaderButtonBody, props)
    }

    function HeaderButtonBody(props) {
      const t = props.t
      // 只用 state 做「重渲染开关」；真正的界面状态在 headerUi 里，重挂也不丢。
      const [, bump] = React.useState(0)
      // 「已复制」是纯组件内瞬态，重挂丢失无所谓。
      const [copied, setCopied] = React.useState(false)
      React.useEffect(() => {
        // 排障开关：localStorage.setItem('dshhr-debug','1') 后，控制台会记录每次挂载/卸载，
        // 用来确认「闪动」到底是不是组件被平台重建导致的。默认静默。
        const debug = (() => {
          try { return globalThis.localStorage?.getItem('dshhr-debug') === '1' } catch { return false }
        })()
        if (debug === true) { try { console.debug('[dsh-hot-reloader] header button mount') } catch { /* ignore */ } }
        const listener = () => { bump((n) => n + 1) }
        headerUi.listeners.add(listener)
        return () => {
          headerUi.listeners.delete(listener)
          if (debug === true) { try { console.debug('[dsh-hot-reloader] header button unmount') } catch { /* ignore */ } }
        }
      }, [])

      // 挂载时从宿主读一次「是否显示」：用户在设置页关掉后，重开界面也不会再出现按钮。
      // 之后的开/关由卡片通过 headerUiSet 直接作用在同一个 bundle 的 headerUi 上（无需重载）。
      React.useEffect(() => {
        let alive = true
        void (async () => {
          const body = await requestJson(STATUS_URL, { headers: { accept: 'application/json' } })
          if (alive !== true || body === null || body === undefined) return
          headerUiSet({ hidden: body.showHeaderButton === false })
        })()
        return () => { alive = false }
      }, [])

      // 错误内容换了就把「已复制」复位（同一个按钮会被不同错误复用）。
      React.useEffect(() => { setCopied(false) }, [headerUi.error])

      // 用户在设置页关掉了这个按钮：整个组件返回 null（此时是用户明确要求隐藏，不是闪动）。
      if (headerUi.hidden === true) return null

      // 永远渲染（项目未定位时只是禁用）：平台重建贡献会让组件重挂，若这里 return null，
      // 重挂首帧就是空白 ⇒ 视觉上「消失一瞬又出现」。宁可显示一个禁用的按钮，也不留空帧。
      const workspace = headerUi.project
      const hasProject = workspace !== null && workspace !== undefined
        && typeof workspace.path === 'string' && workspace.path !== ''

      // 结果直接写在按钮文字里，到时自动恢复常态（成功/无事可做 2.5s，失败 6s）。
      // 只清「仍是这一条」的状态，免得后一次点击的结果被前一次的定时器提前抹掉；timer unref。
      const flashLabel = (flash, failed, reason, fullError) => {
        headerUiSet({
          busy: false,
          flash,
          failed: failed === true,
          reason: reason === undefined ? '' : String(reason),
          // 失败详情单独存：按钮文案到点会恢复，但错误全文要留到用户自己关掉（否则来不及读/复制）。
          error: fullError === undefined ? '' : String(fullError),
        })
        const timer = setTimeout(() => {
          if (headerUi.flash !== flash) return
          headerUiSet({ busy: false, flash: '', failed: false, reason: '' })
        }, noteTtlMs(failed))
        timer.unref?.()
      }

      const onClick = async () => {
        if (headerUi.busy || hasProject !== true) return
        headerUiSet({ busy: true, flash: '', failed: false, reason: '', error: '' })
        try {
          const body = await requestJson(STATUS_URL + '/reload', {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ workspace: workspace.path }),
          })
          const reloaded = Array.isArray(body?.reloaded) ? body.reloaded.length : 0
          const failed = Array.isArray(body?.failed) ? body.failed : []
          if (failed.length > 0) {
            // 全量错误：每个失败目标一行「包名 + 错误」，多行时用空行隔开；面板里原样展示并可复制。
            const full = failed.map((row) => {
              const pkg = row?.pkg || row?.root || '?'
              const detail = String(row?.error || row?.message || 'failed')
              const extra = row?.message && row.message !== row.error ? `\n${row.message}` : ''
              return `${pkg}\n${detail}${extra}`
            }).join('\n\n')
            flashLabel(t('reloadProjectFailedShort'), true, String(failed[0]?.error || failed[0]?.message || 'failed'), full)
            return
          }
          const throttled = (Array.isArray(body?.skipped) ? body.skipped : []).some((row) => row?.reason === 'throttled')
          if (reloaded === 0 && throttled) {
            flashLabel(t('reloadProjectThrottled'), false)
            return
          }
          const skippedRows = Array.isArray(body?.skipped) ? body.skipped : []
          // 三种「没重载」要分清：被限流 / 命中但没有实际重载 / 项目里根本没有已加载插件。
          if (reloaded === 0 && skippedRows.length === 0) {
            flashLabel(t('reloadProjectNoTarget'), false)
            return
          }
          flashLabel(reloaded > 0 ? t('reloadProjectDone', { count: reloaded }) : t('reloadProjectNone'), false)
        } catch (error) {
          const text = String(error?.message || error)
          flashLabel(t('reloadProjectFailedShort'), true, text, text)
        }
      }

      const projectName = hasProject ? (workspace.title || workspace.path) : ''
      const tipId = 'dshhr-header-tip'
      // 内联 SVG + currentColor：跟随主题色，不引入图标依赖。
      const icon = h('svg', {
        className: 'dshhr-header-icon',
        viewBox: '0 0 16 16',
        width: 14,
        height: 14,
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': 1.6,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        'aria-hidden': 'true',
      },
        h('path', { d: 'M13.2 8.4a5.2 5.2 0 1 1-1.75-4.1' }),
        h('path', { d: 'M13.6 2.8v3.4h-3.4' }),
      )
      const idleLabel = t('reloadProject')
      // 候选文案：宽度由它们里最宽的一条决定（含一个两位数的「已重载 NN 个」预估值），
      // 这样结果计数从个位数变两位数时按钮也不会变宽。
      const doneSizer = t('reloadProjectDone', { count: 88 })
      const activeLabel = hasProject !== true
        ? idleLabel
        : (headerUi.busy === true ? t('reloadProjectBusy') : headerUi.flash || idleLabel)
      const labelCandidates = [idleLabel, t('reloadProjectBusy'), doneSizer, t('reloadProjectNone'), t('reloadProjectFailedShort')]

      // 失败详情面板：显示错误全文，并提供「复制错误」——用户经常要把整段报错贴给别人看。
      const errorText = typeof headerUi.error === 'string' ? headerUi.error : ''
      const copyError = async () => {
        if (errorText === '') return
        let ok = false
        try {
          const clipboard = globalThis.navigator?.clipboard
          if (clipboard && typeof clipboard.writeText === 'function') {
            await clipboard.writeText(errorText)
            ok = true
          }
        } catch { ok = false }
        if (ok !== true) {
          // 回退：离屏 textarea + execCommand（http 页面 / 受限权限下 clipboard API 不可用）。
          try {
            const doc = globalThis.document
            const area = doc.createElement('textarea')
            area.value = errorText
            area.setAttribute('readonly', '')
            area.style.position = 'fixed'
            area.style.top = '-1000px'
            doc.body.appendChild(area)
            area.select()
            ok = doc.execCommand('copy') === true
            area.remove()
          } catch { ok = false }
        }
        setCopied(ok === true)
        if (ok === true) {
          const timer = setTimeout(() => setCopied(false), 1500)
          timer.unref?.()
        }
      }
      return h('div', { className: errorText === '' ? 'dshhr-header' : 'dshhr-header has-error' },
        h('button', {
          className: 'dshhr-header-button',
          type: 'button',
          disabled: hasProject !== true || headerUi.busy === true,
          'data-failed': headerUi.failed === true ? 'true' : undefined,
          'aria-label': hasProject === true ? `${activeLabel}：${projectName}` : `${activeLabel}（${t('reloadProjectNoProject')}）`,
          'aria-describedby': tipId,
          onClick,
        }, icon, h('span', { className: 'dshhr-header-stack' },
          // 隐藏的尺寸项负责撑宽度；可见项是当前状态。
          ...labelCandidates.map((candidate, index) => h('span', {
            key: 'size-' + index,
            className: 'dshhr-header-label-item',
            'aria-hidden': 'true',
          }, candidate)),
          h('span', { className: 'dshhr-header-label-item is-on', 'aria-live': 'polite' }, activeLabel),
        )),
        errorText === '' ? null : h('div', { key: 'error', className: 'dshhr-header-error', role: 'alert' },
          h('div', { key: 'error-head', className: 'dshhr-header-error-head' },
            h('span', { key: 'error-title', className: 'dshhr-header-error-title' }, t('reloadProjectErrorTitle')),
            h('span', { key: 'error-actions', className: 'dshhr-header-error-actions' },
              h('button', {
                key: 'error-copy',
                type: 'button',
                className: 'dshhr-header-error-button',
                onClick: () => copyError(),
              }, copied === true ? t('reloadProjectCopied') : t('reloadProjectCopy')),
              h('button', {
                key: 'error-dismiss',
                type: 'button',
                className: 'dshhr-header-error-button',
                onClick: () => headerUiSet({ error: '' }),
              }, t('reloadProjectDismiss')))),
          h('pre', { key: 'error-body', className: 'dshhr-header-error-body' }, errorText)),
        h('span', { className: 'dshhr-header-tip', id: tipId, role: 'tooltip' },
          h('span', { className: 'dshhr-header-tip-title' },
            hasProject !== true
              ? t('reloadProjectNoProject')
              : (headerUi.failed === true && headerUi.reason !== ''
                ? t('reloadProjectFailed', { reason: headerUi.reason })
                : t('reloadProjectTip', { project: projectName }))),
          h('span', { className: 'dshhr-header-tip-hint' }, t('reloadProjectTipHint')),
        ),
      )
    }

    function HotReloadCardSafe(props) {
      try {
        return HotReloadCard(props)
      } catch (error) {
        return h('div', { className: 'dshhr-card' },
          h('p', { className: 'dshhr-hint dshhr-error' }, 'dsh-hot-reloader card error: ' + (error?.message || error)))
      }
    }

    /** 客户端插件入口。 */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-hot-reloader: dictionaries')
      ctx.effect(() => installStyles(), 'dsh-hot-reloader: stylesheet')
      // 平台的 configForms.get(entryId) 对未服务条目也返回控制器（从不抛），未服务体现在 snapshot.status；
      // 这里的 try/catch 只是防实现变化，不冒泡即可。
      let controller
      try {
        controller = new ToggleController(ctx.configForms.get(ROW_ID))
      } catch {
        return
      }
      ctx.effect(() => () => controller.dispose(), 'dsh-hot-reloader: form')

      // 座位零：会话头部右侧 utilities（kind:list，与 dsh-save-money 同款）。
      // 不要用 conversation.header —— 那是 single 槽，注册会让首方 ui-conversation 激活失败。
      ctx.effect(
        () => {
          try {
            // 形状照 dsh-save-money：只给 name/id/order，文案用闭包里的翻译（不依赖 props.t）。
            const translate = (key, params) => {
              try {
                const value = ctx.locale.bind(NS)(key, params)
                return value === undefined || value === null ? key : String(value)
              } catch {
                return key
              }
            }
            return ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register(
              { name: 'conversation.session.header.utilities', id: 'hot-reloader-project', order: 40 },
              (props) => ReloadProjectButton({ ...props, t: translate }),
            ))
          } catch (error) {
            try { console.warn('[dsh-hot-reloader] 头部按钮注册失败：', error?.message || error) } catch { /* ignore */ }
            return undefined
          }
        },
        'dsh-hot-reloader: session header button',
      )

      // 座位一：设置页 section（主入口，菜单标题取自 label）。
      ctx.effect(
        () => ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: SECTION_ID,
          order: SECTION_ORDER,
          label: () => ctx.locale.bind(NS)('title'),
          locale: NS,
          inject: () => controller.inject(),
        }, HotReloadCardSafe)),
        'dsh-hot-reloader: settings section',
      )

      // 座位二：插件行 Configure 页（首方 UI 有渲染者；本部署没有——注册无害）。
      ctx.effect(
        () => ctx.configForms.whileServed([ROW_ID], () =>
          ctx.slots.inject('plugins.row.config', () =>
            ctx.slots.register({ name: 'plugins.row.config', key: ROW_KEY, locale: NS, inject: () => controller.inject() }, HotReloadCardSafe))),
        'dsh-hot-reloader: row config page',
      )
    }

    exports.apply = apply
    exports.inject = inject
    exports.NS = NS
    exports.__internals = { ROW_ID, ROW_KEY, SECTION_ID, SECTION_ORDER, PACKAGE_NAME, STATUS_URL, ToggleController, HotReloadCard, HotReloadCardSafe, storeOf, isClientStale, tagKeyOf, noteTtlMs }
    return module.exports
  },
})
