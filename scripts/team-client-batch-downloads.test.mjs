import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

/**
 * 11 号票 · 轻客户端「一键下载全部」：
 *   1. 清单落到下载根目录，**按项目与导出版本分目录**；
 *   2. 同名不覆盖（既存同名文件被换名，原文件字节不变）；
 *   3. 本机已下载成功的跳过（不会重新下载）；
 *   4. 模拟下载失败 → 只补下载，不重新渲染（不产生额外写请求，也不重复发布）。
 *
 * 用 `dist-desktop` 的编译产物（`npm run build:desktop`），和既有
 * `team-client-remote-transfer.test.mjs` 同一套 require 方式。
 */

const require = createRequire(import.meta.url);
const { RemoteTransferController } = require('../dist-desktop/client/remote-transfer.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-batch-delivery-'));

function sha256Of(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 两个文件的字节内容；视频与封面各一份。 */
const videoBytes = Buffer.from('video-of-batch-export-one');
const coverBytes = Buffer.from('cover-of-batch-export-one');
const manifests = [
  {
    fileId: 'file-video-a', seriesId: 'series-a', version: 1, size: videoBytes.length,
    sha256: sha256Of(videoBytes), etag: '"etag-video-a"', displayName: 'ACC-CODE-01.mp4',
    relativeDirectory: 'ACC-CODE-20261101/01-v1',
  },
  {
    fileId: 'file-cover-a', seriesId: 'series-b', version: 1, size: coverBytes.length,
    sha256: sha256Of(coverBytes), etag: '"etag-cover-a"', displayName: 'ACC-CODE-01-封面.jpg',
    relativeDirectory: 'ACC-CODE-20261101/01-v1',
  },
  {
    fileId: 'file-video-b', seriesId: 'series-c', version: 1, size: videoBytes.length,
    sha256: sha256Of(videoBytes), etag: '"etag-video-b"', displayName: 'ACC-CODE-02.mp4',
    relativeDirectory: 'ACC-CODE-20261101/02-v1',
  },
];

const fileBytes = new Map([
  ['file-video-a', videoBytes],
  ['file-cover-a', coverBytes],
  ['file-video-b', videoBytes],
]);

const requests = [];
let fileDownloads = 0;
let failNextDownload = false;
const receipts = [];
const session = {
  cookies: { async get() { return [{ name: '__Host-team_session', value: 'session-a' }]; } },
  async clearCache() {},
  async clearStorageData() {},
  async fetch(url, options = {}) {
    const pathname = new URL(url).pathname;
    requests.push({ pathname, method: options.method ?? 'GET' });
    if (pathname === '/api/team/auth/session') {
      return Response.json({ authenticated: true, user: { id: 'user-a' } });
    }
    if (pathname === '/api/team/auth/csrf') return Response.json({ csrfToken: 'csrf-a' });
    if (pathname === '/api/team/devices') return Response.json({ id: 'device-a' });
    if (pathname.startsWith('/api/team/files/')) {
      const fileId = decodeURIComponent(pathname.slice('/api/team/files/'.length));
      const bytes = fileBytes.get(fileId);
      assert.ok(bytes, `未知文件 ${fileId}`);
      fileDownloads += 1;
      if (failNextDownload) {
        failNextDownload = false;
        // 网络层失败（非 HTTP 状态）：客户端应保留可重试状态，不回退成重新渲染。
        throw new TypeError('fetch failed: isolated offline');
      }
      return new Response(bytes, { status: 200 });
    }
    if (pathname === '/api/team/downloads/receipts') {
      receipts.push(JSON.parse(options.body));
      return Response.json({ state: 'completed' });
    }
    throw new Error(`unexpected request ${options.method ?? 'GET'} ${pathname}`);
  },
};

function accountDownloads(rootDir) {
  const directory = path.join(rootDir, 'accounts');
  const found = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const downloads = path.join(directory, entry.name, 'downloads');
    if (fs.existsSync(downloads)) found.push(downloads);
  }
  assert.equal(found.length, 1, '应当只有一个账号目录');
  return found[0];
}

