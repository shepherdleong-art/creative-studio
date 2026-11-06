import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import Database from 'better-sqlite3';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-team-devices-'));
const previousRoot = process.env.CREATIVE_STUDIO_DATA_ROOT;
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
const db = new Database(':memory:');
db.pragma('foreign_keys = ON');
const { TEAM_SERVICE_MIGRATIONS } = await import('../lib/team-service/schema.ts');
const { registerRootScope } = await import('../lib/team-service/resource-scopes.ts');
const { softDeleteResource } = await import('../lib/team-service/lifecycle/index.ts');
const { resolveTeamFile, teamFileResponse } = await import('../lib/team-service/files/index.ts');
const { TransferError, createTeamUpload, putTeamUploadPart, completeTeamUpload } = await import('../lib/team-service/transfers/index.ts');
const {
  listTeamDevices,
  listTeamDownloads,
  recordTeamDownloadReceipt,
  registerTeamDevice,
} = await import('../lib/team-service/transfers/devices.ts');
const { publishVerifiedTeamDownload } = await import('../lib/team-service/transfers/local-download.ts');

const storageRoot = path.join(root, 'storage');
const actor = (userId: string) => ({ userId, role: 'employee' as const });
const userA = actor('user-a');
const userB = actor('user-b');
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function publish(user: ReturnType<typeof actor>, projectId: string, name: string, bytes: Buffer, key: string) {
  const upload = createTeamUpload(db, user, {
    storageRoot,
    target: { resourceType: 'project', resourceId: projectId },
    usage: 'output', relativeName: name, mimeType: 'application/octet-stream',
    expectedSize: bytes.length, expectedSha256: sha256(bytes), sourceFingerprint: `${key}-source`,
    idempotencyKey: key,
  });
  await putTeamUploadPart(db, user, {
    storageRoot, uploadId: upload.id, partNumber: 1, body: Readable.from([bytes]),
  });
  return (await completeTeamUpload(db, user, { storageRoot, uploadId: upload.id })).file;
}

