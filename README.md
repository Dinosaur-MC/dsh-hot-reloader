# dsh-hot-reloader

> 改完 DSH 插件源码即刻生效，不用再重启 DeepSeek Harness。

[English](README.en.md) | 中文

![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4B6EF5)
![License](https://img.shields.io/badge/license-MIT-green)
![Node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen)

| |
|---|
| **`dsh-hot-reloader`** — 改完插件源码不用重启（本仓库） |
| [`dsh-session-clock`](https://github.com/xfgil/dsh-session-clock) — 按会话授时与空闲间隔 |
| [`dsh-onebot-guard`](https://github.com/xfgil/dsh-onebot-guard) — QQ 通道出站闸 |

---

## 目录

- [这是什么](#这是什么)
- [它到底解决了什么问题](#它到底解决了什么问题)
- [环境要求](#环境要求)
- [安装](#安装)
- [使用](#使用)
- [配置](#配置)
- [它是怎么做到的](#它是怎么做到的)
- [已知限制](#已知限制)
- [实现说明](#实现说明)
- [开发](#开发)
- [License](#license)

---

## 这是什么

`dsh-hot-reloader` 是一个 DeepSeek Harness（DSH）插件，给**插件开发者**用。

它盯着你所有 DSH 插件的源码目录，一旦发现文件变化，就在运行中的宿主里把那个插件**原地重新加载**——你保存文件，一秒左右新代码就生效，**不需要重启 DSH**。

如果你写过 DSH 插件，多半经历过这个循环：

```
改一行逻辑 → 重启 DeepSeek Harness → 等它起来 → 手动复现刚才的场景 → 发现改错了 → 再来一遍
```

这个插件把这个循环压缩成「改，然后看结果」。

## 它到底解决了什么问题

DSH **自带**热重载服务 [`@deepseek-ai/dsh-hmr`](https://www.npmjs.com/package/@deepseek-ai/dsh-hmr)，但它对绝大多数插件都**不会生效**。原因很具体——它有两处硬编码把 `node_modules` 排除在外：

```js
// dsh-hmr/lib/index.js:201 —— loadDependencies()
if (job.url.startsWith("node:") || job.url.includes("/node_modules/")) return;

// dsh-hmr/lib/index.js:478 —— analyzeChanges()
const isExcluded = (url) => url.startsWith("node:") || url.includes("/node_modules/");
```

而 DSH profile 安装的插件，**全部**位于：

```
~/.dsh/profiles/<profile>/node_modules/<包名>/
```

于是链路是这样断的：

1. 你改了 `.../node_modules/dsh-onebot-qq/lib/split.js`
2. 文件事件到达 `dsh-hmr`，但它的监听根 `root` 在 base 组合包里被定为 `[]`（只热重载配置，不监听源码），且 `ignored` 默认含 `**/node_modules` → 事件根本没进来
3. 即便强行把这两个配置打开，模块 URL 里带 `/node_modules/`，`loadDependencies()` 立刻 `return`，依赖集恒为空
4. 紧接着 `dsh-hmr/lib/index.js:543` 判断：

   ```js
   if (!dependencies.some((dep) => this.accepted.has(dep))) continue;   // ← 永远 continue
   ```

5. 结论：**这个插件永远不会进入重载队列**。改代码只能重启。

`dsh-hot-reloader` 重新实现了这条链路，**不排除 `node_modules`**。

> 需要说明的是：这不一定是 `dsh-hmr` 的 bug——它服务于 profile 配置与宿主自身模块的热重载，排除 `node_modules` 是保守且合理的选择。只是「用户自己装的第三方插件」这个场景没有被覆盖，本插件补的就是这块。

### 顺带一提：浏览器侧本来就能热重载

DSH 的 Web 客户端有一套独立的 HMR（`@deepseek-ai/dsh-client-hmr`），走 `/plugins/events` SSE 通道。**客户端代码的改动原本就不需要重启**。

真正的痛点在 **host 侧**（`lib/index.js` 这类服务端代码），这正是本插件的目标。

## 环境要求

### DSH 宿主

| 项 | 版本 |
|---|---|
| DSH | **0.2.0-rc.2**（本插件的开发与实测版本） |
| Electron | 44.0.0 |
| Node（宿主内嵌） | 24.18.1 |
| V8 | 15.2 |
| Cordis | 4.0.4 |

### 前置条件（本插件比别的插件更挑环境，务必先读）

**1. 宿主必须带 `--expose-internals` 启动。**

模块替换依赖 Node 的 loader 内部结构。插件构造函数里有这条硬检查：

```js
if (!this.ctx.loader.internal) throw new Error('--expose-internals is required for HMR service')
```

DSH 桌面版的宿主进程**默认就带**这个旗标（实测命令行）：
`DeepSeek Harness.exe --expose-internals ...dsh-desktop-host/lib/index.js ...`。
所以正常情况下无需你操心。**但如果宿主没带，本插件无法工作**——
这不是可以绕过的配置项，是 Node 的模块系统边界。

**2. 建议同时启用宿主内置的 `@deepseek-ai/dsh-hmr`（可选，但推荐）。**

本插件**复用**它的实例：解析模块走它的 `_resolve()`，替换动作走它的
`runExclusive()` 事务（避免和内置 HMR 撞车）。

```js
const hmr = ctx.get('hmr')
if (hmr && typeof hmr._resolve === 'function') { /* 用它的解析 */ }
// ...
if (hmr && typeof hmr.runExclusive === 'function') { await hmr.runExclusive(run) }
```

**两条路都有自实现兜底**：拿不到 `hmr` 时退回 `ctx.loader.internal.resolveSync`
与直接执行，插件照常工作。所以它是优化而非硬依赖。

不过它默认就是启用的，而且它的问题正是本插件存在的理由：

```yaml
# 内置 HMR 在 dsh-base/cordis.patch.yml 里是这样挂的：
- id: hmr
  name: '@deepseek-ai/dsh-hmr'
  disabled: !!js "!ctx.get('profileContext')"   # 有 profileContext 时启用
  config:
    root: []                                     # ← 只重载 profile 配置，不监听源码模块
```

`root: []` 意味着内置 HMR 不监听任何源码目录；而且它有两处硬编码排除 node_modules
（`loadDependencies` 与 `analyzeChanges`），第三方插件永远进不了它的依赖图。
**本插件补的就是这块**，同时借用它的事务机制。

**3. 装在 profile 侧，目录必须在 profile 的 `node_modules` 之外**（或走 link 安装）。

link 安装（`link:D:/path/to/plugins/...`）是被支持的路径。
若你直接把包放进 `node_modules`，升级会覆盖它——和所有 profile 插件一样。

**4. 零外部依赖。** 只用 `node:fs` / `node:path` / `node:url` / `node:module`。
这不是洁癖：profile 的 `node_modules` 里**解析不到** `chokidar` / `picomatch`
（只有 `cosmokit`、`schemastery` 等极少数包），这是「为什么用轮询」的根本原因。

### 不需要的东西

- **不需要重启 DSH** 就能让本插件生效（宿主内置 HMR 会 reconcile profile 清单）。
- **不需要额外端口**，走宿主的 `webServer`。

---

## 安装

```bash
dsh plugin --profile <你的profile> add link:<本目录绝对路径>
```

例如：

```bash
dsh plugin --profile desktop add link:D:/path/to/plugins/dsh-hot-reloader
```

从 npm 安装（如果你是用发布版）：

```bash
dsh plugin --profile <你的profile> add dsh-hot-reloader
```

装完之后，profile 清单（`dsh.profile.bundles`）会被自动更新。宿主自带的 HMR 监听到清单变化后会自己 reconcile —— **这一步同样不需要重启**，插件即刻开始工作。

## 使用

**装好之后什么都不用做。** 改任意已安装插件的 `lib/*.js`，一秒左右自动热重载。

重载日志会直接打到宿主日志；也可以随时查状态接口。

### 观测与手动控制

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/dsh-hot-reloader` | 完整状态：监听了哪些包、扫了多少文件、扫描/重载/失败计数、近期日志 |
| `POST` | `/dsh-hot-reloader/reload` | 手动重载。body 留空 = 全部；支持 `["包名"]` 或 `{"packages":["包名"]}` |
| `POST` | `/dsh-hot-reloader/toggle` | 暂停 / 恢复自动重载 |
| `POST` | `/dsh-hot-reloader/self-reload` | 重载本插件自身（开发这个插件时用） |

```bash
# 看状态
curl http://127.0.0.1:19387/dsh-hot-reloader

# 只重载某个插件
curl -X POST http://127.0.0.1:19387/dsh-hot-reloader/reload \
     -H 'content-type: application/json' \
     -d '["dsh-onebot-qq"]'

# 全部重载一次
curl -X POST http://127.0.0.1:19387/dsh-hot-reloader/reload

# 临时关掉自动重载（例如你正在做大面积重构，不想每存一次就重载一次）
curl -X POST http://127.0.0.1:19387/dsh-hot-reloader/toggle
```

`GET /dsh-hot-reloader` 的返回大致长这样：

```json
{
  "ok": true,
  "plugin": "dsh-hot-reloader",
  "enabled": true,
  "uptimeMs": 55659,
  "scannedFiles": 227,
  "scans": 55,
  "reloads": 3,
  "failures": 0,
  "lastReloadAt": 1791805031234,
  "lastError": null,
  "watch": ["D:\\path\\to\\plugins\\dsh-whale-widget", "..."],
  "packages": [
    { "root": "...", "entries": ["dsh-onebot-qq", "dsh-onebot-qq/settings-remote"] }
  ],
  "recent": [{ "at": 1791805031234, "pkg": "dsh-onebot-qq", "files": 1, "ms": 35, "ok": true }],
  "logs": [{ "at": 1791805031234, "level": "info", "message": "✔ 已热重载 dsh-onebot-qq（35ms）← lib\\split.js" }]
}
```

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖对应行：

```yaml
- id: dsh-hot-reloader
  config:
    intervalMs: 1000      # 轮询间隔（毫秒）
    debounceMs: 400       # 检测到变更后，等写入稳定的时间（毫秒）
    reloadSelf: false     # 是否连同本插件自己一起自动重载
    only: []              # 只监听这些包名（留空 = 全部）
    except: []            # 跳过这些包名
    extraRoots: []        # 额外监听的绝对路径（不在 loader 树里的目录）
    includeAsar: false    # 是否连 app.asar 内的宿主包一起监听
    ignore: ['.bak', '.test.', '.spec.', '.map']   # 按文件名子串跳过
    maxDepth: 8           # 目录递归深度上限
    quiet: false          # 静默模式：只记录失败
    installQuietMs: 8000  # 识别到包管理操作后的让路时长（毫秒）；0 = 关闭该机制
    profileDir: ''        # profile 目录；默认从 loader 树自动推导
```

`installQuietMs` 是**装包让路**机制：检测到 pnpm 正在操作（改写 `pnpm-lock.yaml`、`.modules.yaml` 等）时暂停扫描，避免在它换目录的窗口里添乱。默认 8 秒窗口足够覆盖一次普通安装；装了很大的包时可以调大。设成 `0` 则关闭让路（不建议——那样装包期间可能撞上半成品状态）。


几个实用场景：

```yaml
# 只盯你正在开发的那几个插件，减少无谓扫描
config:
  only: ['dsh-onebot-qq', 'dsh-whale-widget']

# 正在做大重构，先关掉自动重载，改完手动触发一次
config:
  quiet: true
  intervalMs: 3000
```

## 它是怎么做到的

核心流程五步：

1. **定位包根** —— 遍历 loader 的每个 entry，把 specifier 解析成真实 URL，向上找 `package.json`，得到「包根目录」
2. **轮询比对** —— 扫描包根内的 `.js / .mjs / .cjs / .json`，记录 `mtimeMs + size`，与上一轮基线比对
3. **防抖** —— 检测到变更后等 `debounceMs`，避开编辑器「先清空再写入」的中间态
4. **清缓存** —— 清掉该包在 **Node 内部 ESM `LoadCache`** 和 **CJS `require.cache`** 中的条目
5. **重建** —— 重新 `import` 入口 → `registry.delete(旧 plugin)` → 用 `parent.registry.plugin()` 按原有 config 重建 fiber

几个刻意的取舍：

- **只清该插件自己包内**的模块，**不动**它嵌套的第三方依赖 —— 像 `ws` 连接这类的状态通常需要复用，连坐清理会带来无谓的中断
- **不碰 `app.asar` 内的宿主包** —— 归档内容不会变，而且重载宿主自身等于自伤
- **一个包根挂多个 entry 时一起重挂** —— 例如 `dsh-onebot-qq` 和 `dsh-onebot-qq/settings-remote` 共享同一个包，必须同时处理，否则会漏掉或重复注册
- **先全部重新 `import` 成功，再卸载旧实例** —— 任何一步失败就整体回滚，绝不让插件停在「已卸载但没挂上」的半死状态
- **失败不回滚磁盘** —— 你的改动仍在，下次变更或手动重载会再试

## 已知限制

诚实列一下，避免踩坑：

- **重载会丢掉该插件持有的内存状态**（进行中的连接、缓存、定时器等）。多数插件在重建时会自己恢复，但长连接类插件在重载的瞬间可能有短暂中断
- **依赖宿主内部接口** —— 模块替换需要 Node 的 loader 内部结构（`--expose-internals`）与 Cordis 的 `registry`/`loader`，这些不是稳定的公开 API。DSH 升级后可能需要跟着适配
- **只覆盖 host 侧** —— 浏览器侧（`lib/client.js` 等）由 DSH 自带的 `dsh-client-hmr` 负责，不受本插件影响

### ⚠️ 这个插件管不了的：安装 / 更新插件包

**必须分清两件事**，它们的机制完全不同：

| 你做的事 | 本插件 | 需要重启吗 |
|---|---|---|
| 改插件**源码**（`lib/*.js`） | ✅ 接管，秒级生效 | 不需要 |
| 安装 / 更新插件**包**（换版本） | ❌ 管不了 | **需要** |

后者是 DSH 自身的限制，与本插件无关。DSH 插件管理器在遇到这种情况时会自己记录原因：

```
dsh-mnemon: the running host holds its files open, so the update did not apply;
package.json and pnpm-lock.yaml restored, previous build still has a loadable entry, nothing reinstalled
→ 请改在应用自己的「设置 → 插件」里操作（退出重启后，或先停用加载该包的插件再重启）
```

**根因**：运行中的宿主已经把该插件加载进内存，Windows 上已加载模块的文件被映射进进程，pnpm 想「把目录挪走再换新的」就会撞上 `EPERM`。这是 DSH 与 Windows 的固有冲突，**在本插件存在之前就存在**（实测本机第一次装包失败残留可追溯到插件安装前 26 小时）。

**本插件为此做的是「让路」而不是「接管」**：检测到 pnpm 正在操作时暂停扫描，避免在换目录的窗口里添乱，操作结束后自动重建基线。

**正确做法**：更新插件包请在应用内「设置 → 插件」里操作，按提示重启。本插件不试图绕过这个限制——绕过它意味着去动正在运行的模块文件，那是把宿主搞崩的捷径。


## 实现说明

### 为什么用轮询而不是文件监听

三个现实约束：

1. 插件运行在 profile 的 `node_modules` 里，那里**解析不到** `chokidar` / `picomatch` 这类依赖（只有 `cosmokit`、`schemastery` 等极少数包）
2. `node:fs.watch` 在 Windows 上对深层目录不可靠
3. 有人用网络挂载或某些同步盘，那些环境根本不产生文件系统事件

轮询的代价是每秒一次 `statSync`。实测 19~20 个插件 / 约 227 个文件，开销可以忽略。

### 轮询会不会干扰装包？

**不会**，这一点我专门做过对照实验，因为担心过。

Windows 上 pnpm 替换包是「把目录挪开 → 放新的 → 改回名字」，如果这时有别的进程占着目录句柄就会 `EPERM`。实测三组对照（不监听 / 已加载+每秒轮询 / 冷目录），目录改名失败率都在同一噪声水平，**轮询没有额外影响**：`readdirSync` + `statSync` 读的是目录项快照，不持有会阻止改名的句柄。

（对照本机记录：装包失败在本插件存在之前就有 —— 最早的失败残骸比插件安装早 26 小时。）

真正需要担心的是**时序**而不是句柄：装包窗口里包是半成品，这时去重载会拿到残缺的模块。所以本插件做的是「让路」：识别到 pnpm 操作就暂停扫描（`installQuietMs`），窗口结束后重建基线。

### 关于 Node 的 ESM 模块缓存

本插件的缓存清除逻辑是在**实测** Node 24 的 `LoadCache` 内部结构后确定的。它的真实形态是：

```js
class SafeMap extends Map {}
class LoadCache extends SafeMap {
  get(url, type = kImplicitTypeAttribute) { return super.get(url)?.[type] }
  set(url, type = kImplicitTypeAttribute, job) { /* 存成 url -> { [type]: job } */ }
  has(url, type = kImplicitTypeAttribute) { return super.get(url)?.[type] !== undefined }
  delete(url, type = kImplicitTypeAttribute) { const c = super.get(url); if (c) c[type] = undefined }
}
```

也就是说：

- 它是**两层结构**：URL → `{ type: ModuleJob }`
- 它的 `delete()` **只把 type 槽置为 `undefined`，并不移除 key**

因此本插件（与宿主 `dsh-hmr` 的做法一致）用 `Map.prototype.delete.call(cache, url)` 绕过被重写的方法，确保条目被彻底移除。实测确认：这样清理之后，模块会**真正重新执行**（用执行期自增的全局计数器验证过，不是靠时间戳猜的）。

### 自举问题

本插件默认不自动重载自己（`reloadSelf: false`）——改自己的监听逻辑会让自举行为变得难以预测。

但这里有个「先有鸡还是先有蛋」的真实问题：**当插件 entry 被重新激活时，宿主的 `loader.import(specifier)` 会命中模块缓存、拿回旧代码**——正是本插件要解决的那个问题本身。

所以开发本插件时，如果需要把改动换上去，用状态接口的 `/self-reload`，它会走和普通插件完全相同的路径来替换自己。

## 开发

目录结构：

```
dsh-hot-reloader/
├── lib/
│   └── index.js          # 全部实现（零外部依赖，只用 node: 内置模块）
├── cordis.patch.yml      # bundle 挂载声明
├── package.json
├── README.md             # 中文（本文件）
└── README.en.md          # English
```

本插件**刻意保持零外部依赖**，只使用 `node:fs`、`node:path`、`node:url`、`node:module`。这不是洁癖——是上面「为什么用轮询」里说的第一条约束决定的。

本地开发时，改 `lib/index.js` 后调一次自举接口即可生效：

```bash
curl -X POST http://127.0.0.1:19387/dsh-hot-reloader/self-reload
```

## License

[MIT](LICENSE)
