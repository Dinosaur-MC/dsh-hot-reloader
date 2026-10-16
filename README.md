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
| [`dsh-second-opinion`](https://github.com/xfgil/dsh-second-opinion) — 卡住时把问题交给另一个独立会话，要一份第二意见 |
| [`dsh-onebot-companion`](https://github.com/xfgil/dsh-onebot-companion) — QQ 通道一体化：出站沉默守卫 / 行为规则 / 对话节奏 / 人设 / 语音 |

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
| DSH | **0.2.0-rc.2**（实测于该版本） |
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
| `GET` | `/dsh-hot-reloader` | 完整状态：开关来源、监听了哪些包、扫描 / 重载 / 失败计数、近期日志 |
| `GET` | `/dsh-hot-reloader/targets?workspace=<路径>&all=1` | 列出目标：**默认只列可重载的**（落在工作区内、入口已激活、非本插件自身）；`all=1` 连被滤掉的一起列，每条带 `blockedBy`（`outside-workspace` / `not-activated` / `self`），并给出 `hidden` 汇总 |
| `POST` | `/dsh-hot-reloader/reload` | 手动重载。留空 = 工作区内全部；支持 `["包名"]`、`["路径"]`、`{"targets":[...],"workspace":"...","dryRun":true}` 或旧式 `{"packages":[...]}` |
| `POST` | `/dsh-hot-reloader/auto` | **持久**开关自动重载（写进 profile patch）：`{"enabled":true\|false\|null}`，`null` = 恢复默认 |
| `POST` | `/dsh-hot-reloader/toggle` | 仅内存翻转（不落盘），用于「先临时停一下」 |
| `POST` | `/dsh-hot-reloader/self-reload` | 重载本插件自身（开发这个插件时用） |

### 图形界面开关

本插件带**浏览器半**（`lib/client.js` + package.json 的 `dsh.client`），会在 **设置页**贡献一节「热重载器」：**两个开关**（自动热重载 / 自动重载本插件自身）+ 状态行（监听目标数 / 文件数 / 重载次数）+ 手动重载指定插件的列表。

> 座位说明：主入口是 `settings.section`（设置页的 section 座位，多数 UI 都渲染）；同时也注册首方的 `plugins.row.config`（插件行 Configure 页座位）——那一位在第三方聚合 UI（如 `@linxin666/dsh-web-all`）里**没有渲染者**，注册它不产生任何界面。

- 开关直接走平台自己的设置表单（`ctx.configForms` + revision 栅栏），写的就是 profile patch，与 `POST /auto` 等价；
- 卡片**不依赖**「宿主自动生成设置页」的渲染器（本机这套第三方 UI 不渲染它），而是自己注册座位、自己渲染；
- 状态行读的是本插件的 `GET /dsh-hot-reloader`；宿主没在跑时只显示「状态端点不可达」。
- 卡片里有 **「手动重载指定插件」** 列表：`GET /dsh-hot-reloader/targets?all=1` 列出全部目标，每行一个「重载」按钮 → `POST /dsh-hot-reloader/reload {targets:[包名], workspace:该目标包根}`，行内回显「已重载 / 已跳过 / 重载失败: 原因」。
- 标签与口径（`listTargets` 的字段）：`reloadable`＝默认作用域内可重载（工具/HTTP 默认口径）；`manualReloadable`＝**点名可重载**（已激活且非自身，与作用域无关），GUI 用它决定是否给按钮——所以装在任意目录（含别的项目目录）的插件也能一键重载，点行即视为你点名授权（内部把该目标自己的包根当 workspace 传下去）。
- **GUI 里不提「工作区」**：那是会话/宿主侧的概念（工具的默认作用域），在插件配置页显示「工作区外」只会让人困惑。界面只区分「可重载 / 未激活 / 本插件自身」，且只出现本地化文案，不显示 `outside-workspace`、`not-activated` 这类机器码（这些口径只出现在工具输出与 HTTP 响应里，供模型/脚本使用）。列表里也**不显示插件目录**：用户不需要知道插件装在哪，点行重载即可。
- **本插件不做页面刷新**：宿主状态里会报出 `lib/client.js` 的 mtime，磁盘上有新版本时卡片只给一句文字提示「重启 DSH 后生效」。
  > 2026-10-17 真机事故：早先版本在这个位置放了 `location.reload()` 按钮，点击会让 DSH 崩溃（桌面窗口的会话凭据由宿主开窗时注入，页面导航后窗口回到未授权状态）。现已移除，并有回归守卫：源码出现 `.reload(` / `location.href =` / `location.assign(` 即测试失败。

改动 `dsh.client` 之后要**重启 DSH**（客户端插件清单在宿主启动时装载）；只改宿主半仍然免重启。

> **`dsh.client.inject` 故意留空**：它列的是**客户端插件 id**，列了而该部署没有，浏览器半就会一直等依赖、**永不 apply**（本机实测：这套第三方聚合 UI 的 25 个 client 插件 id 全是 `@linxin666/*`，抄首方 `@deepseek-ai/dsh-client-*` 会让卡片永远不出现）。座位与服务在 `apply()` 里按需使用，不依赖它。

```bash
# 看状态
curl http://127.0.0.1:19387/dsh-hot-reloader

# 只重载某个插件
curl -X POST http://127.0.0.1:19387/dsh-hot-reloader/reload \
     -H 'content-type: application/json' \
     -d '["dsh-onebot-qq"]'

# 全部重载一次
curl -X POST http://127.0.0.1:19387/dsh-hot-reloader/reload

# 临时关掉自动重载（仅本次运行有效，重启即恢复）
curl -X POST http://127.0.0.1:19387/dsh-hot-reloader/toggle

# 持久关掉自动重载（写进 profile patch，等价于在宿主设置页里关掉 enabled）
curl -X POST http://127.0.0.1:19387/dsh-hot-reloader/auto \
     -H 'content-type: application/json' -d '{"enabled":false}'
```

### 定向重载：三种指定方式

`POST /reload` 的 `targets` 元素可以是：

| 形态 | 例子 | 语义 |
|---|---|---|
| 关键词 | `workspace` / `all` | 工作区内的全部 / 全部被监听目标（`all` 仍受 `allowForeignTargets` 约束） |
| 包名 | `dsh-onebot-qq`、`dsh-onebot-qq/settings-remote` | 命中该包（含挂在同一包根下的子入口） |
| 路径 | `projects/x/lib/split.js` 或绝对路径 | 与该路径有交集的包（文件、目录都行；相对路径按给定工作区解析） |

```bash
# 只重载「我刚改的那几个文件」所在的包
curl -X POST http://127.0.0.1:19387/dsh-hot-reloader/reload \
     -H 'content-type: application/json' \
     -d '{"targets":["D:/ws/projects/x/lib/split.js"],"workspace":"D:/ws"}'

# 只算不重载：先看清会命中谁、谁会被护栏拦下
curl -X POST http://127.0.0.1:19387/dsh-hot-reloader/reload \
     -H 'content-type: application/json' -d '{"targets":["all"],"dryRun":true}'
```

三项默认拒绝（都会出现在响应的 `skipped` 里，不会静默当成功）：区外目标 `outside-workspace`（要跨区请把 `allowForeignTargets` 设为 `true`）、本插件自身 `self`（自举走 `/self-reload`）、没命中的选择器 `no-match`。

### 让模型自己触发：`hot_reload` 工具

装好之后，宿主里的 Agent 会多一个 `hot_reload` 工具：

- `action:"list"` —— **默认只列可重载目标**（并给 hidden 汇总）；`all:true` 看全部条目（工作区外 / 入口未激活 / 本插件自身，各带 `blockedBy`）；
- `action:"reload"`（默认）—— `targets` 留空 = **当前会话工作区内的全部插件**；
- `dryRun:true` —— 只回报命中集合，不真的重载；
- `action:"auto"` —— **只读**返回开关状态（`enabled` / `source: config|runtime` / `reloadSelf` / `allowForeignTargets` / `quiet`）。
  **LLM 没有写开关的能力**：传 `enabled` 会被拒绝（`error: "read-only"`）；开关只能由用户在宿主设置页或 `POST /auto` 修改。
- `action:"reload"` —— **必须显式给 `targets`**（包名或路径）；留空返回 `targets-required`，`workspace` / `all` 这类「全部」关键词返回 `broad-target-rejected`。
  作用域固定为当前会话工作区：范围外的目标只记进 `skipped`，不会被重载。

作用域默认就是「模型所在的那个工作区」（`exec.agent.session.header.cwd`），所以「改了工作区里的插件源码 → 让模型自己重载」不需要它知道任何绝对路径。重载会丢目标插件的内存状态，工具说明里写明了这一点。

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
    enabled: true         # 自动重载总开关（也可在宿主「设置 → 插件」里直接切换）
    intervalMs: 1000      # 轮询间隔（毫秒）；改动需宿主重挂本插件才生效
    allowForeignTargets: false  # 是否允许手动/工具重载「包根不在给定工作区内」的插件
    debounceMs: 400       # 检测到变更后，等写入稳定的时间（毫秒）
    reloadSelf: false     # 是否连同本插件自己一起自动重载（设置页有开关；只在 enabled 打开时生效）
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

**根因**：运行中的宿主已经把该插件加载进内存，Windows 上已加载模块的文件被映射进进程，pnpm 想「把目录挪走再换新的」就会撞上 `EPERM`。这是 DSH 与 Windows 的固有冲突。

**本插件为此做的是「让路」而不是「接管」**：检测到 pnpm 正在操作时暂停扫描，避免在换目录的窗口里添乱，操作结束后自动重建基线。

**正确做法**：更新插件包请在应用内「设置 → 插件」里操作，按提示重启。本插件不试图绕过这个限制——绕过它意味着去动正在运行的模块文件，那是把宿主搞崩的捷径。


## 实现说明

### 为什么用轮询而不是文件监听

三个现实约束：

1. 插件运行在 profile 的 `node_modules` 里，那里**解析不到** `chokidar` / `picomatch` 这类依赖（只有 `cosmokit`、`schemastery` 等极少数包）
2. `node:fs.watch` 在 Windows 上对深层目录不可靠
3. 有人用网络挂载或某些同步盘，那些环境根本不产生文件系统事件

轮询的代价是每秒一次 `statSync`。实测 19~20 个插件 / 约 227 个文件，开销可以忽略。

### 关于 Node 的 ESM 模块缓存

Node 24 的 ESM `LoadCache` 内部结构是这样的：

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

因此本插件（与宿主 `dsh-hmr` 的做法一致）用 `Map.prototype.delete.call(cache, url)` 绕过被重写的方法，确保条目被彻底移除；这样清理之后，模块会**真正重新执行**。

### 自举问题

本插件默认不自动重载自己（`reloadSelf: false`）——改自己的监听逻辑会让自举行为变得难以预测。
现在这是设置页里的**第二个开关**（`reloadSelf` 已标 volatile，改完下一轮扫描即生效）：开着它改本插件代码会自动生效，代价是保存到一半可能被重载、自升级失败时需要重启 DSH 恢复。

但这里有个「先有鸡还是先有蛋」的真实问题：**当插件 entry 被重新激活时，宿主的 `loader.import(specifier)` 会命中模块缓存、拿回旧代码**——正是本插件要解决的那个问题本身。

所以开发本插件时，如果需要把改动换上去，用状态接口的 `/self-reload`，它会走和普通插件完全相同的路径来替换自己。

## License

[MIT](LICENSE)