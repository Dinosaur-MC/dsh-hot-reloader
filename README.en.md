# dsh-hot-reloader

> Edit your DSH plugin source and see it take effect immediately — no more restarting DeepSeek Harness.

English | [中文](README.md)

![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4B6EF5)
![License](https://img.shields.io/badge/license-MIT-green)
![Node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen)

| |
|---|
| **`dsh-hot-reloader`** — edit plugin source without restarting (this repo) |
| [`dsh-session-clock`](https://github.com/xfgil/dsh-session-clock) — per-session clock and idle gaps |
| [`dsh-second-opinion`](https://github.com/xfgil/dsh-second-opinion) — hand a stuck problem to another session for a second opinion |
| [`dsh-onebot-companion`](https://github.com/xfgil/dsh-onebot-companion) — QQ channel all-in-one: outbound gate, rules, rhythm, persona, voice |

---

## Contents

- [What this is](#what-this-is)
- [The problem it actually solves](#the-problem-it-actually-solves)
- [Requirements](#requirements)
- [Install](#install)
- [Usage](#usage)
- [Configuration](#configuration)
- [How it works](#how-it-works)
- [Known limitations](#known-limitations)
- [Implementation notes](#implementation-notes)
- [License](#license)

---

## What this is

`dsh-hot-reloader` is a DeepSeek Harness (DSH) plugin built **for plugin developers**.

It watches the source directories of every DSH plugin you have installed, and when a file changes it **reloads that plugin in place** inside the running host. You save, and roughly a second later the new code is live — **no DSH restart**.

If you've written a DSH plugin, you've probably lived this loop:

```
change one line → restart DeepSeek Harness → wait for it to come up
→ manually reproduce the scenario → realize the change was wrong → repeat
```

This plugin collapses that into "change it, then look at the result."

## The problem it actually solves

DSH **ships** a hot-reload service, [`@deepseek-ai/dsh-hmr`](https://www.npmjs.com/package/@deepseek-ai/dsh-hmr), but it will **not** fire for the vast majority of plugins. The reason is concrete — it hardcodes `node_modules` out of the picture in two places:

```js
// dsh-hmr/lib/index.js:201 —— loadDependencies()
if (job.url.startsWith("node:") || job.url.includes("/node_modules/")) return;

// dsh-hmr/lib/index.js:478 —— analyzeChanges()
const isExcluded = (url) => url.startsWith("node:") || url.includes("/node_modules/");
```

And every plugin a DSH profile installs lives under:

```
~/.dsh/profiles/<profile>/node_modules/<package>/
```

So the chain breaks like this:

1. You edit `.../node_modules/dsh-onebot-qq/lib/split.js`
2. The file event reaches `dsh-hmr`, but its watch root `root` is set to `[]` in the base bundle (config-only reload, no source watching), and the default `ignored` includes `**/node_modules` → the event never gets in
3. Even if you force both open, the module URL contains `/node_modules/`, so `loadDependencies()` returns immediately and the dependency set is always empty
4. Then `dsh-hmr/lib/index.js:543` evaluates:

   ```js
   if (!dependencies.some((dep) => this.accepted.has(dep))) continue;   // ← always continues
   ```

5. Net result: **the plugin never enters the reload queue.** Editing it means restarting.

`dsh-hot-reloader` reimplements that chain and does **not** exclude `node_modules`.

> Fair note: this isn't necessarily a bug in `dsh-hmr` — it serves profile-config and host-module reloading, where excluding `node_modules` is the conservative, sensible choice. It's just that the "third-party plugin the user installed" scenario isn't covered. This plugin fills that gap.

### Side note: the browser side already hot-reloads

DSH's Web client has its own separate HMR (`@deepseek-ai/dsh-client-hmr`) over a `/plugins/events` SSE channel. **Client-side changes never needed a restart.**

The real pain is on the **host side** (server code like `lib/index.js`), which is exactly what this plugin targets.

## Requirements

### DSH host

| Item | Version |
|---|---|
| DSH | **0.2.0-rc.2** (tested on this version) |
| Electron | 44.0.0 |
| Node (embedded in host) | 24.18.1 |
| V8 | 15.2 |
| Cordis | 4.0.4 |

### Prerequisites (this plugin is pickier than most — please read)

**1. The host must start with `--expose-internals`.**

Module replacement relies on Node's internal loader structures. The plugin has a hard
check in its constructor:

```js
if (!this.ctx.loader.internal) throw new Error('--expose-internals is required for HMR service')
```

The DSH desktop host **already passes this flag by default** (observed command line):
`DeepSeek Harness.exe --expose-internals ...dsh-desktop-host/lib/index.js ...`.
So in practice there is nothing to configure. **But if your host lacks the flag, this
plugin cannot work** — it is not a settable option, it is a boundary of Node's module system.

**2. Enabling the built-in `@deepseek-ai/dsh-hmr` is recommended (optional, but advised).**

This plugin **reuses** that service: module resolution goes through its `_resolve()`,
and replacement runs inside its `runExclusive()` transaction (so it never races the
built-in HMR).

```js
const hmr = ctx.get('hmr')
if (hmr && typeof hmr._resolve === 'function') { /* use its resolver */ }
// ...
if (hmr && typeof hmr.runExclusive === 'function') { await hmr.runExclusive(run) }
```

**Both paths have a self-implemented fallback**: without `hmr` the plugin falls back to
`ctx.loader.internal.resolveSync` and direct execution, and keeps working. So it is an
optimization, not a hard dependency.

It is enabled by default anyway, and its limitation is precisely why this plugin exists:

```yaml
# how the built-in HMR is mounted in dsh-base/cordis.patch.yml:
- id: hmr
  name: '@deepseek-ai/dsh-hmr'
  disabled: !!js "!ctx.get('profileContext')"   # enabled when a profileContext exists
  config:
    root: []                                     # ← reloads profile config only, watches no source
```

`root: []` means the built-in HMR watches no source directory at all, and it hard-codes
two exclusions of `node_modules` (`loadDependencies` and `analyzeChanges`), so a
third-party plugin can never enter its dependency graph. **That gap is what this plugin
fills**, while borrowing its transaction machinery.

**3. Installed on the profile side, and its directory must live outside the profile's
`node_modules`** (or be installed via link).

Link installs (`link:D:/path/to/plugins/...`) are a supported path. If you drop the package
straight into `node_modules`, an upgrade will overwrite it — same as any profile plugin.

**4. Zero external dependencies.** Only `node:fs` / `node:path` / `node:url` / `node:module`.
This is not fastidiousness: the profile's `node_modules` **cannot resolve** `chokidar` /
`picomatch` (only a handful of packages like `cosmokit` and `schemastery` are there),
which is the root reason for "why polling instead of file watching".

### What you do NOT need

- **No DSH restart** is needed for this plugin to take effect (the built-in HMR
  reconciles the profile manifest).
- **No extra port** — it rides the host's `webServer`.

---

## Install

```bash
dsh plugin --profile <your-profile> add link:<absolute-path-to-this-dir>
```

For example:

```bash
dsh plugin --profile desktop add link:D:/path/to/plugins/dsh-hot-reloader
```

From npm (if you're using the published build):

```bash
dsh plugin --profile <your-profile> add dsh-hot-reloader
```

After installing, the profile manifest (`dsh.profile.bundles`) is updated automatically. The host's built-in HMR notices the manifest change and reconciles on its own — **that step needs no restart either**, and the plugin starts working right away.

## Usage

**Once installed, there is nothing to do.** Edit any installed plugin's `lib/*.js` and it hot-reloads within about a second.

Reloads are logged to the host log; you can also check status at any time.

### Observability and manual control

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/dsh-hot-reloader` | Full status: where the switch comes from, which packages are watched, scan/reload/failure counters, recent logs |
| `GET` | `/dsh-hot-reloader/targets?workspace=<path>&all=1` | List targets: by default **only the reloadable ones** (inside the workspace, entry activated, not this plugin itself); `all=1` also lists the filtered-out rows with a `blockedBy` reason (`outside-workspace` / `not-activated` / `self`) and a `hidden` summary |
| `POST` | `/dsh-hot-reloader/reload` | Manual reload. Empty = everything inside the workspace; accepts `["pkg-name"]`, `["path"]`, `{"targets":[...],"workspace":"...","dryRun":true}` or legacy `{"packages":[...]}` |
| `POST` | `/dsh-hot-reloader/auto` | **Persistent** auto-reload switch (written into the profile patch): `{"enabled":true\|false\|null}`; `null` restores the default |
| `POST` | `/dsh-hot-reloader/toggle` | In-memory flip only (not persisted) — for "pause for a moment" |
| `POST` | `/dsh-hot-reloader/self-reload` | Reload this plugin itself (for developing it) |

### GUI switch

This plugin ships a **browser half** (`lib/client.js` + `dsh.client` in package.json) that puts a **Configure card** on its row of the Web Plugins page: the automatic-reload switch plus a status line (watched targets / files / reloads since start).

- The switch writes through the platform's own settings form (`ctx.configForms` with a revision fence) — the same profile patch `POST /auto` writes;
- The card registers into the `plugins.row.config` slot keyed `dsh-hot-reloader#dsh-hot-reloader`, so it does **not** depend on the "auto-generated settings page" renderer (some deployments' third-party UI bundles never render that);
- The status line reads this plugin's `GET /dsh-hot-reloader`; when the host is down it says so.

Changing `dsh.client` or the browser half needs a **DSH restart** (the client-plugin manifest loads at host boot). Host-half edits still hot-reload.

```bash
# status
curl http://127.0.0.1:19387/dsh-hot-reloader

# reload just one plugin
curl -X POST http://127.0.0.1:19387/dsh-hot-reloader/reload \
     -H 'content-type: application/json' \
     -d '["dsh-onebot-qq"]'

# reload everything once
curl -X POST http://127.0.0.1:19387/dsh-hot-reloader/reload

# temporarily disable automatic reloading (in memory only; a restart restores it)
curl -X POST http://127.0.0.1:19387/dsh-hot-reloader/toggle

# persistently disable automatic reloading (writes into the profile patch)
curl -X POST http://127.0.0.1:19387/dsh-hot-reloader/auto \
     -H 'content-type: application/json' -d '{"enabled":false}'
```

### Targeted reload: three ways to name what you mean

Elements of `targets` in `POST /reload`:

| Form | Example | Meaning |
|---|---|---|
| keyword | `workspace` / `all` | everything inside the workspace / every watched target (`all` is still bounded by `allowForeignTargets`) |
| package name | `dsh-onebot-qq`, `dsh-onebot-qq/settings-remote` | that package (including sibling entries under the same package root) |
| path | `projects/x/lib/split.js` or absolute | any package overlapping that path (file or directory; relative paths resolve against the given workspace) |

```bash
# reload only the package that owns the files you just edited
curl -X POST http://127.0.0.1:19387/dsh-hot-reloader/reload \
     -H 'content-type: application/json' \
     -d '{"targets":["D:/ws/projects/x/lib/split.js"],"workspace":"D:/ws"}'

# plan only: see what would match and what the guardrails refuse
curl -X POST http://127.0.0.1:19387/dsh-hot-reloader/reload \
     -H 'content-type: application/json' -d '{"targets":["all"],"dryRun":true}'
```

Three default refusals show up in the response as `skipped` (never as silent success): `outside-workspace` (set `allowForeignTargets: true` to cross workspaces), `self` (bootstrap goes through `/self-reload`), and `no-match` for selectors that hit nothing.

### Letting the model trigger it: the `hot_reload` tool

Once installed, agents in the host gain a `hot_reload` tool:

- `action:"list"` — by default **only reloadable targets** (plus a hidden summary); `all:true` lists everything (outside-workspace / not-activated / this plugin), each with a `blockedBy` reason;
- `action:"reload"` (default) — an empty `targets` means **every plugin inside the current session workspace**;
- `dryRun:true` — report the match set without reloading;
- `action:"auto"` + `enabled` — flip the persistent switch.

The default scope is literally "the workspace this agent is in" (`exec.agent.session.header.cwd`), so "I edited a plugin in my workspace, now reload it" needs no absolute paths from the model. The tool description states that a reload drops the target plugin's in-memory state.

`GET /dsh-hot-reloader` returns roughly:

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
  "logs": [{ "at": 1791805031234, "level": "info", "message": "✔ reloaded dsh-onebot-qq (35ms) ← lib\\split.js" }]
}
```

## Configuration

Override the row in your profile's `cordis.patch.yml`:

```yaml
- id: dsh-hot-reloader
  config:
    enabled: true         # master switch for automatic reload (also togglable in Settings → Plugins)
    intervalMs: 1000      # polling interval (ms); changing it needs the host to remount this plugin
    allowForeignTargets: false  # allow manual/tool reloads of plugins whose root is outside the given workspace
    debounceMs: 400       # settle time after a change is detected (ms)
    reloadSelf: false     # also auto-reload this plugin itself
    only: []              # watch only these package names (empty = all)
    except: []            # skip these package names
    extraRoots: []        # extra absolute paths to watch (dirs not in the loader tree)
    includeAsar: false    # also watch host packages inside app.asar
    ignore: ['.bak', '.test.', '.spec.', '.map']   # skip by filename substring
    maxDepth: 8           # max directory recursion depth
    quiet: false          # quiet mode: only record failures
    installQuietMs: 8000  # how long to step aside after a package-manager op is seen (ms); 0 = off
    profileDir: ''        # the profile directory; derived from the loader tree by default
```

`installQuietMs` is the **step-aside mechanism**: on detecting that pnpm is operating (rewriting `pnpm-lock.yaml`, `.modules.yaml`, etc.) the plugin pauses scanning so it doesn't interfere while directories are being swapped. The default 8-second window covers an ordinary install; raise it for very large packages. Setting it to `0` disables the step-aside (not recommended — scanning during an install can catch a half-written package).


A couple of practical setups:

```yaml
# only watch the plugins you're actively developing
config:
  only: ['dsh-onebot-qq', 'dsh-whale-widget']

# mid-refactor: turn off auto reload, trigger manually when ready
config:
  quiet: true
  intervalMs: 3000
```

## How it works

Five steps:

1. **Locate the package root** — walk every loader entry, resolve its specifier to a real URL, walk up to `package.json` to find the package root
2. **Poll and compare** — scan `.js / .mjs / .cjs / .json` under the root, record `mtimeMs + size`, diff against the previous baseline
3. **Debounce** — wait `debounceMs` after a change, to avoid editors' "truncate then write" intermediate states
4. **Clear caches** — drop that package's entries from Node's internal ESM `LoadCache` and from CJS `require.cache`
5. **Rebuild** — re-`import` the entry → `registry.delete(old plugin)` → re-create the fiber via `parent.registry.plugin()` with the original config

Deliberate trade-offs:

- **Only that plugin's own modules are cleared**, never its nested third-party dependencies — state like a `ws` connection usually needs to be reused, and clearing it would cause pointless interruptions
- **Host packages inside `app.asar` are never touched** — archive contents never change, and reloading the host equals self-harm
- **Multiple entries under one package root are reloaded together** — e.g. `dsh-onebot-qq` and `dsh-onebot-qq/settings-remote` share one package, so they must be handled as a unit or you'd drop or double-register one
- **Re-import everything successfully *before* unloading the old instances** — any failure rolls the whole thing back, so a plugin is never left "unloaded but not mounted"
- **A failure never rolls back your disk** — your change stays, and the next change or a manual reload retries

## Known limitations

Listed honestly, to save you some debugging:

- **A reload loses that plugin's in-memory state** (in-flight connections, caches, timers). Most plugins re-establish it on rebuild, but long-lived-connection plugins may see a brief interruption at the moment of reload
- **It depends on host internals** — module replacement needs Node's internal loader structures (`--expose-internals`) and Cordis's `registry`/`loader`, which are not stable public APIs. A DSH upgrade may require follow-up adaptation
- **Host side only** — the browser side (`lib/client.js` etc.) is handled by DSH's own `dsh-client-hmr` and is unaffected by this plugin

### ⚠️ What this plugin cannot do: install / update a plugin package

**Two different things must be kept apart** — their mechanisms are entirely different:

| What you do | This plugin | Restart needed? |
|---|---|---|
| Edit plugin **source** (`lib/*.js`) | ✅ handles it, live within a second | No |
| Install / update a plugin **package** (version change) | ❌ cannot | **Yes** |

The latter is a DSH limitation, not this plugin's. The DSH plugin manager records the reason itself when it hits this:

```
dsh-mnemon: the running host holds its files open, so the update did not apply;
package.json and pnpm-lock.yaml restored, previous build still has a loadable entry, nothing reinstalled
→ use the app's own Settings → Plugins instead (after restarting, or after disabling the plugin loading that package)
```

**Root cause**: the running host has already loaded that plugin into memory. On Windows, the files of a loaded module are mapped into the process, so when pnpm tries to "move the directory aside and swap in a new one" it hits `EPERM`. This is an inherent DSH-vs-Windows conflict.

**What this plugin does about it is "step aside", not "take over"**: on detecting an in-progress pnpm operation it pauses scanning so it doesn't interfere while directories are being swapped, and rebuilds its baseline once the operation ends.

**The right way**: update plugin packages from the app's Settings → Plugins and restart as prompted. This plugin does not try to bypass that limit — bypassing it would mean mutating the files of a running module, which is a shortcut to crashing the host.

## Implementation notes

### Why polling instead of file watching

Three practical constraints:

1. Plugins run inside the profile's `node_modules`, where dependencies like `chokidar` / `picomatch` **cannot be resolved** (only a small handful such as `cosmokit`, `schemastery` are present)
2. `node:fs.watch` is unreliable for deep directories on Windows
3. Some people run on network mounts or sync drives, which produce no filesystem events at all

The cost of polling is one `statSync` per second. Measured at 19–20 plugins / ~227 files, the overhead is negligible.

### On Node's ESM module cache

This plugin's cache-clearing logic targets the internal structure of Node 24's `LoadCache`, whose real shape is:

```js
class SafeMap extends Map {}
class LoadCache extends SafeMap {
  get(url, type = kImplicitTypeAttribute) { return super.get(url)?.[type] }
  set(url, type = kImplicitTypeAttribute, job) { /* stores url -> { [type]: job } */ }
  has(url, type = kImplicitTypeAttribute) { return super.get(url)?.[type] !== undefined }
  delete(url, type = kImplicitTypeAttribute) { const c = super.get(url); if (c) c[type] = undefined }
}
```

Which means:

- It is **two-layered**: URL → `{ type: ModuleJob }`
- Its `delete()` **only sets the type slot to `undefined`; it does not remove the key**

So this plugin (matching what the host's `dsh-hmr` does) uses `Map.prototype.delete.call(cache, url)` to bypass the overridden method and genuinely remove the entry — after which the module **really re-executes**.

### The bootstrap problem

This plugin does not auto-reload itself by default (`reloadSelf: false`) — changing your own watch logic makes bootstrap behavior hard to predict.

But there's a genuine chicken-and-egg problem here: **when a plugin entry is re-activated, the host's `loader.import(specifier)` hits the module cache and hands back the old code** — which is precisely the problem this plugin exists to solve.

So when developing this plugin, if you need to get a change live, use the status endpoint's `/self-reload`; it replaces itself through exactly the same path it uses for any other plugin.

## License

[MIT](LICENSE)