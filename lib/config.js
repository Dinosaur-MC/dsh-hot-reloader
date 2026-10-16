/**
 * 配置层：Config schema（宿主设置页据此生成表单）+ 运行期配置读取。
 *
 * 三条约束（都由宿主机制决定，改这里之前先读 docs 里的设计稿）：
 *   1. 插件一旦导出 Config，cordis 的 resolveConfig 就会按 schema 校验并**裁掉未声明的键**
 *      ——所以 DEFAULTS 的每个键都必须在 schema 里有对应字段。
 *   2. 只有标了 .volatile() 的字段才能被设置页**免重挂**地改写；volatile 字段的值是带
 *      .get() 的活引用，必须在读取处解包（见 unwrapVolatile）。
 *   3. peer 包（schemastery）用动态 import + 探测：宿主没提供或版本过旧时
 *      Config 为 undefined —— 插件降级为「无设置页」，但 DEFAULTS 仍保证配置语义完整。
 *
 * 为什么 intervalMs 不标 volatile：它在注册轮询定时器时读一次，标成 volatile 会让设置页
 * 谎称「改完即时生效」。改它需要宿主重挂该 fiber，语义清晰。
 */

/** 内置默认值：既是没有 schema 时的兜底，也是 schema 的镜像（两边必须同步）。 */
export const DEFAULTS = {
  /** 自动重载总开关。 */
  enabled: true,
  /** 轮询间隔（毫秒）。改动需重挂 fiber。 */
  intervalMs: 1000,
  /** 检测到变更后等写入稳定的时间（毫秒）。 */
  debounceMs: 400,
  /** 额外监听的目录（绝对路径）。 */
  extraRoots: [],
  /** 只监听这些包名（留空 = 全部）。 */
  only: [],
  /** 跳过的包名。 */
  except: [],
  /** 扫描时按文件名子串跳过。 */
  ignore: ['.bak', '.test.', '.spec.', '.map'],
  /** 目录递归深度上限。 */
  maxDepth: 8,
  /** 是否允许自动重载本插件自己。 */
  reloadSelf: false,
  /** 是否连 app.asar 内的宿主包一起监听。 */
  includeAsar: false,
  /** 认定「包管理操作仍在进行」的时间窗（毫秒）；0 = 关闭该让路机制。 */
  installQuietMs: 8000,
  /** profile 目录；默认取 DSH_PROFILE_DIR。 */
  profileDir: '',
  /** 静默模式：只记录失败。 */
  quiet: false,
  /** 是否允许 LLM 工具/手动重载「包根落在会话工作区之外」的插件。 */
  allowForeignTargets: false,
}

/**
 * 深解包 volatile 引用：cosmokit 的活引用形态是「带 get() 的对象」。
 * 非引用值（含 false / 0 / 空字符串 / 空数组）原样返回，绝不把 falsy 当成缺失。
 * @param {unknown} value
 * @returns {unknown}
 */
export function unwrapVolatile(value) {
  if (Array.isArray(value)) return value.map(unwrapVolatile)
  if (value === null || typeof value !== 'object') return value
  if (typeof value.get === 'function') return unwrapVolatile(value.get())
  const out = {}
  for (const [key, child] of Object.entries(value)) out[key] = unwrapVolatile(child)
  return out
}

/**
 * 造一个运行期配置读取器：每次调用都重新解包，因此 volatile 字段改动立刻可见。
 * 显式的 undefined 不覆盖默认值：{ enabled: undefined } 必须回落到 true。
 * @param {object} rawConfig apply() 收到的原始配置（可能含 volatile 引用）
 * @returns {() => typeof DEFAULTS}
 */
export function makeConfigReader(rawConfig) {
  const raw = rawConfig && typeof rawConfig === 'object' ? rawConfig : {}
  return () => {
    const merged = { ...DEFAULTS }
    const resolved = unwrapVolatile(raw)
    for (const [key, value] of Object.entries(resolved)) {
      if (value !== undefined) merged[key] = value
    }
    return merged
  }
}

/** 宿主自带的 peer 包候选（link 安装时由 scripts/link-peers.mjs 软链进检出）。 */
const SCHEMA_CANDIDATES = ['@deepseek-ai/schemastery', 'schemastery']

/** 按 schema 造 Config：volatile 字段可在设置页免重挂改写。 */
function buildConfig(z) {
  return z.object({
    enabled: z.boolean().default(DEFAULTS.enabled).volatile(),
    quiet: z.boolean().default(DEFAULTS.quiet).volatile(),
    only: z.array(z.string()).default(DEFAULTS.only).volatile(),
    except: z.array(z.string()).default(DEFAULTS.except).volatile(),
    ignore: z.array(z.string()).default(DEFAULTS.ignore).volatile(),
    maxDepth: z.number().default(DEFAULTS.maxDepth).volatile(),
    debounceMs: z.number().default(DEFAULTS.debounceMs).volatile(),
    installQuietMs: z.number().default(DEFAULTS.installQuietMs).volatile(),
    allowForeignTargets: z.boolean().default(DEFAULTS.allowForeignTargets).volatile(),
    // reloadSelf 在**每轮扫描**里重新读取（index.js 的 collectTargets: `!cfg().reloadSelf && root === SELF_ROOT`），
    // 所以标 volatile：设置页改完，下一个 interval 就生效，不需要重挂 fiber。
    reloadSelf: z.boolean().default(DEFAULTS.reloadSelf).volatile(),
    // 以下非 volatile：intervalMs 只在注册轮询定时器时读一次，改动应由宿主重挂 fiber 生效。
    intervalMs: z.number().default(DEFAULTS.intervalMs),
    includeAsar: z.boolean().default(DEFAULTS.includeAsar),
    extraRoots: z.array(z.string()).default(DEFAULTS.extraRoots),
    profileDir: z.string().default(DEFAULTS.profileDir),
  })
}

/** 逐个候选探测：只有带 .volatile() 的版本可用（老版 schemastery 没有它）。 */
async function loadSchema() {
  for (const specifier of SCHEMA_CANDIDATES) {
    let z
    try {
      z = (await import(specifier)).default
    } catch {
      continue
    }
    if (!z || typeof z.boolean !== 'function' || typeof z.object !== 'function') continue
    let probe
    try {
      probe = z.boolean().default(true).volatile()
    } catch {
      continue
    }
    if (probe?.meta?.volatile !== true) continue
    try {
      return buildConfig(z)
    } catch {
      continue
    }
  }
  return undefined
}

/**
 * 给宿主用的配置 schema。undefined = 宿主没提供可用的 schemastery：
 * 这时没有设置页，但配置仍按 DEFAULTS + 原始 config 工作。
 */
export const Config = await loadSchema()