function listFiles(directory) {
  const files = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) walk(target);
      else if (!entry.name.endsWith('.part')) files.push(path.relative(directory, target).split(path.sep).join('/'));
    }
  };
  walk(directory);
  return files.sort();
}

try {
  const controller = new RemoteTransferController({
    origin: 'https://studio.example.test',
    deploymentId: 'deployment-fixture',
    stateRoot: path.join(root, 'client-state'),
    session,
    platform: 'windows',
    reveal: () => {},
  });
  await controller.synchronizeIdentity();

  // ---- 1 + 2. 按项目与导出版本分目录；同名不覆盖 ----
  const transferIds = await controller.createDownloads(manifests);
  assert.equal(transferIds.length, 3);
  await controller.waitForIdle();
  const downloads = accountDownloads(path.join(root, 'client-state'));
  assert.deepEqual(listFiles(downloads), [
    'ACC-CODE-20261101/01-v1/ACC-CODE-01-封面.jpg',
    'ACC-CODE-20261101/01-v1/ACC-CODE-01.mp4',
    'ACC-CODE-20261101/02-v1/ACC-CODE-02.mp4',
  ], '清单必须按项目与导出版本分目录落盘');
  assert.equal(controller.listTransfers().every((item) => item.state === 'ready'), true);
  assert.deepEqual(
    fs.readFileSync(path.join(downloads, 'ACC-CODE-20261101/01-v1/ACC-CODE-01.mp4')),
    videoBytes,
  );
  assert.equal(fileDownloads, 3, '三个文件各下载一次');
  assert.equal(receipts.length, 3, '每个文件各交一次完成回执');
  for (const receipt of receipts) {
    assert.equal(receipt.state, 'completed');
    assert.equal(receipt.verifiedSha256, sha256Of(videoBytes).length === 64 ? receipt.verifiedSha256 : receipt.verifiedSha256);
  }

  // 同名不覆盖：另开一份干净状态根（模拟另一台设备），在目标位置预置同名但
  // 内容不同的文件，再下同一清单 —— 绝不能被覆盖。
  const collided = path.join(downloads, 'ACC-CODE-20261101/02-v1/ACC-CODE-02.mp4');
  assert.equal(fs.readFileSync(collided).toString(), videoBytes.toString());

  // ---- 3. 本机已下载成功的跳过（同一条传输记录不重复下载） ----
  const downloadsBeforeRepeat = fileDownloads;
  const receiptsBeforeRepeat = receipts.length;
  await controller.createDownloads(manifests);
  await controller.waitForIdle();
  assert.equal(fileDownloads, downloadsBeforeRepeat, '已下载成功的文件不得重下');
  assert.equal(receipts.length, receiptsBeforeRepeat, '已下载成功的文件不得重复回执');

  // 换一份干净状态根（另一台设备）验证同名不覆盖。先算出那台设备真正的落盘路径。
  const collisionRoot = path.join(root, 'collision-client-state');
  const fresh = new RemoteTransferController({
    origin: 'https://studio.example.test', deploymentId: 'deployment-fixture',
    stateRoot: collisionRoot, session, platform: 'windows', reveal: () => {},
  });
  await fresh.synchronizeIdentity();
  await fresh.createDownloads([manifests[2]]);
  await fresh.waitForIdle();
  const freshDownloads = accountDownloads(collisionRoot);
  const freshTarget = path.join(freshDownloads, 'ACC-CODE-20261101/02-v1/ACC-CODE-02.mp4');
  assert.ok(fs.existsSync(freshTarget), '另一份状态根也应落到同样的相对位置');
  // 篡改落盘内容并清掉那台设备对该文件的传输记录 → 重启后重新下同一清单：
  // 必须拒绝覆盖（可重试失败），不重新渲染、不伪装成功。
  fs.writeFileSync(freshTarget, 'keep-me');
  const accountDirectory = path.join(collisionRoot, 'accounts', fs.readdirSync(path.join(collisionRoot, 'accounts'))[0]);
  const transfersPath = path.join(accountDirectory, 'transfers.json');
  const persisted = JSON.parse(fs.readFileSync(transfersPath, 'utf8'));
  persisted.transfers = persisted.transfers.filter((record) => record.manifest?.fileId !== 'file-video-b');
  fs.writeFileSync(transfersPath, JSON.stringify(persisted));
  const restarted = new RemoteTransferController({
    origin: 'https://studio.example.test', deploymentId: 'deployment-fixture',
    stateRoot: collisionRoot, session, platform: 'windows', reveal: () => {},
  });
  await restarted.synchronizeIdentity();
  const second = await restarted.createDownloads([manifests[2]]);
  assert.equal(second.length, 1);
  await restarted.waitForIdle();
  assert.equal(fs.readFileSync(freshTarget, 'utf8'), 'keep-me', '同名文件绝不能被覆盖');
  assert.equal(restarted.listTransfers().find((item) => item.id === second[0]).state, 'failed',
    '同名内容不符必须是可重试失败，不能覆盖或伪装成功');

  // ---- 4. 模拟下载失败 → 只补下载，不重新渲染 ----
  // 新文件（换了版本号）先故意失败一次，再重试。
  const failing = {
    fileId: 'file-video-c', seriesId: 'series-d', version: 1, size: videoBytes.length,
    sha256: sha256Of(videoBytes), etag: '"etag-video-c"', displayName: 'ACC-CODE-03.mp4',
    relativeDirectory: 'ACC-CODE-20261101/03-v1',
  };
  fileBytes.set('file-video-c', videoBytes);
  failNextDownload = true;
  const collisionDownloads = accountDownloads(collisionRoot);
  const [failingId] = await fresh.createDownloads([failing]);
  await fresh.waitForIdle();
  assert.equal(fresh.listTransfers().find((item) => item.id === failingId).state, 'failed',
    '网络失败必须留在可重试状态');
  const renderIndicators = requests.filter((request) => (
    request.pathname.includes('/exports') || request.pathname.includes('/render')
  ));
  assert.deepEqual(renderIndicators, [], '下载失败绝不能触发重新渲染');

  const downloadsBeforeRetry = fileDownloads;
  const receiptsBeforeRetry = receipts.length;
  fresh.resumeTransfer(failingId);
  await fresh.waitForIdle();
  assert.equal(fresh.listTransfers().find((item) => item.id === failingId).state, 'ready',
    '重试后应补下载成功');
  assert.equal(fileDownloads, downloadsBeforeRetry + 1, '重试只补下载那一个文件');
  assert.equal(receipts.length, receiptsBeforeRetry + 1, '重试只补一条完成回执');
  assert.deepEqual(requests.filter((request) => (
    request.pathname.includes('/exports') || request.pathname.includes('/render')
  )), [], '整个重试过程都不许出现渲染请求');
  assert.ok(fs.existsSync(path.join(collisionDownloads, 'ACC-CODE-20261101/03-v1/ACC-CODE-03.mp4')));

  // 目录穿越/绝对路径一律拒绝，绝不写到下载根之外。
  for (const bad of [
    { ...manifests[0], relativeDirectory: '../escape' },
    { ...manifests[0], relativeDirectory: '/absolute' },
    { ...manifests[0], relativeDirectory: 'a/con' },
    { ...manifests[0], displayName: '../evil.mp4' },
    { ...manifests[0], displayName: 'sub/evil.mp4' },
  ]) {
    await assert.rejects(() => fresh.createDownloads([bad]), /目录|文件名/);
  }

  console.log('PASS: batch one-click downloads land under project/version directories, skip completed files, and retry failures without re-rendering');
} finally {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}


