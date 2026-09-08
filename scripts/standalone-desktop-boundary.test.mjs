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
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'creative-studio-standalone-boundary-'));
const standalone = path.join(fixtureRoot, '.next', 'standalone');
const runtimeSource = path.join(fixtureRoot, 'runtime', 'server-entry.js');
const runtimeCopy = path.join(standalone, 'runtime', 'server-entry.js');

const forbiddenSpec = JSON.parse(
  readFileSync(path.join(repositoryRoot, 'scripts', 'packaging', 'forbidden-paths.json'), 'utf8'),
);
assert.equal(forbiddenSpec.version, 1, 'forbidden-paths.json schema version must be 1');
assert.ok(
  /^[\x00-\x7F]*$/.test(readFileSync(path.join(repositoryRoot, 'scripts', 'packaging', 'forbidden-paths.json'), 'utf8')),
  'forbidden-paths.json 必须保持 ASCII-only（Windows PowerShell 5.1 按 ANSI 读无 BOM 文件，非 ASCII 字节会破坏 ConvertFrom-Json）',
);
for (const entry of ['data', 'storage', 'outputs', 'docs', 'scripts', '.git', '.env', '.env.*', 'config.yaml', '.venv-litellm', 'python-runtime']) {
  assert.ok(forbiddenSpec.core.includes(entry), `共享禁入清单缺少 ${entry}`);
}
for (const consumer of ['nextStandaloneExcludes', 'standaloneSyncPurge']) {
  for (const entry of forbiddenSpec.consumers[consumer].extra) {
    assert.ok(!forbiddenSpec.core.includes(entry), `consumer ${consumer} 的差集与 core 重叠：${entry}`);
  }
}
// next.config.ts 的生效 excludes 必须等于 core+nextStandaloneExcludes.extra 的渲染结果
const nextConfigSource = readFileSync(path.join(repositoryRoot, 'next.config.ts'), 'utf8');
assert.match(nextConfigSource, /scripts', 'packaging', 'forbidden-paths\.json'/, 'next.config.ts 必须读取共享禁入清单 JSON');
const nextConfigProbe = spawnSync(
  process.execPath,
  ['--experimental-strip-types', '--input-type=module', '-e', `
    import(${JSON.stringify(pathToFileURL(path.join(repositoryRoot, 'next.config.ts')).href)})
      .then((m) => console.log(JSON.stringify(m.default.outputFileTracingExcludes['*'])))
  `],
  { cwd: repositoryRoot, encoding: 'utf8' },
);
assert.equal(nextConfigProbe.status, 0, `next.config.ts 加载失败：\n${nextConfigProbe.stderr}`);
const renderForbidden = (entry) =>
  forbiddenSpec.fileEntries.includes(entry) ? `./${entry}` : `./${entry}/**/*`;
const expectedExcludes = [
  ...forbiddenSpec.core.map(renderForbidden),
  ...forbiddenSpec.consumers.nextStandaloneExcludes.extra.map(renderForbidden),
];
assert.deepEqual(
  JSON.parse(nextConfigProbe.stdout.trim()),
  expectedExcludes,
  'next.config.ts 的 excludes 必须等于 core+nextStandaloneExcludes.extra',
);
const syncPurge = [
  ...forbiddenSpec.core,
  ...forbiddenSpec.consumers.standaloneSyncPurge.extra,
];
const syncSource = readFileSync(path.join(repositoryRoot, 'scripts', 'sync-standalone-assets.mjs'), 'utf8');
assert.match(syncSource, /forbidden-paths\.json/, 'sync 必须读取共享禁入清单 JSON');
assert.match(syncSource, /standaloneSyncPurge\.extra/, 'sync 清理清单必须由 core+standaloneSyncPurge.extra 组成');

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
  // 每条 core+standaloneSyncPurge.extra 禁入项都要在 standalone 根留下泄漏样本
  for (const entry of syncPurge) {
    if (entry.includes('*')) continue; // 通配条目由 .env.release / config.yaml.* 变体样本覆盖
    writeFixture(`.next/standalone/${entry}/leak.txt`);
  }
  writeFixture('.next/standalone/.env.release', 'LEAKED_SECRET=1\n');
  writeFixture('.next/standalone/config.yaml.backup-20260814-172847', 'api_key: leaked-secret\n');
  writeFixture('.next/standalone/app/api/desktop/health/route.js');
  writeFixture('.next/standalone/runtime/stale-entry.js');

  const sync = spawnSync(
    process.execPath,
    [path.join(repositoryRoot, 'scripts', 'sync-standalone-assets.mjs')],
    { cwd: fixtureRoot, encoding: 'utf8' },
  );
  assert.equal(sync.status, 0, `standalone 资源同步失败：\n${sync.stderr}\n${sync.stdout}`);

  for (const entry of syncPurge) {
    if (entry.includes('*')) continue;
    assert.equal(
      existsSync(path.join(standalone, entry)),
      false,
      `standalone 根目录不得包含共享禁入清单条目：${entry}`,
    );
  }
  assert.equal(
    existsSync(path.join(standalone, 'config.yaml.backup-20260814-172847')),
    false,
    'standalone 根目录不得包含 config.yaml.* 变体（api_key 泄漏样本）',
  );
  assert.equal(
    existsSync(path.join(standalone, '.env.release')),
    false,
    'standalone 根目录不得包含 .env* 变体（LEAKED_SECRET 样本）',
  );

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
