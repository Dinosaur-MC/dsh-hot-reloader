#!/usr/bin/env node
/**
 * 把 DSH 自带的 peer 包软链进本检出的 node_modules/，让 `node --test` 与宿主运行时
 * 都能解析 `@deepseek-ai/schemastery`（Config schema 用）与 `@deepseek-ai/dsh-tools`（defineTool 用）。
 *
 * 为什么需要：本插件以 link 方式安装（真实路径在 profile 的 node_modules 之外），
 * ESM 只按真实路径逐级向上找 node_modules —— 找不到宿主 profile 里的那份 peer，
 * 也不会去找 app.asar。声明 peerDependencies + 软链是零网络、零新增依赖的做法。
 *
 * 用法：node scripts/link-peers.mjs [--from <dsh 包目录>]
 * 发现顺序：--from → $DSH_PKG_ROOT → dirname(process.execPath)/node_modules/@deepseek-ai/dsh
 *
 * 注意：不使用 child_process —— 本机沙箱下抓子进程输出会 EPERM。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PEERS = ['schemastery', 'dsh-tools'];
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function resolveDshRoot() {
  const argv = process.argv.slice(2);
  const flag = argv.indexOf('--from');
  if (flag !== -1 && argv[flag + 1]) return path.resolve(argv[flag + 1]);
  if (process.env.DSH_PKG_ROOT) return path.resolve(process.env.DSH_PKG_ROOT);
  return path.join(path.dirname(process.execPath), 'node_modules', '@deepseek-ai', 'dsh');
}

const dshRoot = resolveDshRoot();
const peersDir = path.join(dshRoot, 'node_modules', '@deepseek-ai');
if (!fs.existsSync(peersDir)) {
  console.error(`找不到 DSH 的 peer 包目录：\n  ${peersDir}`);
  console.error('请用 --from 指定 dsh 包目录，例如：');
  console.error('  node scripts/link-peers.mjs --from "<...>/node_modules/@deepseek-ai/dsh"');
  process.exit(1);
}

const target = path.join(repoRoot, 'node_modules', '@deepseek-ai');
fs.mkdirSync(target, { recursive: true });

let linked = 0;
for (const peer of PEERS) {
  const source = path.join(peersDir, peer);
  if (!fs.existsSync(source)) {
    console.warn(`跳过（该 DSH 安装里没有）：${peer}`);
    continue;
  }
  const link = path.join(target, peer);
  fs.rmSync(link, { recursive: true, force: true });
  fs.symlinkSync(source, link, 'junction');
  console.log(`linked ${peer} -> ${source}`);
  linked += 1;
}
console.log(`\n完成：${linked} 个 peer 已接入 ${target}`);
