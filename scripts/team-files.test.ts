import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';

register('./typescript-extension-loader.mjs', import.meta.url);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-team-files-'));
const previousEnv = { ...process.env };
Object.assign(process.env, {
  CREATIVE_STUDIO_DATA_ROOT: root,
  CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
  CREATIVE_STUDIO_PORT: '3300',
  CREATIVE_STUDIO_DEPLOYMENT_ID: 'deployment-files',
  CREATIVE_STUDIO_TRUSTED_ORIGIN: 'https://studio.example.test',
});

const { ensureServerDeploymentMarker } = await import('../lib/team-service/config.ts');
const { getDb, closeDb } = await import('../lib/db.ts');
const { checkTeamServiceReadiness } = await import('../lib/team-service/readiness.ts');
const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
const {
  createTeamAccessContext,
  registerRootScope,
  requireResourceAccess,
} = await import('../lib/team-service/resource-scopes.ts');
const {
  registerReadyTeamFile,
  resolveTeamFile,
  teamFileEtag,
  teamFileResponse,
} = await import('../lib/team-service/files/index.ts');
const { fileResponse } = await import('../lib/media-core/file-response.ts');
const { publishTeamResource } = await import('../lib/team-service/files/publication.ts');
const { runWithAccessContext } = await import('../lib/media-core/access-context.ts');
const { buildGenericZipStream } = await import('../lib/zip-download.ts');

ensureServerDeploymentMarker({
  mode: 'server', dataRoot: root, hostname: '127.0.0.1', port: 3300,
  deploymentId: 'deployment-files', trustedOrigin: 'https://studio.example.test',
});
const db = getDb();
assert.equal((await checkTeamServiceReadiness({ db, ...schemaUpgradeRuntimePaths(root) })).available, true);
const insertUser = db.prepare(`INSERT INTO team_users (
  id, employeeId, displayName, role, status, passwordHash, mustChangePassword, sessionVersion, createdAt, updatedAt
) VALUES (?, ?, ?, ?, 'active', 'test', 0, 1, '2026-11-02', '2026-11-02')`);
insertUser.run('admin', '0000', '管理员', 'admin');
insertUser.run('user-a', '0001', '甲', 'employee');
insertUser.run('user-b', '0002', '乙', 'employee');
const principal = (userId: string, role: 'employee' | 'admin' = 'employee') => ({
  kind: 'user' as const,
  userId,
  employeeId: userId,
  displayName: userId,
  role,
  sessionId: `session-${userId}`,
  sessionVersion: 1,
  mustChangePassword: false,
  absoluteExpiresAt: '2099-01-01T00:00:00.000Z',
});
const admin = principal('admin', 'admin');
const userA = principal('user-a');
const userB = principal('user-b');
for (const [id, ownerUserId] of [['resource-a', 'user-a'], ['resource-b', 'user-b'], ['resource-public', 'admin']] as const) {
  registerRootScope(db, { resourceType: 'test_resource', resourceId: id, ownerUserId });
}

const storageRoot = path.join(root, 'storage');
fs.mkdirSync(path.join(storageRoot, 'inputs'), { recursive: true });
const bytes = Buffer.from('same bytes, independent permissions');
fs.writeFileSync(path.join(storageRoot, 'inputs', 'a.txt'), bytes);
fs.writeFileSync(path.join(storageRoot, 'inputs', 'b.txt'), bytes);
const referenceA = { resourceType: 'test_resource', resourceId: 'resource-a' };
const referenceB = { resourceType: 'test_resource', resourceId: 'resource-b' };

/**
 * 统计一次同步操作真正从磁盘读到的字节数。
 * 登记快路径的验收点就是"已核验的稳定衍生物不再读满整个文件"，
 * 用 readSync 返回字节数作为可观测量，避免依赖内部实现细节。
 */
function withReadByteCounter<T>(operation: () => T): { value: T; bytes: number } {
  const originalReadSync = fs.readSync;
  let bytes = 0;
  fs.readSync = ((...args: unknown[]) => {
    const read = (originalReadSync as (...rest: unknown[]) => number)(...args);
    if (read > 0) bytes += read;
    return read;
  }) as typeof fs.readSync;
  try {
    return { value: operation(), bytes };
  } finally {
    fs.readSync = originalReadSync;
  }
}

