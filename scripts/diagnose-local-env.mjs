// 分发环境自检（只读）：打印脱敏诊断信息，供同事机器排查后回传。
// 用法：在项目根目录执行 node scripts/diagnose-local-env.mjs（或双击 环境自检.cmd）
import { existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

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

console.log('\n== LiteLLM 代理 ==');
try {
  const res = await fetch('http://127.0.0.1:4000/health/liveliness', { signal: AbortSignal.timeout(2000) });
  console.log('健康检查: HTTP', res.status);
} catch {
  console.log('健康检查: 代理未运行（未启动工作台时属正常）');
}

console.log('\n自检完成。请把以上全部输出原样发回。');
