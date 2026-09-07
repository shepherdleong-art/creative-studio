import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'creative-studio-standalone-boundary-'));
const standalone = path.join(fixtureRoot, '.next', 'standalone');
const runtimeSource = path.join(fixtureRoot, 'runtime', 'server-entry.js');
const runtimeCopy = path.join(standalone, 'runtime', 'server-entry.js');

function writeFixture(relativePath, contents = 'fixture') {
  const absolutePath = path.join(fixtureRoot, relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, contents);
}

try {
  writeFixture('.next/static/chunk.js');
  writeFixture('public/asset.txt');
  writeFixture('runtime/server-entry.js', 'module.exports = "fixture-runtime";\n');
  writeFixture('node_modules/ffmpeg-static/package.json', '{}\n');
  writeFixture('node_modules/ffprobe-static/package.json', '{}\n');
  writeFixture('node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64.node');
  writeFixture('node_modules/@img/sharp-win32-x64/lib/libvips-42.dll');
  // 知识/模板目录导入的 XLSX 依赖（纯 JS，Next 文件追踪会随服务端路由收进
  // .next/standalone/node_modules）。sync 不得把已追踪的 node_modules 清掉。
  writeFixture('.next/standalone/node_modules/exceljs/package.json', '{}\n');
  writeFixture('.next/standalone/node_modules/exceljs/lib/exceljs.nodejs.js', 'fixture-exceljs\n');
  writeFixture('.next/standalone/desktop/main.js');
  writeFixture('.next/standalone/dist-desktop/main.js');
  writeFixture('.next/standalone/python-runtime/python.exe');
  writeFixture('.next/standalone/node-runtime/node.exe');
  writeFixture('.next/standalone/config.yaml.backup-20260814-172847', 'api_key: leaked-secret\n');
  writeFixture('.next/standalone/.env.release', 'LEAKED_SECRET=1\n');
  writeFixture('.next/standalone/app/api/desktop/health/route.js');
  writeFixture('.next/standalone/runtime/stale-entry.js');

  const sync = spawnSync(
    process.execPath,
    [path.join(repositoryRoot, 'scripts', 'sync-standalone-assets.mjs')],
    { cwd: fixtureRoot, encoding: 'utf8' },
  );
  assert.equal(sync.status, 0, `standalone 资源同步失败：\n${sync.stderr}\n${sync.stdout}`);

  for (const forbiddenRoot of [
    'desktop',
    'dist-desktop',
    'python-runtime',
    'node-runtime',
    'config.yaml.backup-20260814-172847',
    '.env.release',
  ]) {
    assert.equal(
      existsSync(path.join(standalone, forbiddenRoot)),
      false,
      `standalone 根目录不得包含桌面源码、编译副本或便携 Python 运行时：${forbiddenRoot}`,
    );
  }

  assert.ok(
    existsSync(path.join(standalone, 'app', 'api', 'desktop')),
    'app/api/desktop 是允许保留的 Next API 路由',
  );
  assert.ok(existsSync(runtimeCopy), `缺少 standalone runtime wrapper：${runtimeCopy}`);
  assert.ok(
    existsSync(path.join(standalone, 'node_modules', '@img', 'sharp-win32-x64', 'lib', 'libvips-42.dll')),
    'standalone 必须包含 @img 完整目录（sharp 的 .node 依赖同目录 libvips DLL）',
  );
  assert.equal(
    readFileSync(runtimeCopy, 'utf8'),
    readFileSync(runtimeSource, 'utf8'),
    'standalone runtime/server-entry.js 必须与根 runtime/server-entry.js 内容一致',
  );
  assert.ok(
    existsSync(path.join(standalone, 'node_modules', 'exceljs', 'lib', 'exceljs.nodejs.js')),
    'standalone 必须保留被 Next 追踪的 node_modules/exceljs（脚本知识目录导入依赖）',
  );

  console.log('standalone desktop boundary test passed');
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}