try {
  const fileA = registerReadyTeamFile(db, {
    storageRoot,
    absolutePath: path.join(storageRoot, 'inputs', 'a.txt'),
    mimeType: 'application/octet-stream',
    ownerUserId: userA.userId,
    references: [referenceA],
    validateReference: (reference) => { requireResourceAccess(db, userA, reference.resourceType, reference.resourceId, 'write'); },
  });
  const fileB = registerReadyTeamFile(db, {
    storageRoot,
    absolutePath: path.join(storageRoot, 'inputs', 'b.txt'),
    mimeType: 'application/octet-stream',
    ownerUserId: userB.userId,
    references: [referenceB],
    validateReference: (reference) => { requireResourceAccess(db, userB, reference.resourceType, reference.resourceId, 'write'); },
  });
  assert.notEqual(fileA.id, fileB.id);
  assert.equal(fileA.sha256, fileB.sha256);
  assert.equal(fileA.state, 'ready');
  assert.equal(fileA.version, 1);
  assert.ok(fileA.readySeq !== null && fileA.readySeq > 0);
  assert.throws(() => resolveTeamFile(db, userB, { storageRoot, fileId: fileA.id }), /不存在或不可用/);
  assert.equal(resolveTeamFile(db, userA, { storageRoot, fileId: fileA.id }).id, fileA.id);
  assert.equal(resolveTeamFile(db, userB, { storageRoot, fileId: fileB.id }).id, fileB.id);
  assert.throws(() => resolveTeamFile(db, userA, { storageRoot, relativePath: 'inputs/b.txt' }), /不存在或不可用/);

  const range = teamFileResponse(new Request('https://studio.example.test/api/team/files/x', {
    headers: { Range: 'bytes=1-4' },
  }), db, userA, { storageRoot, fileId: fileA.id });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('Content-Range'), `bytes 1-4/${bytes.byteLength}`);
  assert.equal(range.headers.get('Cache-Control'), 'private, no-store');
  assert.match(range.headers.get('ETag') ?? '', /^"[a-f0-9]{64}"$/);
  assert.equal(Buffer.from(await range.arrayBuffer()).toString(), bytes.subarray(1, 5).toString());
  const etag = range.headers.get('ETag')!;
  const notModified = teamFileResponse(new Request('https://studio.example.test/api/team/files/x', {
    headers: { 'If-None-Match': etag },
  }), db, userA, { storageRoot, fileId: fileA.id });
  assert.equal(notModified.status, 304);

  // 团队授权 + onClose:零消费只预读固定上界,取消关闭源流并恰好释放一次。
  // teamFileResponse 不暴露 onClose,用同一 fileResponse 契约与 teamFileEtag 验证共享路径。
  const bigBytesPath = path.join(storageRoot, 'inputs', 'big.bin');
  const bigChunk = Buffer.alloc(1024 * 1024, 7);
  const bigFd = fs.openSync(bigBytesPath, 'w');
  for (let index = 0; index < 64; index += 1) fs.writeSync(bigFd, bigChunk);
  fs.closeSync(bigFd);
  const bigFile = registerReadyTeamFile(db, {
    storageRoot,
    absolutePath: bigBytesPath,
    mimeType: 'video/mp4',
    ownerUserId: userA.userId,
    references: [referenceA],
    validateReference: (reference) => { requireResourceAccess(db, userA, reference.resourceType, reference.resourceId, 'write'); },
  });
  const capturedStreams: fs.ReadStream[] = [];
  const originalCreateReadStream = fs.createReadStream;
  fs.createReadStream = function patchedCreateReadStream(...args: unknown[]) {
    const stream = (originalCreateReadStream as (...rest: unknown[]) => fs.ReadStream).apply(fs, args);
    capturedStreams.push(stream);
    return stream;
  } as typeof fs.createReadStream;
  let streamedResponse: Response;
  let onCloseCount = 0;
  try {
    streamedResponse = fileResponse(
      new Request('https://studio.example.test/api/team/files/big', { headers: { Range: 'bytes=0-67108863' } }),
      bigBytesPath,
      'video/mp4',
      {
        cacheControl: 'private, no-store',
        etag: teamFileEtag(bigFile),
        grant: { fileId: bigFile.id, seriesId: bigFile.seriesId, version: bigFile.version, sha256: bigFile.sha256 },
        onClose: () => { onCloseCount += 1; },
      },
    );
  } finally {
    fs.createReadStream = originalCreateReadStream;
  }
  assert.equal(streamedResponse.status, 206);
  assert.equal(streamedResponse.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(streamedResponse.headers.get('Content-Range'), `bytes 0-67108863/${64 * 1024 * 1024}`);
  const bigSource = capturedStreams[0];
  assert.ok(bigSource, '团队授权响应必须创建源文件流');
  await new Promise((resolve) => { setTimeout(resolve, 250); });
  const bytesReadBeforeCancel = bigSource.bytesRead;
  assert.ok(bytesReadBeforeCancel <= 512 * 1024, `零消费预读 ${bytesReadBeforeCancel} 字节超出固定上界`);
  assert.equal(onCloseCount, 0, '未消费时不得提前释放租约');
  await streamedResponse.body!.cancel('client aborted');
  await new Promise((resolve) => { setTimeout(resolve, 50); });
  assert.equal(onCloseCount, 1, '取消后 onClose 必须恰好一次');
  assert.equal(bigSource.destroyed, true, '取消必须销毁源文件流');
  assert.equal(bigSource.closed, true, '取消必须关闭源文件流');
  assert.equal(bigSource.bytesRead, bytesReadBeforeCancel, '取消后不得继续读取源文件');

  fs.writeFileSync(path.join(storageRoot, 'inputs', 'a.derived.txt'), Buffer.from('derivative'));
  const derived = registerReadyTeamFile(db, {
    storageRoot,
    absolutePath: path.join(storageRoot, 'inputs', 'a.derived.txt'),
    mimeType: 'application/octet-stream',
    ownerUserId: userA.userId,
    derivedFromFileId: fileA.id,
    seriesId: fileA.seriesId,
  });
  assert.equal(derived.version, 2);
  assert.equal(derived.derivedFromFileId, fileA.id);
  assert.throws(() => resolveTeamFile(db, userB, { storageRoot, fileId: derived.id }), /不存在或不可用/);

  // --- 已登记稳定衍生物的身份快速路径 ---
  // 首次仍必须完整核验；之后同路径、同来源、同身份的重复登记（每次 Range
  // 请求都会走一次）只做授权/谱系/身份校验，不再读满整个文件。
  const reuseBytes = Buffer.alloc(4 * 1024 * 1024, 9);
  const reuseDerivedPath = path.join(storageRoot, 'inputs', 'a.derived-reuse.bin');
  fs.writeFileSync(reuseDerivedPath, reuseBytes);
  const registerReuse = () => registerReadyTeamFile(db, {
    storageRoot,
    absolutePath: reuseDerivedPath,
    mimeType: 'application/octet-stream',
    ownerUserId: userA.userId,
    derivedFromFileId: fileA.id,
    validateReference: (reference) => {
      requireResourceAccess(db, userA, reference.resourceType, reference.resourceId, 'read');
    },
  });
  const firstReuse = withReadByteCounter(registerReuse);
  assert.equal(firstReuse.bytes, reuseBytes.byteLength, '首次衍生登记必须完整算满文件哈希');
  const repeatReuse = withReadByteCounter(registerReuse);
  assert.equal(repeatReuse.value.id, firstReuse.value.id, '重复登记必须复用同一不可变登记');
  assert.equal(repeatReuse.bytes, 0, '已登记稳定衍生物的重复登记不得再读全文件');
  for (let index = 0; index < 4; index += 1) {
    assert.equal(withReadByteCounter(registerReuse).bytes, 0, '后续 Range/登记不得重复全量哈希');
  }

  // 身份变化（重写同内容）必须重新完整核验，核验一致后刷新身份再恢复快路径。
  await new Promise((resolve) => { setTimeout(resolve, 10); });
  fs.writeFileSync(reuseDerivedPath, reuseBytes);
  const refreshedReuse = withReadByteCounter(registerReuse);
  assert.equal(refreshedReuse.value.id, firstReuse.value.id);
  assert.ok(refreshedReuse.bytes > 0, '身份变化时必须重新完整核验，不能只看路径');
  assert.equal(withReadByteCounter(registerReuse).bytes, 0, '刷新身份记录后应恢复快路径');

  // 身份变化且内容不同：必须明确拒绝，且拒绝前已完成完整核验。
  await new Promise((resolve) => { setTimeout(resolve, 10); });
  fs.writeFileSync(reuseDerivedPath, Buffer.alloc(reuseBytes.byteLength, 8));
  const replacedReuse = withReadByteCounter(() => {
    assert.throws(registerReuse, /文件身份与既有不可变登记不一致/, '替换文件不得误命中既有登记');
  });
  assert.ok(replacedReuse.bytes > 0, '替换文件必须完整核验后才拒绝');

  // 来源谱系变化（同一路径换 derivedFromFileId）不得复用旧登记。
  assert.throws(() => registerReadyTeamFile(db, {
    storageRoot,
    absolutePath: path.join(storageRoot, 'inputs', 'a.derived.txt'),
    mimeType: 'application/octet-stream',
    ownerUserId: userA.userId,
    derivedFromFileId: fileB.id,
  }), /文件身份与既有不可变登记不一致/, '来源谱系变化必须拒绝');

  // 跨成员：即使登记已存在，每次请求仍执行当前用户授权，无权即拒绝。
  assert.throws(() => registerReadyTeamFile(db, {
    storageRoot,
    absolutePath: path.join(storageRoot, 'inputs', 'a.derived.txt'),
    mimeType: 'application/octet-stream',
    ownerUserId: userB.userId,
    derivedFromFileId: fileA.id,
    validateExisting: () => {
      requireResourceAccess(db, userB, 'test_resource', 'resource-a', 'read');
    },
  }), /无权/, '缓存命中不得绕过跨成员授权');

  // 通用（非衍生）文件登记保持原有完整核验，不被本次优化全局放宽。
  const genericBytes = Buffer.alloc(2 * 1024 * 1024, 5);
  const genericPath = path.join(storageRoot, 'inputs', 'generic.bin');
  fs.writeFileSync(genericPath, genericBytes);
  const registerGeneric = () => registerReadyTeamFile(db, {
    storageRoot,
    absolutePath: genericPath,
    mimeType: 'application/octet-stream',
    ownerUserId: userA.userId,
    references: [referenceA],
  });
  assert.equal(withReadByteCounter(registerGeneric).bytes, genericBytes.byteLength, '通用文件首次登记完整核验');
  assert.equal(withReadByteCounter(registerGeneric).bytes, genericBytes.byteLength, '通用文件重复登记仍完整核验');


  const contextA = createTeamAccessContext({ db, principal: userA });
  assert.throws(() => runWithAccessContext(contextA, () => buildGenericZipStream([
    { filePath: path.join(storageRoot, 'inputs', 'b.txt'), filename: 'stolen.txt' },
  ])), /不存在或不可用/);
  const zip = runWithAccessContext(contextA, () => buildGenericZipStream([
    { filePath: path.join(storageRoot, 'inputs', 'a.txt'), filename: 'owned.txt' },
  ]));
  assert.ok(zip);

  publishTeamResource(db, admin, referenceB);
  assert.equal(resolveTeamFile(db, userA, { storageRoot, fileId: fileB.id }).id, fileB.id);
  assert.throws(() => requireResourceAccess(db, userA, referenceB.resourceType, referenceB.resourceId, 'write'), /无权/);
  assert.throws(() => publishTeamResource(db, userA, referenceA), /管理员/);

  // 来源引用撤销后，衍生物不得再复用旧登记。
  db.prepare('UPDATE team_file_references SET releasedAt = ? WHERE fileId = ?')
    .run(new Date().toISOString(), fileA.id);
  assert.throws(registerReuse, /文件必须绑定已授权实体/, '来源引用撤销后不得复用衍生登记');

  db.prepare('DELETE FROM team_file_references WHERE fileId = ?').run(derived.id);
  db.prepare('DELETE FROM team_files WHERE id = ?').run(derived.id);
  // 本轮新增的衍生登记仍以 fileA 为来源，先清理再删除来源行。
  db.prepare('DELETE FROM team_file_references WHERE fileId IN (SELECT id FROM team_files WHERE derivedFromFileId = ?)').run(fileA.id);
  db.prepare('DELETE FROM team_files WHERE derivedFromFileId = ?').run(fileA.id);
  db.prepare('DELETE FROM team_file_references WHERE fileId = ?').run(fileA.id);
  db.prepare('DELETE FROM team_files WHERE id = ?').run(fileA.id);
  assert.equal(resolveTeamFile(db, userA, { storageRoot, fileId: fileB.id }).id, fileB.id);
  assert.throws(() => resolveTeamFile(db, userA, { storageRoot, fileId: fileA.id }), /不存在或不可用/);

  console.log('PASS: team file versions, same-hash isolation, derivative scope, Range/ETag, ZIP and public read-only access');
} finally {
  closeDb();
  process.env = previousEnv;
  fs.rmSync(root, { recursive: true, force: true });
}
