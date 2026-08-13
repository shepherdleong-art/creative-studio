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
  writeFixture('.next/standalone/desktop/main.js');
  writeFixture('.next/standalone/dist-desktop/main.js');
  writeFixture('.next/standalone/app/api/desktop/health/route.js');
  writeFixture('.next/standalone/runtime/stale-entry.js');

  const sync = spawnSync(
    process.execPath,
    [path.join(repositoryRoot, 'scripts', 'sync-standalone-assets.mjs')],
    { cwd: fixtureRoot, encoding: 'utf8' },
  );
  assert.equal(sync.status, 0, `standalone 资源同步失败：\n${sync.stderr}\n${sync.stdout}`);

  for (const forbiddenRoot of ['desktop', 'dist-desktop']) {
    assert.equal(
      existsSync(path.join(standalone, forbiddenRoot)),
      false,
      `standalone 根目录不得包含桌面源码或编译副本：${forbiddenRoot}`,
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

  console.log('standalone desktop boundary test passed');
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}
