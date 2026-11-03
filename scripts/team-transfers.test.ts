import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import Database from 'better-sqlite3';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-team-transfers-'));
const previousRoot = process.env.CREATIVE_STUDIO_DATA_ROOT;
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
const db = new Database(':memory:');
db.pragma('foreign_keys = ON');

const { TEAM_SERVICE_MIGRATIONS } = await import('../lib/team-service/schema.ts');
const { registerRootScope } = await import('../lib/team-service/resource-scopes.ts');
const { resolveTeamFile, teamFileResponse } = await import('../lib/team-service/files/index.ts');
const {
  TransferError,
  cancelTeamUpload,
  completeTeamUpload,
  createTeamUpload,
  getTeamUpload,
  putTeamUploadPart,
  recoverTeamUploads,
} = await import('../lib/team-service/transfers/index.ts');

const storageRoot = path.join(root, 'storage');
const actor = (userId: string) => ({ userId, role: 'employee' as const });
const userA = actor('user-a');
const userB = actor('user-b');
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const stream = (bytes: Buffer, chunkSize = 8191) => Readable.from((function* () {
  for (let offset = 0; offset < bytes.length; offset += chunkSize) yield bytes.subarray(offset, offset + chunkSize);
})());

try {
  for (const migration of TEAM_SERVICE_MIGRATIONS) db.exec(migration.sql);
  assert.deepEqual(TEAM_SERVICE_MIGRATIONS.map((migration) => migration.version), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const insertUser = db.prepare(`INSERT INTO team_users (
    id, employeeId, displayName, role, status, passwordHash, mustChangePassword, sessionVersion, createdAt, updatedAt
  ) VALUES (?, ?, ?, 'employee', 'active', 'test', 0, 1, '2026-11-02', '2026-11-02')`);
  insertUser.run('user-a', '0001', '甲');
  insertUser.run('user-b', '0002', '乙');
  registerRootScope(db, { resourceType: 'test_resource', resourceId: 'resource-a', ownerUserId: userA.userId });
  registerRootScope(db, { resourceType: 'test_resource', resourceId: 'resource-b', ownerUserId: userB.userId });

  const bytes = Buffer.alloc(3 * 512 * 1024 + 123);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;
  const input = {
    target: { resourceType: 'test_resource', resourceId: 'resource-a' },
    relativeName: 'nested/large.bin',
    mimeType: 'application/octet-stream',
    usage: 'input',
    expectedSize: bytes.length,
    expectedSha256: sha256(bytes),
    sourceFingerprint: `source-v1:${sha256(bytes)}`,
    idempotencyKey: 'large-upload-v1',
    partSize: 512 * 1024,
  };
  const created = createTeamUpload(db, userA, { storageRoot, ...input });
  assert.equal(created.state, 'receiving');
  assert.deepEqual(created.missingParts, [1, 2, 3, 4]);
  assert.equal(createTeamUpload(db, userA, { storageRoot, ...input }).id, created.id);
  assert.throws(
    () => createTeamUpload(db, userA, { storageRoot, ...input, expectedSha256: sha256(Buffer.from('changed')) }),
    (error: unknown) => error instanceof TransferError && error.code === 'idempotency_conflict' && error.status === 409,
  );
  assert.throws(
    () => createTeamUpload(db, userA, { storageRoot, ...input, idempotencyKey: 'bad-name', relativeName: '../escape.bin' }),
    (error: unknown) => error instanceof TransferError && error.code === 'invalid_relative_name',
  );
  for (const relativeName of ['C:/absolute.bin', '/absolute.bin', 'folder/file.bin:ads', 'folder/CON.bin', 'folder/../escape.bin']) {
    assert.throws(
      () => createTeamUpload(db, userA, { storageRoot, ...input, idempotencyKey: `bad-${relativeName}`, relativeName }),
      (error: unknown) => error instanceof TransferError && error.code === 'invalid_relative_name',
      relativeName,
    );
  }

  const third = await putTeamUploadPart(db, userA, {
    storageRoot, uploadId: created.id, partNumber: 3, body: stream(bytes.subarray(2 * input.partSize, 3 * input.partSize)),
  });
  assert.equal(third.partNumber, 3);
  assert.equal(third.replayed, false);
  const first = await putTeamUploadPart(db, userA, {
    storageRoot, uploadId: created.id, partNumber: 1, body: stream(bytes.subarray(0, input.partSize)),
  });
  assert.equal(first.byteSize, input.partSize);
  assert.deepEqual(getTeamUpload(db, userA, { storageRoot, uploadId: created.id }).missingParts, [2, 4]);
  const replay = await putTeamUploadPart(db, userA, {
    storageRoot, uploadId: created.id, partNumber: 1, body: stream(bytes.subarray(0, input.partSize)),
  });
  assert.equal(replay.replayed, true);
  await assert.rejects(
    putTeamUploadPart(db, userA, {
      storageRoot, uploadId: created.id, partNumber: 1, body: stream(Buffer.alloc(input.partSize, 99)),
    }),
    (error: unknown) => error instanceof TransferError && error.code === 'part_conflict' && error.status === 409,
  );
  await assert.rejects(
    putTeamUploadPart(db, userA, {
      storageRoot, uploadId: created.id, partNumber: 2,
      body: stream(Buffer.concat([bytes.subarray(input.partSize, 2 * input.partSize), Buffer.from([1])])),
    }),
    (error: unknown) => error instanceof TransferError && error.code === 'part_size_mismatch',
  );
  assert.throws(
    () => getTeamUpload(db, userB, { storageRoot, uploadId: created.id }),
    (error: unknown) => error instanceof TransferError && error.code === 'upload_not_found' && error.status === 404,
  );
  await assert.rejects(
    completeTeamUpload(db, userA, { storageRoot, uploadId: created.id }),
    (error: unknown) => error instanceof TransferError && error.code === 'missing_parts',
  );
  assert.throws(
    () => resolveTeamFile(db, userA, { storageRoot, fileId: created.fileId }),
    /不存在或不可用/,
    'ready 前文件不能进入生产读取',
  );

  await putTeamUploadPart(db, userA, {
    storageRoot, uploadId: created.id, partNumber: 2, body: stream(bytes.subarray(input.partSize, 2 * input.partSize)),
  });
  await putTeamUploadPart(db, userA, {
    storageRoot, uploadId: created.id, partNumber: 4, body: stream(bytes.subarray(3 * input.partSize)),
  });
  const [completed, concurrent] = await Promise.all([
    completeTeamUpload(db, userA, {
      storageRoot, uploadId: created.id, expectedSha256: input.expectedSha256, sourceFingerprint: input.sourceFingerprint,
    }),
    completeTeamUpload(db, userA, { storageRoot, uploadId: created.id }),
  ]);
  assert.equal(concurrent.file.fileId, created.fileId, '并发 complete 共享同一发布结果');
  assert.equal(completed.file.fileId, created.fileId);
  assert.equal(completed.file.version, 1);
  assert.equal(completed.file.size, bytes.length);
  assert.equal(completed.file.sha256, input.expectedSha256);
  assert.equal(completed.state, 'ready');
  assert.equal(resolveTeamFile(db, userA, { storageRoot, fileId: created.fileId }).id, created.fileId);
  assert.equal((await completeTeamUpload(db, userA, { storageRoot, uploadId: created.id })).file.fileId, created.fileId);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM team_files WHERE id = ?').pluck().get(created.fileId), 1);
  const response = teamFileResponse(new Request('https://studio.example.test/file', {
    headers: { Range: 'bytes=100-199' },
  }), db, userA, { storageRoot, fileId: created.fileId });
  assert.equal(response.status, 206);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(100, 200));
  assert.throws(
    () => resolveTeamFile(db, userB, { storageRoot, fileId: created.fileId }),
    /不存在或不可用/,
  );

  const changedBytes = Buffer.from('source changed after initial fingerprint');
  const changed = createTeamUpload(db, userA, {
    storageRoot, ...input, idempotencyKey: 'source-change', relativeName: 'changed.bin',
    expectedSize: changedBytes.length, expectedSha256: sha256(Buffer.from('expected original')),
  });
  await putTeamUploadPart(db, userA, {
    storageRoot, uploadId: changed.id, partNumber: 1, body: stream(changedBytes),
  });
  await assert.rejects(
    completeTeamUpload(db, userA, { storageRoot, uploadId: changed.id }),
    (error: unknown) => error instanceof TransferError && error.code === 'source_changed',
  );
  assert.equal(getTeamUpload(db, userA, { storageRoot, uploadId: changed.id }).state, 'failed');
  assert.throws(() => resolveTeamFile(db, userA, { storageRoot, fileId: changed.fileId }), /不存在或不可用/);

  const crashBytes = Buffer.from('recover the same file after final move');
  const crashed = createTeamUpload(db, userA, {
    storageRoot, ...input, idempotencyKey: 'publish-crash', relativeName: 'crash.bin',
    expectedSize: crashBytes.length, expectedSha256: sha256(crashBytes), sourceFingerprint: 'crash-v1',
  });
  await putTeamUploadPart(db, userA, { storageRoot, uploadId: crashed.id, partNumber: 1, body: stream(crashBytes) });
  await assert.rejects(completeTeamUpload(db, userA, {
    storageRoot, uploadId: crashed.id, failAfterMoveForTest: true,
  }), /injected after move/);
  assert.equal(getTeamUpload(db, userA, { storageRoot, uploadId: crashed.id }).state, 'staged');
  assert.throws(() => resolveTeamFile(db, userA, { storageRoot, fileId: crashed.fileId }), /不存在或不可用/);
  const recovery = await recoverTeamUploads(db, { storageRoot });
  assert.equal(recovery.find((item) => item.uploadId === crashed.id)?.state, 'ready');
  assert.equal(resolveTeamFile(db, userA, { storageRoot, fileId: crashed.fileId }).id, crashed.fileId);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM team_files WHERE id = ?').pluck().get(crashed.fileId), 1);

  const noSpace = createTeamUpload(db, userA, {
    storageRoot, ...input, idempotencyKey: 'no-space', relativeName: 'no-space.bin',
    expectedSize: 4, expectedSha256: sha256(Buffer.from('four')), sourceFingerprint: 'no-space-v1',
  });
  await assert.rejects(putTeamUploadPart(db, userA, {
    storageRoot, uploadId: noSpace.id, partNumber: 1, body: stream(Buffer.from('four')),
    spaceProbe: () => { const error = new Error('no space') as NodeJS.ErrnoException; error.code = 'ENOSPC'; throw error; },
  }), (error: unknown) => error instanceof TransferError && error.code === 'insufficient_storage' && error.status === 507);
  assert.equal(getTeamUpload(db, userA, { storageRoot, uploadId: noSpace.id }).state, 'receiving');
  assert.deepEqual(getTeamUpload(db, userA, { storageRoot, uploadId: noSpace.id }).missingParts, [1]);

  const interrupted = createTeamUpload(db, userA, {
    storageRoot, ...input, idempotencyKey: 'interrupted', relativeName: 'interrupted.bin',
    expectedSize: 4, expectedSha256: sha256(Buffer.from('four')), sourceFingerprint: 'interrupted-v1',
  });
  const interruptedBody = (async function* () {
    yield Buffer.from('fo');
    const error = new Error('connection reset') as NodeJS.ErrnoException;
    error.code = 'ECONNRESET';
    throw error;
  })();
  await assert.rejects(putTeamUploadPart(db, userA, {
    storageRoot, uploadId: interrupted.id, partNumber: 1, body: interruptedBody,
  }), (error: unknown) => error instanceof TransferError && error.code === 'upload_interrupted');
  assert.deepEqual(getTeamUpload(db, userA, { storageRoot, uploadId: interrupted.id }).missingParts, [1]);
  await putTeamUploadPart(db, userA, {
    storageRoot, uploadId: interrupted.id, partNumber: 1, body: stream(Buffer.from('four')),
  });
  assert.deepEqual(getTeamUpload(db, userA, { storageRoot, uploadId: interrupted.id }).missingParts, []);

  const cancelled = createTeamUpload(db, userA, {
    storageRoot, ...input, idempotencyKey: 'cancelled', relativeName: 'cancelled.bin',
    expectedSize: 4, expectedSha256: sha256(Buffer.from('four')), sourceFingerprint: 'cancel-v1',
  });
  await putTeamUploadPart(db, userA, { storageRoot, uploadId: cancelled.id, partNumber: 1, body: stream(Buffer.from('four')) });
  assert.equal(cancelTeamUpload(db, userA, { storageRoot, uploadId: cancelled.id }).state, 'cancelled');
  await assert.rejects(completeTeamUpload(db, userA, { storageRoot, uploadId: cancelled.id }),
    (error: unknown) => error instanceof TransferError && error.code === 'upload_cancelled');
  assert.equal(cancelTeamUpload(db, userA, { storageRoot, uploadId: created.id }).state, 'ready');
  assert.equal(resolveTeamFile(db, userA, { storageRoot, fileId: created.fileId }).id, created.fileId);

  const cancelStaged = createTeamUpload(db, userA, {
    storageRoot, ...input, idempotencyKey: 'cancel-staged', relativeName: 'cancel-staged.bin',
    expectedSize: 4, expectedSha256: sha256(Buffer.from('four')), sourceFingerprint: 'cancel-staged-v1',
  });
  await putTeamUploadPart(db, userA, { storageRoot, uploadId: cancelStaged.id, partNumber: 1, body: stream(Buffer.from('four')) });
  await assert.rejects(completeTeamUpload(db, userA, {
    storageRoot, uploadId: cancelStaged.id, failAfterMoveForTest: true,
  }), /injected after move/);
  const stagedRow = db.prepare('SELECT relativePath FROM team_files WHERE id = ?').get(cancelStaged.fileId) as { relativePath: string };
  const stagedAbsolute = path.join(storageRoot, stagedRow.relativePath);
  assert.equal(fs.existsSync(stagedAbsolute), true);
  assert.equal(cancelTeamUpload(db, userA, { storageRoot, uploadId: cancelStaged.id }).state, 'cancelled');
  assert.equal(db.prepare('SELECT 1 FROM team_files WHERE id = ?').get(cancelStaged.fileId), undefined);
  assert.equal(fs.existsSync(stagedAbsolute), false);

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const wrongPart = Buffer.concat([Buffer.from('not a png'), png.subarray(9)]);
  const wrongMedia = createTeamUpload(db, userA, {
    storageRoot, ...input, idempotencyKey: 'wrong-media', relativeName: 'not-image.png', mimeType: 'image/png',
    expectedSize: wrongPart.length, expectedSha256: sha256(wrongPart), sourceFingerprint: 'png-v1',
  });
  await putTeamUploadPart(db, userA, { storageRoot, uploadId: wrongMedia.id, partNumber: 1, body: stream(wrongPart) });
  await assert.rejects(completeTeamUpload(db, userA, { storageRoot, uploadId: wrongMedia.id }),
    (error: unknown) => error instanceof TransferError && error.code === 'media_type_mismatch');
  assert.throws(() => resolveTeamFile(db, userA, { storageRoot, fileId: wrongMedia.fileId }), /不存在或不可用/);

  console.log('PASS: streaming parts, ordering/replay/conflicts, source changes, crash recovery, storage errors, cancel and immutable Range downloads');
} finally {
  db.close();
  if (previousRoot === undefined) delete process.env.CREATIVE_STUDIO_DATA_ROOT;
  else process.env.CREATIVE_STUDIO_DATA_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
}
