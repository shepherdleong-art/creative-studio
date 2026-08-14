// 分发环境自检（只读）：打印脱敏诊断信息，供同事机器排查后回传。
// 用法：在项目根目录执行 node scripts/diagnose-local-env.mjs（或双击 环境自检.cmd）
import { existsSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const require = createRequire(join(root, 'package.json'));

function fileStatus(rel) {
  const p = join(root, rel);
  if (!existsSync(p)) return `缺失: ${rel}`;
  const s = statSync(p);
  return `存在: ${rel} (${s.size} 字节, 修改于 ${s.mtime.toISOString()})`;
}

console.log('== 基本环境 ==');
console.log('项目目录:', root);
console.log('运行本脚本的 Node:', process.version, '| ABI:', process.versions.modules, '（包内预编译原生模块要求 ABI 127 / Node 22.x）');

console.log('\n== 关键文件 ==');
for (const f of [
  'start-windows.cmd',
  'config.yaml',
  '.env.local',
  'node-runtime/node.exe',
  'python-runtime/python.exe',
  'python-runtime/runtime-manifest.json',
  'portable-manifest.json',
  'scripts/start-litellm-proxy.py',
  '.next/standalone/server.js',
  '.next/standalone/runtime/server-entry.js',
  'node_modules/.bin/electron.cmd',
  'node_modules/electron/dist/electron.exe',
  '.next/standalone/node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64.node',
  '.next/standalone/node_modules/@img/sharp-win32-x64/lib/libvips-42.dll',
  '.next/standalone/node_modules/@img/sharp-win32-x64/lib/libvips-cpp-8.17.3.dll',
  'data/workbench.db',
  'data/workbench.db-wal',
]) {
  console.log(fileStatus(f));
}

console.log('\n== better-sqlite3 原生模块 ==');
let Database;
try {
  Database = require('better-sqlite3');
  console.log('加载: OK');
} catch (e) {
  console.log('加载: 失败 -', String(e).split('\n')[0]);
}

if (Database && existsSync(join(root, 'data', 'workbench.db'))) {
  console.log('\n== 数据库供应商密钥状态（脱敏，只显示有无）==');
  try {
    const db = new Database(join(root, 'data', 'workbench.db'), { readonly: true, fileMustExist: true });
    const show = (rows, label) => {
      for (const r of rows) {
        console.log(`  [${label}] ${r.name} | 密钥: ${r.apiKey ? '已配置' : '空'} | 模型: ${r.model ?? r.defaultModel ?? '-'}`);
      }
    };
    show(db.prepare('SELECT name, apiKey, model FROM providers ORDER BY name').all(), '图片');
    show(db.prepare('SELECT id AS name, apiKey, defaultModel FROM video_providers ORDER BY id').all(), '视频');
    try {
      show(db.prepare('SELECT id AS name, apiKey, NULL AS model FROM script_providers ORDER BY id').all(), '脚本');
    } catch { /* 表结构差异可忽略 */ }
    const projects = db.prepare('SELECT COUNT(*) AS c FROM projects').get();
    console.log('  项目数:', projects.c);
    db.close();
  } catch (e) {
    console.log('读取失败:', String(e).split('\n')[0]);
  }
}

console.log('\n== 内置 Python 运行时（免安装包公司网关组件）==');
const portableMode = existsSync(join(root, 'portable-manifest.json'));
console.log('免安装包模式:', portableMode ? '是（检测到 portable-manifest.json）' : '否（源码开发目录）');
const pyExe = join(root, 'python-runtime', 'python.exe');
if (!existsSync(pyExe)) {
  console.log('python-runtime\\python.exe: 缺失' + (portableMode ? '（免安装包不完整，请重新完整复制）' : '（源码目录可用 .venv-litellm 代替）'));
} else {
  const pyManifestPath = join(root, 'python-runtime', 'runtime-manifest.json');
  try {
    const m = JSON.parse(readFileSync(pyManifestPath, 'utf8').replace(/^﻿/, ''));
    console.log(`runtime-manifest.json: 可解析（Python ${m.pythonVersion} / LiteLLM ${m.litellmVersion} / ${m.targetTriple}）`);
  } catch {
    console.log('runtime-manifest.json: 缺失或无法解析');
  }
  const runPy = (args) => spawnSync(pyExe, args, { encoding: 'utf8', timeout: 120000 });
  const pyVer = runPy(['--version']);
  console.log('实际 Python 版本:', pyVer.status === 0 ? String(pyVer.stdout).trim() : `探测失败（退出码 ${pyVer.status}）`);
  const liteVer = runPy(['-c', "from importlib.metadata import version; print(version('litellm'))"]);
  console.log('实际 LiteLLM 版本:', liteVer.status === 0 ? String(liteVer.stdout).trim() : `探测失败（退出码 ${liteVer.status}）`);
  const entry = runPy(['-c', 'from litellm import run_server']);
  console.log('from litellm import run_server:', entry.status === 0 ? 'OK' : `失败（退出码 ${entry.status}）`);
}
if (existsSync(join(root, '.venv-litellm'))) {
  console.log(
    portableMode
      ? '警告: 免安装包中意外存在 .venv-litellm（新方案不应携带该目录，请重新从共享盘完整复制）'
      : '.venv-litellm: 存在（源码开发目录属正常）',
  );
}

console.log('\n== LiteLLM 代理 ==');
try {
  const res = await fetch('http://127.0.0.1:4000/health/liveliness', { signal: AbortSignal.timeout(2000) });
  console.log('健康检查: HTTP', res.status);
} catch {
  console.log('健康检查: 代理未运行（未启动工作台时属正常）');
}

console.log('\n自检完成。请把以上全部输出原样发回。');