try {
  for (const migration of TEAM_SERVICE_MIGRATIONS) db.exec(migration.sql);
  db.exec('CREATE TABLE projects (id TEXT PRIMARY KEY)');
  const insertUser = db.prepare(`INSERT INTO team_users (
    id, employeeId, displayName, role, status, passwordHash, mustChangePassword, sessionVersion, createdAt, updatedAt
  ) VALUES (?, ?, ?, 'employee', 'active', 'test', 0, 1, '2026-11-02', '2026-11-02')`);
  insertUser.run('user-a', '0001', '甲');
  insertUser.run('user-b', '0002', '乙');
  db.prepare('INSERT INTO projects VALUES (?)').run('project-a');
  db.prepare('INSERT INTO projects VALUES (?)').run('project-b');
  registerRootScope(db, { resourceType: 'project', resourceId: 'project-a', ownerUserId: userA.userId });
  registerRootScope(db, { resourceType: 'project', resourceId: 'project-b', ownerUserId: userB.userId });

  const original = registerTeamDevice(db, userA, {
    deploymentId: 'deployment-a', clientDeviceId: 'client-original', displayName: '原设备', platform: 'win32-x64',
  });
  assert.equal(original.subscriptionCursor, 0);
  const first = await publish(userA, 'project-a', '成片.mp4', Buffer.from('first immutable artifact'), 'artifact-1');
  const pending = listTeamDownloads(db, userA, { deviceId: original.id });
  assert.equal(pending.items.length, 1);
  assert.deepEqual(pending.items[0].manifest, first);
  assert.equal(pending.items[0].deliveryState, 'pending');

  const newDevice = registerTeamDevice(db, userA, {
    deploymentId: 'deployment-a', clientDeviceId: 'client-new', displayName: '新设备', platform: 'win32-x64',
  });
  assert.equal(newDevice.subscriptionCursor, pending.items[0].readySeq);
  assert.deepEqual(listTeamDownloads(db, userA, { deviceId: newDevice.id }).items, [], '新设备不能通过默认或 after=0 补拉历史');
  assert.deepEqual(listTeamDownloads(db, userA, { deviceId: newDevice.id, after: 0 }).items, []);
  assert.equal(resolveTeamFile(db, userA, { storageRoot, fileId: first.fileId }).id, first.fileId, '旧成果仍可手工下载');
  assert.equal(listTeamDevices(db, userA).length, 2);
  assert.deepEqual(listTeamDevices(db, userB), []);

  const otherUserDevice = registerTeamDevice(db, userB, {
    deploymentId: 'deployment-a', clientDeviceId: 'client-original', displayName: '乙设备', platform: 'win32-x64',
  });
  assert.notEqual(otherUserDevice.id, original.id, '不同用户使用相同 clientDeviceId 也不能串号');
  assert.throws(() => listTeamDownloads(db, userB, { deviceId: original.id }),
    (error: unknown) => error instanceof TransferError && error.code === 'device_not_found');
  assert.throws(() => recordTeamDownloadReceipt(db, userB, {
    deviceId: otherUserDevice.id, fileId: first.fileId, artifactVersion: first.version,
    state: 'completed', etag: first.etag, verifiedSha256: first.sha256,
  }), (error: unknown) => error instanceof TransferError && error.code === 'download_not_found');

  await assert.rejects(async () => recordTeamDownloadReceipt(db, userA, {
    deviceId: original.id, fileId: first.fileId, artifactVersion: first.version,
    state: 'completed', etag: first.etag, verifiedSha256: sha256(Buffer.from('wrong')),
  }), (error: unknown) => error instanceof TransferError && error.code === 'receipt_conflict');
  const failed = recordTeamDownloadReceipt(db, userA, {
    deviceId: original.id, fileId: first.fileId, artifactVersion: first.version,
    state: 'failed', failureCode: 'network_interrupted',
  });
  assert.equal(failed.state, 'failed');
  assert.equal(failed.attemptCount, 1);
  assert.equal(listTeamDownloads(db, userA, { deviceId: original.id }).items[0].deliveryState, 'failed', '失败不触发生成且仍需补下');
  const completed = recordTeamDownloadReceipt(db, userA, {
    deviceId: original.id, fileId: first.fileId, artifactVersion: first.version,
    state: 'completed', etag: first.etag, verifiedSha256: first.sha256,
  });
  assert.equal(completed.state, 'completed');
  assert.equal(completed.attemptCount, 2);
  assert.equal(recordTeamDownloadReceipt(db, userA, {
    deviceId: original.id, fileId: first.fileId, artifactVersion: first.version,
    state: 'completed', etag: first.etag, verifiedSha256: first.sha256,
  }).attemptCount, 2, '重复完成回执幂等');
  assert.deepEqual(listTeamDownloads(db, userA, { deviceId: original.id }).items, []);

  const second = await publish(userA, 'project-a', '成片.mp4', Buffer.from('second immutable artifact with new version'), 'artifact-2');
  assert.notEqual(second.fileId, first.fileId);
  assert.notEqual(second.etag, first.etag);
  const originalEtagResponse = teamFileResponse(new Request('https://studio.example.test/file', {
    headers: { Range: 'bytes=2-', 'If-Range': first.etag },
  }), db, userA, { storageRoot, fileId: second.fileId });
  assert.equal(originalEtagResponse.status, 200, '版本变化时 If-Range 不得把旧 .part 拼入新版本');
  assert.deepEqual(Buffer.from(await originalEtagResponse.arrayBuffer()), Buffer.from('second immutable artifact with new version'));

  const third = await publish(userA, 'project-a', '将删除.mp4', Buffer.from('suppressed automatic delivery'), 'artifact-3');
  softDeleteResource(db, userA, { resourceType: 'project', resourceId: 'project-a' });
  const suppressedList = listTeamDownloads(db, userA, { deviceId: original.id });
  const suppressed = suppressedList.items.find((item) => item.manifest.fileId === third.fileId);
  assert.equal(suppressed?.deliveryState, 'suppressed');
  assert.ok(suppressedList.items.some((item) => item.manifest.fileId === second.fileId), '其它未完成产物仍需补下');
  const suppressedReceipt = recordTeamDownloadReceipt(db, userA, {
    deviceId: original.id, fileId: third.fileId, artifactVersion: third.version, state: 'suppressed',
  });
  assert.equal(suppressedReceipt.state, 'suppressed');
  assert.equal(listTeamDownloads(db, userA, { deviceId: original.id }).items.some((item) => item.manifest.fileId === third.fileId), false);

  const downloadRoot = path.join(root, 'client-download');
  fs.mkdirSync(downloadRoot, { recursive: true });
  const partA = path.join(root, 'a.part');
  const partB = path.join(root, 'b.part');
  fs.writeFileSync(partA, 'same name A');
  fs.writeFileSync(partB, 'same name B');
  const savedA = await publishVerifiedTeamDownload({
    partPath: partA, directory: downloadRoot, displayName: '成片.mp4', expectedSize: 11, expectedSha256: sha256(Buffer.from('same name A')),
  });
  const savedB = await publishVerifiedTeamDownload({
    partPath: partB, directory: downloadRoot, displayName: '成片.mp4', expectedSize: 11, expectedSha256: sha256(Buffer.from('same name B')),
  });
  assert.notEqual(savedA.absolutePath, savedB.absolutePath);
  assert.equal(fs.readFileSync(savedA.absolutePath, 'utf8'), 'same name A');
  assert.equal(fs.readFileSync(savedB.absolutePath, 'utf8'), 'same name B');
  const badPart = path.join(root, 'bad.part');
  fs.writeFileSync(badPart, 'corrupt');
  await assert.rejects(publishVerifiedTeamDownload({
    partPath: badPart, directory: downloadRoot, displayName: '成片.mp4', expectedSize: 7, expectedSha256: sha256(Buffer.from('correct')),
  }), (error: unknown) => error instanceof TransferError && error.code === 'receipt_conflict');
  assert.deepEqual(fs.readdirSync(downloadRoot).sort(), [path.basename(savedA.absolutePath), path.basename(savedB.absolutePath)].sort(), '校验失败不得发布文件');

  console.log('PASS: two-user/two-device cursors, verified receipts, immutable Range versions, soft-delete suppression and non-overwriting local publish');
} finally {
  db.close();
  if (previousRoot === undefined) delete process.env.CREATIVE_STUDIO_DATA_ROOT;
  else process.env.CREATIVE_STUDIO_DATA_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
}
