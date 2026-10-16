/**
 * dsh-hot-reloader — browser half.
 *
 * 宿主半把「自动重载开关」declare 成 Config schema 里的 volatile 字段，于是它被平台的设置服务
 * 寻址（浏览器侧 `ctx.configForms.get(entryId)`，宿主侧 `settings`）。这一半只做一件事：
 * 在 Web 的「插件」页上给本插件那行挂一张 **Configure 卡片**，通过 `plugins.row.config` 槽、
 * 键为 `<包名>#<行 id>`，让用户不必手改 cordis.patch.yml。
 *
 * 为什么需要它：不是每个部署都装了「自动生成设置页」的外壳——本机 profile 用的是第三方 UI 全家桶，
 * 它的 client.js 完全不读 autoGenerate。所以配置项必须由插件自己的浏览器半渲染。
 *
 * 写入走平台自己的设置表单：`scope.mutate([{op:'set',path:['enabled'],value}], revision)`，
 * 并带 revision 栅栏（别人先写过就拒绝而不是覆盖）。本模块不拥有任何存储。
 *
 * 与宿主半的约定：row id 必须与 cordis.patch.yml 里的 `id: dsh-hot-reloader` 一致。
 *
 * @module dsh-hot-reloader/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-hot-reloader',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement

    /** 词典命名空间（本插件独占）。 */
    const NS = 'settings.hot-reloader'
    /** 本浏览器半所属的包；槽键的前缀。 */
    const PACKAGE_NAME = 'dsh-hot-reloader'
    /** 行 id，与 cordis.patch.yml 的 `id: dsh-hot-reloader` 必须一致。 */
    const ROW_ID = 'dsh-hot-reloader'
    /** 槽键：`<包名>#<行 id>`（平台的 rowConfigKey 约定）。 */
    const ROW_KEY = `${PACKAGE_NAME}#${ROW_ID}`
    /** 本插件自己的只读状态端点（同源、仅回环）。 */
    const STATUS_URL = '/dsh-hot-reloader'

    /** 需要的客户端服务。 */
    const inject = ['slots', 'locale', 'configForms']

    const en = {
      summary: 'Edit plugin source and let the host reload it in place — no restart.',
      title: 'Hot reloader',
      hint: 'Watching every installed plugin\'s package root. Turning this off stops the polling; manual reloads (POST /dsh-hot-reloader/reload) and the hot_reload agent tool keep working.',
      autoReload: 'Automatic hot reload',
      unavailable: 'This row is not loaded, so it cannot be configured right now.',
      readOnly: 'This deployment stores settings read-only.',
      saveFailed: 'The deployment did not accept the change; the switch was left as it was.',
      writing: 'Applying…',
      status: (count, files, reloads) => `Watching ${count} targets / ${files} files · ${reloads} reloads since start`,
      statusUnavailable: 'Status endpoint unreachable (host not running?).',
      on: 'Automatic hot reload is ON',
      off: 'Automatic hot reload is OFF',
    }
    const zh = {
      summary: '改完插件源码让宿主原地重载，不用重启。',
      title: '热重载器',
      hint: '正在盯住所有已安装插件的包根。关掉它只停轮询；手动重载（POST /dsh-hot-reloader/reload）与 hot_reload 工具照常可用。',
      autoReload: '自动热重载',
      unavailable: '该行当前未加载，无法配置。',
      readOnly: '本部署的设置是只读的。',
      saveFailed: '宿主没有接受这次改动，开关保持原样。',
      writing: '正在应用…',
      status: (count, files, reloads) => `正在监听 ${count} 个目标 / ${files} 个文件 · 启动以来 ${reloads} 次重载`,
      statusUnavailable: '状态端点不可达（宿主没在跑？）。',
      on: '自动热重载：开',
      off: '自动热重载：关',
    }

    /** 本卡片自己的样式，按包名标注以便卸载时能被清掉。 */
    const STYLE_ID = 'hot-reloader-card'
    const CSS = [
      `${'.dshhr-card{margin:0 0 14px}'}`,
      `${'.dshhr-hint{margin:6px 0 0;font-size:12px;opacity:.65;line-height:1.5}'}`,
      `${'.dshhr-status{margin:10px 0 0;font-size:12px;opacity:.75;font-variant-numeric:tabular-nums}'}`,
      `${'.dshhr-error{color:var(--dsw-alias-state-warn-primary,inherit)}'}`,
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

    /**
     * 开关控制器：把平台设置表单（scope）投影成卡片要渲染的状态，并做一次带 revision 栅栏的写入。
     * 不做草稿/批量（本卡片只有一个开关），但仍按平台语义一次写一个 op。
     */
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
        return {
          available: snapshot.status === 'ready',
          writable: snapshot.writable === true,
          enabled: snapshot.value !== null && typeof snapshot.value === 'object' && snapshot.value.enabled === true,
          writing: this.writing,
          failed: this.failed,
        }
      }
      async setEnabled(next) {
        const snapshot = this.scope.getSnapshot()
        if (snapshot.writable !== true || this.writing) return
        this.writing = true
        this.failed = false
        this.store.publish()
        let accepted = false
        try {
          accepted = await this.scope.mutate([{ op: 'set', path: ['enabled'], value: next }], snapshot.revision)
        } catch {
          accepted = false
        }
        this.writing = false
        this.failed = !accepted
        this.store.publish()
      }
      /** 槽 inject 交给卡片的门面。 */
      inject() {
        return { hooks: { rowForm: this.store }, setEnabled: (next) => this.setEnabled(next) }
      }
      dispose() { this.unsubscribe() }
    }

    /** 插件页上本插件那行的 Configure 卡片。 */
    function HotReloadCard(props) {
      const t = props.t
      const state = props.useRowForm((snapshot) => snapshot)
      const [status, setStatus] = React.useState(null)
      const [statusFailed, setStatusFailed] = React.useState(false)
      React.useEffect(() => {
        let alive = true
        const load = async () => {
          try {
            const response = await fetch(STATUS_URL, { headers: { accept: 'application/json' } })
            if (!response.ok) throw new Error(String(response.status))
            const body = await response.json()
            if (alive) { setStatus(body); setStatusFailed(false) }
          } catch {
            if (alive) setStatusFailed(true)
          }
        }
        void load()
        const timer = setInterval(load, 5000)
        return () => { alive = false; clearInterval(timer) }
      }, [])
      if (props.view === 'summary') return t('summary')
      const disabled = state.writable !== true || state.available !== true
      const lines = [
        h('div', { key: 'row', className: 'dshhr-card' },
          h(primitives.Checkbox, {
            key: 'toggle',
            label: t('autoReload'),
            checked: state.enabled,
            disabled,
            onChange: (next) => props.setEnabled(next),
          }),
          h('p', { key: 'hint', className: 'dshhr-hint' }, state.available ? t('hint') : t('unavailable')),
        ),
      ]
      if (state.writing) lines.push(h('p', { key: 'writing', className: 'dshhr-hint' }, t('writing')))
      if (state.failed) lines.push(h('p', { key: 'failed', className: 'dshhr-hint dshhr-error' }, t('saveFailed')))
      if (state.available && state.writable !== true) lines.push(h('p', { key: 'ro', className: 'dshhr-hint' }, t('readOnly')))
      if (statusFailed) lines.push(h('p', { key: 'nostatus', className: 'dshhr-status' }, t('statusUnavailable')))
      else if (status !== null) {
        lines.push(h('p', { key: 'status', className: 'dshhr-status' }, t('status',
          Array.isArray(status.watch) ? status.watch.length : 0,
          typeof status.scannedFiles === 'number' ? status.scannedFiles : 0,
          typeof status.reloads === 'number' ? status.reloads : 0)))
      }
      return h('div', { className: 'dshhr-card' }, lines)
    }

    /** 客户端插件入口。 */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-hot-reloader: dictionaries')
      ctx.effect(() => installStyles(), 'dsh-hot-reloader: stylesheet')
      // 宿主没服务这个 row（例如插件被禁用）时 get() 会抛：整半插件安静退出，不要连累别的页面。
      let controller
      try {
        controller = new ToggleController(ctx.configForms.get(ROW_ID))
      } catch {
        return
      }
      ctx.effect(() => () => controller.dispose(), 'dsh-hot-reloader: form')
      ctx.effect(
        () => ctx.configForms.whileServed([ROW_ID], () =>
          ctx.slots.inject('plugins.row.config', () =>
            ctx.slots.register({ name: 'plugins.row.config', key: ROW_KEY, locale: NS, inject: () => controller.inject() }, HotReloadCard))),
        'dsh-hot-reloader: page',
      )
    }

    exports.apply = apply
    exports.inject = inject
    exports.NS = NS
    exports.__internals = { ROW_ID, ROW_KEY, PACKAGE_NAME, STATUS_URL, ToggleController, HotReloadCard, storeOf }
    return module.exports
  },
})
