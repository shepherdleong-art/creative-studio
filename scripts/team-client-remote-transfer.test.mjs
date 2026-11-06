import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { RemoteTransferController } = require('../dist-desktop/client/remote-transfer.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-remote-transfer-'));
const source = path.join(root, 'source.bin');
fs.writeFileSync(source, 'abcdefgh');
const downloadPayload = Buffer.from([1, 2, 3, 4]);
const downloadManifest = {
  fileId: 'file-a', seriesId: 'series-a', version: 1, size: 4,
  sha256: crypto.createHash('sha256').update(downloadPayload).digest('hex'),
  etag: 'etag-a', displayName: 'result.bin',
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function persistedTransfer(stateRoot, id) {
  const pending = [path.join(stateRoot, 'accounts')];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.name === 'transfers.json') {
        const record = JSON.parse(fs.readFileSync(target, 'utf8')).transfers.find((item) => item.id === id);
        if (record) return record;
      }
    }
  }
  throw new Error(`missing persisted transfer ${id}`);
}

const requests = [];
let account = 'user-a';
let networkOffline = false;
let authenticated = true;
let firstPart = true;
let fileDownloads = 0;
let receiptAttempts = 0;
let failNextReceipt = true;
let releaseFirstPart = deferred();
const session = {
  cookies: {
    async get() {
      return [
        { name: '__Host-team_session', value: `session-${account}` },
        { name: '__Host-team_csrf', value: `csrf-${account}` },
      ];
    },
  },
  cacheClears: 0,
  storageClears: 0,
  async clearCache() { this.cacheClears += 1; },
  async clearStorageData() { this.storageClears += 1; },
  async fetch(url, options = {}) {
    if (networkOffline) throw new TypeError('fetch failed: isolated offline');
    const pathname = new URL(url).pathname;
    requests.push({ pathname, method: options.method ?? 'GET', headers: options.headers ?? {}, account });
    if (pathname === '/api/team/auth/session') {
      return Response.json(authenticated ? {
        authenticated: true,
        user: { id: account, employeeId: account, displayName: account, role: 'employee' },
      } : { authenticated: false });
    }
    if (pathname === '/api/team/auth/csrf') return Response.json({ csrfToken: `csrf-${account}` });
    if (pathname === '/api/team/devices') return Response.json({ id: `device-${account}` });
    if (pathname === '/api/team/uploads') {
      const upload = JSON.parse(options.body);
      assert.equal(upload.targetKind, 'project_image');
      assert.equal(upload.usage, 'image', '业务发布用途必须匹配 ticket 11 合同');
      return Response.json({ uploadId: `upload-${account}`, partSize: 4, missingParts: [1, 2] });
    }
    if (pathname === '/api/team/uploads/upload-user-a/parts/1' && firstPart) {
      firstPart = false;
      return releaseFirstPart.promise;
    }
    if (pathname.includes('/parts/')) return Response.json({ replayed: false });
    if (pathname.endsWith('/complete')) return Response.json({ state: 'ready' });
    if (pathname === '/api/team/downloads') {
      return Response.json({ items: [{ manifest: downloadManifest, deliveryState: 'pending' }], nextCursor: 1 });
    }
    if (pathname === '/api/team/files/file-a') {
      fileDownloads += 1;
      return new Response(downloadPayload, { status: 200, headers: { etag: 'etag-a' } });
    }
    if (pathname === '/api/team/downloads/receipts') {
      receiptAttempts += 1;
      if (failNextReceipt) {
        failNextReceipt = false;
        return Response.json({ error: 'temporary' }, { status: 500 });
      }
      return Response.json({ state: 'completed' });
    }
    throw new Error(`unexpected request ${options.method ?? 'GET'} ${pathname}`);
  },
};

