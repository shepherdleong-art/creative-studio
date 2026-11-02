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

const requests = [];
let account = 'user-a';
let authenticated = true;
let firstPart = true;
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
      return new Response(downloadPayload, { status: 200, headers: { etag: 'etag-a' } });
    }
    if (pathname === '/api/team/downloads/receipts') return Response.json({ state: 'completed' });
    throw new Error(`unexpected request ${options.method ?? 'GET'} ${pathname}`);
  },
};

try {
  const revealed = [];
  const controller = new RemoteTransferController({
    origin: 'https://studio.example.test',
    deploymentId: 'deployment-fixture',
    stateRoot: path.join(root, 'client-state'),
    session,
    platform: 'windows',
    reveal: (target) => revealed.push(target),
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
  await controller.syncDeliveries();
  await controller.waitForIdle();
  const downloads = controller.listTransfers().filter((item) => item.kind === 'download');
  assert.equal(downloads.length, 1, '设备清单重放不得创建重复下载');
  const downloadId = downloads[0].id;
  const download = controller.listTransfers().find((item) => item.id === downloadId);
  assert.equal(download.state, 'ready');
  assert.equal(await controller.revealDownload(downloadId), true);
  assert.equal(revealed.length, 1);
  assert.ok(path.resolve(revealed[0]).startsWith(path.resolve(root) + path.sep));
  await assert.rejects(() => controller.revealDownload(path.join(root, 'source.bin')), /download|下载|受管/);
  await assert.rejects(() => controller.revealDownload('unknown-download'), /download|下载|受管/);

  const clearsBeforeLogout = session.cacheClears;
  authenticated = false;
  await controller.synchronizeIdentity();
  assert.equal(session.cacheClears, clearsBeforeLogout + 1, '登出必须清除前账号缓存');
  assert.equal(session.storageClears, clearsBeforeLogout + 1, '登出必须清除前账号存储');
  account = 'user-b';
  authenticated = true;
  await controller.synchronizeIdentity();
  assert.deepEqual(controller.listTransfers(), [], '登出后换账号不得恢复前账号传输或下载');
  console.log('team client remote transfer tests passed');
} finally {
  releaseFirstPart.resolve(new Response(new Uint8Array([97, 98, 99, 100])));
  fs.rmSync(root, { recursive: true, force: true });
}
