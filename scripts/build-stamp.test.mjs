import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scanWatchedSources, writeBuildStamp, checkBuildStamp } from './runtime/build-stamp.mjs';

// ---------------------------------------------------------------------------
// scripts/runtime/build-stamp.mjs 单元测试：写戳→比对必须新鲜；源码/依赖清单
// 更新后必须分别报 stale-source / stale-deps；戳缺失或损坏一律按 stale 处理。
// ---------------------------------------------------------------------------

const utilPath = fileURLToPath(new URL('./runtime/build-stamp.mjs', import.meta.url));

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-build-stamp-'));
  fs.mkdirSync(path.join(root, 'app'), { recursive: true });
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(root, 'app', 'page.tsx'), '// page');
  fs.writeFileSync(path.join(root, 'lib', 'db.ts'), '// db');
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
  return root;
}

function setMtime(file, date) {
  fs.utimesSync(file, date, date);
}

const root = makeRoot();
const stampFile = path.join(root, '.next', 'standalone', '.build-stamp');

try {
  // 1. 写戳后立即比对：新鲜
  const stamp = writeBuildStamp(root, stampFile);
  assert.equal(stamp.version, 1);
  assert.ok(stamp.newestSourceMs > 0, '必须记录受监视源码的最新 mtime');
  assert.deepEqual(checkBuildStamp(root, stampFile), { status: 'fresh', reason: '' });

  // 2. 源码文件更新（明显更晚的 mtime）→ stale-source
  const later = new Date(Date.now() + 60_000);
  setMtime(path.join(root, 'lib', 'db.ts'), later);
  const stale = checkBuildStamp(root, stampFile);
  assert.equal(stale.status, 'stale-source');
  assert.match(stale.reason, /lib\/db\.ts/, '必须指出是哪个文件更新');

  // 3. 重新写戳吸收改动后，依赖清单更新 → stale-deps
  writeBuildStamp(root, stampFile);
  assert.equal(checkBuildStamp(root, stampFile).status, 'fresh');
  setMtime(path.join(root, 'package-lock.json'), new Date(Date.now() + 120_000));
  const staleDeps = checkBuildStamp(root, stampFile);
  assert.equal(staleDeps.status, 'stale-deps');
  assert.match(staleDeps.reason, /package-lock\.json/);

  // 4. 戳缺失 / 损坏 → stale-source
  fs.rmSync(stampFile);
  assert.equal(checkBuildStamp(root, stampFile).status, 'stale-source');
  fs.writeFileSync(stampFile, 'not-json');
  assert.equal(checkBuildStamp(root, stampFile).status, 'stale-source');

  // 5. 受监视目录整体缺失（打包夹具场景）不得抛异常
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-build-stamp-empty-'));
  try {
    const scan = scanWatchedSources(emptyRoot);
    assert.equal(scan.newestMs, 0);
    const emptyStamp = writeBuildStamp(emptyRoot, path.join(emptyRoot, 'stamp'));
    assert.equal(emptyStamp.newestSourceMs, 0);
    assert.equal(checkBuildStamp(emptyRoot, path.join(emptyRoot, 'stamp')).status, 'fresh');
  } finally {
    fs.rmSync(emptyRoot, { recursive: true, force: true, maxRetries: 5 });
  }

  // 6. CLI 退出码：fresh=0，stale-source=1，stale-deps=2
  writeBuildStamp(root, stampFile);
  // 先把第 2/3 步留下的未来 mtime 吸收掉
  const fresh = spawnSync(process.execPath, [utilPath, 'check', stampFile, root], { encoding: 'utf8' });
  assert.equal(fresh.status, 0, `fresh 应退出 0:\n${fresh.stdout}\n${fresh.stderr}`);
  setMtime(path.join(root, 'app', 'page.tsx'), new Date(Date.now() + 180_000));
  const staleCli = spawnSync(process.execPath, [utilPath, 'check', stampFile, root], { encoding: 'utf8' });
  assert.equal(staleCli.status, 1, `源码更新应退出 1:\n${staleCli.stdout}\n${staleCli.stderr}`);
  writeBuildStamp(root, stampFile);
  setMtime(path.join(root, 'package.json'), new Date(Date.now() + 240_000));
  const depsCli = spawnSync(process.execPath, [utilPath, 'check', stampFile, root], { encoding: 'utf8' });
  assert.equal(depsCli.status, 2, `依赖清单更新应退出 2:\n${depsCli.stdout}\n${depsCli.stderr}`);

  console.log('build-stamp tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
}