try {
  const revealed = [];
  const diagnostics = [];
  networkOffline = true;
  const offlineController = new RemoteTransferController({
    origin: 'https://studio.example.test', deploymentId: 'deployment-fixture',
    stateRoot: path.join(root, 'offline-client-state'), session, platform: 'windows', reveal: () => {},
  });
  await assert.rejects(() => offlineController.synchronizeIdentity(), /fetch failed/);
  assert.equal(session.cacheClears, 0, '断网握手不得清掉缓存');
  assert.equal(session.storageClears, 0, '断网握手不得清掉本地登录相关存储');
  assert.deepEqual(offlineController.listTransfers(), [], '离线时尚未认证不得暴露其他账号传输');
  networkOffline = false;
  const controller = new RemoteTransferController({
    origin: 'https://studio.example.test',
    deploymentId: 'deployment-fixture',
    stateRoot: path.join(root, 'client-state'),
    session,
    platform: 'windows',
    reveal: (target) => revealed.push(target),
    onDiagnostic: (event) => diagnostics.push(event),
  });
  await controller.synchronizeIdentity();
  const [transferId] = await controller.createUploads([source], {
    resourceType: 'project', resourceId: 'project-a', targetKind: 'project_image',
  });
  assert.match(transferId, /^[a-f0-9-]{36}$/);
  await new Promise((resolve) => setImmediate(resolve));

  account = 'user-b';
  await controller.synchronizeIdentity();
  assert.deepEqual(controller.listTransfers(), [], '换账号后不得读取前账号传输');
  assert.equal(session.cacheClears, 1);
  assert.equal(session.storageClears, 1);

  account = 'user-a';
  await controller.synchronizeIdentity();
  await controller.waitForIdle();
  assert.equal(controller.listTransfers()[0].state, 'ready', '同账号重登后从中断分片恢复');
  assert.equal(firstPart, false);
  const writes = requests.filter((request) => request.method !== 'GET');
  assert.ok(writes.length >= 4);
  for (const request of writes) {
    assert.equal(request.headers.origin, 'https://studio.example.test');
    assert.equal(request.headers['x-csrf-token'], `csrf-${request.account}`);
    assert.match(request.headers.cookie, /__Host-team_session=/);
    assert.match(request.headers.cookie, /__Host-team_csrf=/);
  }

  await controller.syncDeliveries();
  await controller.waitForIdle();
  const downloads = controller.listTransfers().filter((item) => item.kind === 'download');
  assert.equal(downloads.length, 1);
  const downloadId = downloads[0].id;
  assert.equal(controller.listTransfers().find((item) => item.id === downloadId).state, 'failed',
    '已发布文件的回执失败应保留可重试状态');
  const downloadsBeforeReceiptRetry = fileDownloads;
  controller.resumeTransfer(downloadId);
  await controller.waitForIdle();
  assert.equal(fileDownloads, downloadsBeforeReceiptRetry, '回执重试不得重新下载已完整发布的文件');
  assert.equal(receiptAttempts, 2, '回执重试只需补交回执');
  assert.equal(diagnostics.length, 1, '同一传输终态失败只自动上报一次');
  assert.equal(diagnostics[0].stage, 'download');
  assert.equal(diagnostics[0].transferId, downloadId);
  assert.equal(diagnostics[0].phase, 'receipt');
  assert.match(diagnostics[0].clientEventId, /^[a-f0-9-]{36}$/);
  assert.equal(Object.hasOwn(diagnostics[0], 'message'), false, '本地诊断不得保留原始异常或路径');
  await controller.syncDeliveries();
  await controller.waitForIdle();
  assert.equal(controller.listTransfers().filter((item) => item.kind === 'download').length, 1,
    '设备清单重放不得创建重复下载');
  const download = controller.listTransfers().find((item) => item.id === downloadId);
  assert.equal(download.state, 'ready');
  assert.equal(await controller.revealDownload(downloadId), true);
  assert.equal(revealed.length, 1);
  assert.ok(path.resolve(revealed[0]).startsWith(path.resolve(root) + path.sep));
  await assert.rejects(() => controller.revealDownload(path.join(root, 'source.bin')), /download|下载|受管/);
  await assert.rejects(() => controller.revealDownload('unknown-download'), /download|下载|受管/);

  downloadManifest.version = 2;
  failNextReceipt = true;
  await controller.syncDeliveries();
  await controller.waitForIdle();
  const mismatchedId = controller.listTransfers().find((item) => item.kind === 'download' && item.state === 'failed').id;
  const mismatchedRecord = persistedTransfer(path.join(root, 'client-state'), mismatchedId);
  fs.writeFileSync(mismatchedRecord.localPath, 'tampered');
  const downloadsBeforeMismatch = fileDownloads;
  const receiptsBeforeMismatch = receiptAttempts;
  controller.resumeTransfer(mismatchedId);
  await controller.waitForIdle();
  assert.equal(controller.listTransfers().find((item) => item.id === mismatchedId).state, 'failed');
  assert.equal(fs.readFileSync(mismatchedRecord.localPath, 'utf8'), 'tampered', '内容不符的既有文件不得被覆盖');
  assert.equal(fileDownloads, downloadsBeforeMismatch, '内容不符时不得重新下载或重渲染');
  assert.equal(receiptAttempts, receiptsBeforeMismatch, '内容不符时不得补交错误回执');

  const clearsBeforeLogout = session.cacheClears;
  authenticated = false;
  await controller.synchronizeIdentity();
  assert.equal(session.cacheClears, clearsBeforeLogout + 1, '登出必须清除前账号缓存');
  assert.equal(session.storageClears, clearsBeforeLogout + 1, '登出必须清除前账号存储');
  assert.equal(diagnostics.filter((event) => event.transferId === downloadId).length, 1, '同一下载重试不得重复诊断');
  assert.equal(diagnostics.filter((event) => event.transferId === mismatchedId && event.phase === 'receipt').length, 1, '另一传输回执失败也必须保留');
  assert.equal(diagnostics.filter((event) => event.transferId === mismatchedId && event.phase === 'verification').length, 1, '既有文件内容不符是另一失败');
  assert.equal(new Set(diagnostics.map((event) => event.clientEventId)).size, diagnostics.length, '独立失败使用不同稳定身份');
  account = 'user-b';
  authenticated = true;
  await controller.synchronizeIdentity();
  assert.deepEqual(controller.listTransfers(), [], '登出后换账号不得恢复前账号传输或下载');
  console.log('team client remote transfer tests passed');
} finally {
  releaseFirstPart.resolve(new Response(new Uint8Array([97, 98, 99, 100])));
  fs.rmSync(root, { recursive: true, force: true });
}
