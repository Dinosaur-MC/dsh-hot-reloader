# dsh-hot-reloader

> Edit your DSH plugin source and see it take effect immediately — no more restarting DeepSeek Harness.

English | [中文](README.md)

![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4B6EF5)
![License](https://img.shields.io/badge/license-MIT-green)
![Node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen)

---

## Contents

- [What this is](#what-this-is)
- [The problem it actually solves](#the-problem-it-actually-solves)
- [Install](#install)
- [Usage](#usage)
- [Configuration](#configuration)
- [How it works](#how-it-works)
- [Known limitations](#known-limitations)
- [Implementation notes](#implementation-notes)
- [Development](#development)
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
| `GET` | `/dsh-hot-reloader` | Full status: which packages are watched, files scanned, scan/reload/failure counters, recent logs |
| `POST` | `/dsh-hot-reloader/reload` | Manual reload. Empty body = all; accepts `["pkg-name"]` or `{"packages":["pkg-name"]}` |
| `POST` | `/dsh-hot-reloader/toggle` | Pause / resume automatic reloading |
| `POST` | `/dsh-hot-reloader/self-reload` | Reload this plugin itself (for developing it) |

```bash
# status
curl http://127.0.0.1:19387/dsh-hot-reloader

# reload just one plugin
curl -X POST http://127.0.0.1:19387/dsh-hot-reloader/reload \
     -H 'content-type: application/json' \
     -d '["dsh-onebot-qq"]'

# reload everything once
curl -X POST http://127.0.0.1:19387/dsh-hot-reloader/reload

# temporarily disable automatic reloading (e.g. mid-refactor, so every save doesn't trigger)
curl -X POST http://127.0.0.1:19387/dsh-hot-reloader/toggle
```

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
    intervalMs: 1000      # polling interval (ms)
    debounceMs: 400       # settle time after a change is detected (ms)
    reloadSelf: false     # also auto-reload this plugin itself
    only: []              # watch only these package names (empty = all)
    except: []            # skip these package names
    extraRoots: []        # extra absolute paths to watch (dirs not in the loader tree)
    includeAsar: false    # also watch host packages inside app.asar
    ignore: ['.bak', '.test.', '.spec.', '.map']   # skip by filename substring
    maxDepth: 8           # max directory recursion depth
    quiet: false          # quiet mode: only record failures
```

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
- **Replacing a package version via the plugin manager still requires a restart** — package installation is a different path, outside this plugin's scope
- **It depends on host internals** — module replacement needs Node's internal loader structures (`--expose-internals`) and Cordis's `registry`/`loader`, which are not stable public APIs. A DSH upgrade may require follow-up adaptation
- **Host side only** — the browser side (`lib/client.js` etc.) is handled by DSH's own `dsh-client-hmr` and is unaffected by this plugin

## Implementation notes

### Why polling instead of file watching

Three practical constraints:

1. Plugins run inside the profile's `node_modules`, where dependencies like `chokidar` / `picomatch` **cannot be resolved** (only a small handful such as `cosmokit`, `schemastery` are present)
2. `node:fs.watch` is unreliable for deep directories on Windows
3. Some people run on network mounts or sync drives, which produce no filesystem events at all

The cost of polling is one `statSync` per second. Measured at 19–20 plugins / ~227 files, the overhead is negligible.

### On Node's ESM module cache

This plugin's cache-clearing logic was determined by **empirically inspecting** the internal structure of Node 24's `LoadCache`. Its real shape is:

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

So this plugin (matching what the host's `dsh-hmr` does) uses `Map.prototype.delete.call(cache, url)` to bypass the overridden method and genuinely remove the entry. Verified empirically: after this, the module **really re-executes** (confirmed with an execution-time global counter, not by guessing from timestamps).

### The bootstrap problem

This plugin does not auto-reload itself by default (`reloadSelf: false`) — changing your own watch logic makes bootstrap behavior hard to predict.

But there's a genuine chicken-and-egg problem here: **when a plugin entry is re-activated, the host's `loader.import(specifier)` hits the module cache and hands back the old code** — which is precisely the problem this plugin exists to solve.

So when developing this plugin, if you need to get a change live, use the status endpoint's `/self-reload`; it replaces itself through exactly the same path it uses for any other plugin.

## Development

Layout:

```
dsh-hot-reloader/
├── lib/
│   └── index.js          # the whole implementation (zero external deps, node: builtins only)
├── cordis.patch.yml      # bundle mount declaration
├── package.json
├── README.md             # 中文 (Chinese)
└── README.en.md          # English (this file)
```

This plugin is **deliberately dependency-free**, using only `node:fs`, `node:path`, `node:url`, `node:module`. That's not fastidiousness — it follows from the first constraint under "Why polling instead of file watching" above.

During local development, call the bootstrap endpoint once after editing `lib/index.js`:

```bash
curl -X POST http://127.0.0.1:19387/dsh-hot-reloader/self-reload
```

## License

[MIT](LICENSE)
