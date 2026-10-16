/**
 * 持久开关桥：把「自动重载开关」落到宿主的 profile patch（唯一持久真源）。
 *
 * 为什么不自己写状态文件：DSH 的 settings 服务（SettingsForms）本来就把插件的 Config schema
 * 投影成设置页并写进 profile patch，读回则通过 volatile 活引用即时生效。多一层状态文件只会
 * 引入「配置默认 vs 运行期覆盖」的优先级歧义。
 *
 * 错误一律转成结果对象（不向上抛）：HTTP 路由与 LLM 工具都要把失败原因回给调用方。
 * enabled=null 的语义是「恢复默认」——本项目只有一层持久配置，没有可撤销的覆盖层。
 */
import { DEFAULTS } from './config.js'

/**
 * @param {object} input
 * @param {() => object | undefined} input.getService 取 settings 服务（宿主没装时为 undefined）
 * @param {string | (() => string | undefined)} [input.entryId] 本插件在 profile patch 里的条目 id
 * @param {{warn?: Function, info?: Function}} [input.logger]
 * @returns {{ available: () => boolean, readEnabled: () => boolean | undefined, write: (input: {enabled: boolean | null}) => Promise<object> }}
 */
export function createSettingsBridge({ getService, entryId, logger } = {}) {
  const resolveEntryId = () => {
    try {
      const value = typeof entryId === 'function' ? entryId() : entryId
      return typeof value === 'string' && value !== '' ? value : undefined
    } catch {
      return undefined
    }
  }

  const service = () => {
    try {
      return getService?.()
    } catch {
      return undefined
    }
  }

  const descriptorOf = (svc, ns) => {
    try {
      const list = svc.describe?.() ?? []
      return list.find((row) => row?.ns === ns)
    } catch {
      return undefined
    }
  }

  return {
    available() {
      return Boolean(service())
    },

    /** 当前持久值（诊断用；生效值请读配置层，见 lib/config.js 的 makeConfigReader）。 */
    readEnabled() {
      const svc = service()
      if (!svc) return undefined
      const ns = resolveEntryId()
      if (!ns) return undefined
      const value = descriptorOf(svc, ns)?.value
      return value !== null && typeof value === 'object' && 'enabled' in value ? value.enabled : undefined
    },

    /**
     * 写入持久开关。
     * @param {{enabled: boolean | null}} input null = 恢复默认
     * @returns {Promise<{ok: true, enabled: boolean, entryId: string} | {ok: false, error: string, entryId?: string, revision?: number, message?: string}>}
     */
    async write({ enabled } = {}) {
      const svc = service()
      if (!svc) return { ok: false, error: 'settings-unavailable' }
      const ns = resolveEntryId()
      if (!ns) return { ok: false, error: 'entry-not-found' }
      const descriptor = descriptorOf(svc, ns)
      if (!descriptor) return { ok: false, error: 'not-configurable', entryId: ns }
      const next = enabled === null || enabled === undefined
        ? DEFAULTS.enabled
        : (enabled === true || enabled === false ? enabled : undefined)
      if (next === undefined) return { ok: false, error: 'invalid-enabled', entryId: ns }
      try {
        await svc.update(ns, { enabled: next }, descriptor.revision)
        return { ok: true, enabled: next, entryId: ns }
      } catch (error) {
        const message = error?.message || String(error)
        if (error?.name === 'SettingsConflictError' || /changed since it was read/i.test(message)) {
          return { ok: false, error: 'conflict', entryId: ns, revision: error?.actual }
        }
        try {
          logger?.warn?.(`[hot-reloader] 写配置失败：${message}`)
        } catch { /* logger 不可用不影响返回 */ }
        return { ok: false, error: 'write-failed', entryId: ns, message }
      }
    },
  }
}
