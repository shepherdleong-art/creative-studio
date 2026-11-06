import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

// 所有数据库和物理文件均在隔离临时数据根；绝不扫描仓库或生产 storage。
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'team-maintenance-cleanup-'));
const dataRoot = path.join(fixture, 'data-root');
const storageRoot = path.join(dataRoot, 'storage');
const backupRoot = path.join(fixture, 'backup-root');
const oldRoot = path.join(fixture, 'retained-after-restore');
fs.mkdirSync(storageRoot, { recursive: true });
fs.mkdirSync(backupRoot, { recursive: true });
fs.mkdirSync(oldRoot, { recursive: true });
fs.mkdirSync(path.join(dataRoot, 'data'), { recursive: true });
fs.writeFileSync(path.join(backupRoot, 'manual-backup-evidence'), 'protected backup');
fs.writeFileSync(path.join(oldRoot, 'original.media'), 'protected old root');
fs.writeFileSync(path.join(storageRoot, 'formal-original.media'), 'normal project original');
fs.mkdirSync(path.join(storageRoot, 'execution-journal'), { recursive: true });
fs.writeFileSync(path.join(storageRoot, 'execution-journal', '000001.jsonl'), 'execution evidence');
let previewStore: import('../lib/team-service/maintenance/cleanup.ts').CleanupPreviewStore | undefined;
let replacementStore: import('../lib/team-service/maintenance/cleanup.ts').CleanupPreviewStore | undefined;
const db = new Database(path.join(dataRoot, 'data', 'workbench.db'));
db.pragma('foreign_keys = ON');
const { TEAM_SERVICE_MIGRATIONS } = await import('../lib/team-service/schema.ts');
for (const migration of TEAM_SERVICE_MIGRATIONS) db.exec(migration.sql);
db.exec(`
  CREATE TABLE projects (id TEXT PRIMARY KEY);
  CREATE TABLE image_assets (id TEXT PRIMARY KEY, projectId TEXT);
  CREATE TABLE execution_operations (id TEXT PRIMARY KEY, scopeType TEXT NOT NULL, scopeId TEXT NOT NULL, status TEXT NOT NULL);
  CREATE TABLE batch_proxy_cache_items (
    id TEXT PRIMARY KEY, projectId TEXT NOT NULL, assetId TEXT NOT NULL, relativePath TEXT NOT NULL,
    status TEXT NOT NULL, fileSizeBytes INTEGER NOT NULL, pendingDeleteAt TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
  );
  CREATE TABLE batch_proxy_requests (
    id TEXT PRIMARY KEY, currentCacheItemId TEXT, status TEXT NOT NULL,
    FOREIGN KEY(currentCacheItemId) REFERENCES batch_proxy_cache_items(id) ON DELETE SET NULL
  );
  CREATE TABLE batch_tasks (
    id TEXT PRIMARY KEY, projectId TEXT NOT NULL, workType TEXT NOT NULL,
    targetKind TEXT NOT NULL, targetId TEXT NOT NULL, status TEXT NOT NULL
  );
  INSERT INTO team_users (id, employeeId, displayName, role, status, passwordHash, mustChangePassword, sessionVersion, createdAt, updatedAt)
  VALUES ('admin', '0000', '管理员', 'admin', 'active', 'x', 0, 1, '2026-11-01', '2026-11-01');
  INSERT INTO projects VALUES ('project-a'), ('project-b'), ('project-history');
  INSERT INTO image_assets VALUES ('shared-artifact', 'project-a'), ('shared-artifact-2', 'project-a'), ('pinned-artifact', 'project-a'), ('inflight-artifact', 'project-a'), ('historical-artifact', 'project-history'),
    ('cross-shared-artifact', 'project-a'), ('cross-shared-second', 'project-a');
`);
const { registerRootScope, registerInheritedScope } = await import('../lib/team-service/resource-scopes.ts');
void registerRootScope;
const { registerReadyTeamFile } = await import('../lib/team-service/files/registry.ts');
const { softDeleteResource, createBackupPin } = await import('../lib/team-service/lifecycle/index.ts');
const admin = {
  kind: 'user' as const, userId: 'admin', employeeId: '0000', displayName: '管理员', role: 'admin' as const,
  sessionId: 'admin-session', sessionVersion: 1, mustChangePassword: false,
  absoluteExpiresAt: '2099-01-01T00:00:00.000Z',
};
for (const projectId of ['project-a', 'project-b', 'project-history']) {
  registerRootScope(db, { resourceType: 'project', resourceId: projectId, ownerUserId: 'admin' });
}
function upload(id: string, state: string) {
  db.prepare(`INSERT INTO team_uploads (
    id, userId, targetResourceType, targetResourceId, usage, relativeName, mimeType,
    expectedSize, expectedSha256, sourceFingerprint, partSize, idempotencyKey, state, fileId, createdAt, updatedAt
  ) VALUES (?, 'admin', 'project', 'project-a', 'input', ?, 'application/octet-stream',
    10, ?, ?, 1024, ?, ?, ?, '2026-10-01', '2026-10-01')`)
    .run(id, `${id}.part`, '0'.repeat(64), id, id, state, `${id}-file`);
}
function temporaryFile(relativePath: string, content: string): void {
  const target = path.join(storageRoot, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}
function readyFile(id: string, projectId: string, content: string) {
  const target = path.join(storageRoot, 'team-files', id, 'v1', 'artifact.bin');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  registerInheritedScope(db, { resourceType: 'image', resourceId: id, ownerUserId: 'admin', parent: { resourceType: 'project', resourceId: projectId } });
  const file = registerReadyTeamFile(db, {
    storageRoot, absolutePath: target, mimeType: 'application/octet-stream', ownerUserId: 'admin',
    references: [{ resourceType: 'image', resourceId: id, role: 'output' }], seriesId: id,
  });
  return { id: file.id, relativePath: file.relativePath };
}

try {
  // Slice 1：分类、受保护项与共享物理文件只计一次。
  upload('failed-upload', 'failed');
  temporaryFile('team-staging/failed-upload/parts/1.part', '1234567890');
  upload('inflight-upload', 'receiving');
  temporaryFile('team-staging/inflight-upload/parts/1.part', 'inflight');
  db.prepare(`INSERT INTO batch_proxy_cache_items VALUES
    ('failed-cache', 'project-a', 'asset-a', 'storage/cache/proxies/failed.mp4', 'failed', 5, NULL, '2026-01-01', '2026-01-01'),
    ('expired-cache', 'project-a', 'asset-a', 'storage/cache/proxies/expired.mp4', 'ready', 7, '2026-01-01', '2026-01-01', '2026-01-01'),
    ('inflight-cache', 'project-a', 'asset-a', 'storage/cache/proxies/inflight.mp4', 'ready', 9, '2026-01-01', '2026-01-01', '2026-01-01')`).run();
  temporaryFile('cache/proxies/failed.mp4', '12345');
  temporaryFile('cache/proxies/expired.mp4', '1234567');
  temporaryFile('cache/proxies/inflight.mp4', '123456789');
  db.prepare("INSERT INTO batch_proxy_requests VALUES ('request-inflight', 'inflight-cache', 'pending')").run();
  db.prepare("INSERT INTO batch_tasks VALUES ('task-inflight', 'project-a', 'proxy_generate', 'proxy_request', 'request-inflight', 'running')").run();
  const shared = readyFile('shared-artifact', 'project-a', 'shared');
  registerInheritedScope(db, { resourceType: 'image', resourceId: 'shared-artifact-2', ownerUserId: 'admin', parent: { resourceType: 'project', resourceId: 'project-a' } });
  db.prepare(`INSERT INTO team_file_references (fileId, resourceType, resourceId, role, pinKind, createdAt)
    VALUES (?, 'image', 'shared-artifact-2', 'output', 'entity', '2026-01-01')`).run(shared.id);
  softDeleteResource(db, admin, { resourceType: 'image', resourceId: 'shared-artifact' });
  softDeleteResource(db, admin, { resourceType: 'image', resourceId: 'shared-artifact-2' });
  const pinned = readyFile('pinned-artifact', 'project-a', 'pinned');
  softDeleteResource(db, admin, { resourceType: 'image', resourceId: 'pinned-artifact' });
  createBackupPin(db, admin, { releaseId: 'release-1', configVersion: 'config-1', fileIds: [pinned.id] });
  readyFile('inflight-artifact', 'project-a', 'active');
  softDeleteResource(db, admin, { resourceType: 'image', resourceId: 'inflight-artifact' });
  db.prepare("INSERT INTO execution_operations VALUES ('operation-active', 'image', 'inflight-artifact', 'accepted')").run();
  const history = readyFile('historical-artifact', 'project-history', 'history');
  registerInheritedScope(db, { resourceType: 'history', resourceId: 'history-1', parent: { resourceType: 'project', resourceId: 'project-history' } });
  db.prepare(`INSERT INTO team_file_references (fileId, resourceType, resourceId, role, pinKind, createdAt)
    VALUES (?, 'history', 'history-1', 'output', 'entity', '2026-01-01')`).run(history.id);
  softDeleteResource(db, admin, { resourceType: 'image', resourceId: 'historical-artifact' });

  const { createCleanupPreview } = await import('../lib/team-service/maintenance/cleanup.ts');
  const first = createCleanupPreview({
    db, storageRoot, backupRoot, protectedDataRoots: [dataRoot, oldRoot],
    now: () => new Date('2026-11-06T00:00:00.000Z'),
  });
  const category = (kind: string) => first.categories.find((item) => item.kind === kind);
  assert.equal(category('failed_task_temporary')?.cleanableCount, 2, JSON.stringify(first));
  assert.equal(category('failed_task_temporary')?.estimatedBytes, 15);
  assert.equal(category('expired_cache')?.cleanableCount, 1);
  assert.equal(category('expired_cache')?.estimatedBytes, 7);
  assert.equal(category('recycle_bin')?.cleanableCount, 1, JSON.stringify(first));
  assert.equal(category('recycle_bin')?.estimatedBytes, 6, '组内共享文件只计一次');
  assert.ok(category('recycle_bin')?.protected.some((item) => item.reasonCode === 'backup_pin'));
  assert.ok(category('recycle_bin')?.protected.some((item) => item.reasonCode === 'inflight_operation'));
  assert.ok(category('recycle_bin')?.protected.some((item) => item.reasonCode === 'valid_reference'));
  assert.ok(category('expired_cache')?.protected.some((item) => item.reasonCode === 'inflight_operation'));
  assert.equal(first.totals.cleanableCount, 4);
  assert.equal(first.totals.estimatedBytes, 28);
  assert.ok(first.protectedSummary.some((item) => item.kind === 'backup_roots'));
  assert.ok(first.protectedSummary.some((item) => item.kind === 'retained_data_roots'));
  assert.ok(first.protectedSummary.some((item) => item.kind === 'project_assets'));
  assert.ok(first.protectedSummary.some((item) => item.kind === 'diagnostics_and_evidence'));
  assert.ok(!JSON.stringify(first).includes(dataRoot), '浏览器预览不泄露任意本地路径');
  const crossShared = readyFile('cross-shared-artifact', 'project-a', 'shared');
  const crossSharedSecond = readyFile('cross-shared-second', 'project-a', 'shared');
  db.prepare("UPDATE team_file_references SET fileId = ? WHERE fileId = ?").run(crossShared.id, crossSharedSecond.id);
  db.prepare('DELETE FROM team_files WHERE id = ?').run(crossSharedSecond.id);
  softDeleteResource(db, admin, { resourceType: 'image', resourceId: 'cross-shared-artifact' });
  softDeleteResource(db, admin, { resourceType: 'image', resourceId: 'cross-shared-second' });
  const sharedProtection = createCleanupPreview({ db, storageRoot, backupRoot, protectedDataRoots: [dataRoot, oldRoot] });
  assert.ok(sharedProtection.categories.find((item) => item.kind === 'recycle_bin')?.cleanableCount === 2, '跨已删除根共享文件合并为一个组');
  assert.equal(sharedProtection.totals.estimatedBytes, 34, '跨根共享物理文件不可重复计数');
  console.log('cleanup slice 1 preview categories, protection and shared file accounting passed');

  // Slice 2：执行前重新核验，部分失败不会中断其他候选，重试只报告实际释放。
  const { executeCleanupPreview, CleanupPreviewStore } = await import('../lib/team-service/maintenance/cleanup.ts');
  previewStore = new CleanupPreviewStore(backupRoot);
  previewStore.bind(first.id, 'admin');
  const sharedPath = path.join(storageRoot, ...shared.relativePath.split('/'));
  let injectedReference = false;
  let injectedFailure = false;
  const execution = executeCleanupPreview({
    db, previewId: first.id, storageRoot, backupRoot, protectedDataRoots: [dataRoot, oldRoot],
    unlink(absolutePath) {
      if (!injectedReference && absolutePath.endsWith('expired.mp4')) {
        injectedReference = true;
        db.prepare("UPDATE team_file_references SET releasedAt = NULL WHERE fileId = ? AND resourceId = 'shared-artifact-2'").run(shared.id);
      }
      if (!injectedFailure && absolutePath.endsWith('failed.mp4')) {
        injectedFailure = true;
        throw new Error('simulated file lock');
      }
      fs.unlinkSync(absolutePath);
    },
  });
  assert.equal(execution.deletedCount, 2, JSON.stringify(execution));
  assert.equal(execution.freedBytes, 17);
  assert.equal(execution.skipped.length, 1);
  assert.equal(execution.skipped[0].reasonCode, 'valid_reference');
  assert.equal(execution.failures.length, 1);
  assert.equal(execution.failures[0].id, 'cache:failed-cache');
  assert.equal(fs.existsSync(sharedPath), true, '预览后新增引用必须阻止删除');
  assert.equal(fs.existsSync(path.join(storageRoot, 'cache', 'proxies', 'failed.mp4')), true);
  assert.equal(fs.existsSync(path.join(storageRoot, 'team-staging', 'failed-upload', 'parts', '1.part')), false);
  assert.equal(fs.existsSync(path.join(storageRoot, 'formal-original.media')), true);
  assert.equal(fs.existsSync(path.join(backupRoot, 'manual-backup-evidence')), true);
  assert.equal(fs.existsSync(path.join(oldRoot, 'original.media')), true);
  assert.equal(fs.existsSync(path.join(storageRoot, 'execution-journal', '000001.jsonl')), true);
  db.prepare("UPDATE team_file_references SET releasedAt = '2026-11-06' WHERE fileId = ? AND resourceId = 'shared-artifact-2'").run(shared.id);
  const retried = executeCleanupPreview({
    db, previewId: first.id, storageRoot, backupRoot, protectedDataRoots: [dataRoot, oldRoot],
    unlink: fs.unlinkSync,
  });
  assert.equal(retried.deletedCount, 2, JSON.stringify(retried));
  assert.equal(retried.freedBytes, 11);
  assert.equal(retried.skipped.length, 0);
  assert.equal(retried.failures.length, 0);
  assert.equal(fs.existsSync(sharedPath), false);
  assert.equal(fs.existsSync(path.join(storageRoot, 'cache', 'proxies', 'failed.mp4')), false);
  const repeated = executeCleanupPreview({ db, previewId: first.id, storageRoot, backupRoot, protectedDataRoots: [dataRoot, oldRoot] });
  assert.equal(repeated.deletedCount, 0);
  assert.equal(repeated.freedBytes, 0);
  assert.equal(repeated.skipped.length, 0);
  assert.equal(repeated.failures.length, 0);
  console.log('cleanup slice 2 revalidation, partial failure, retry and idempotent results passed');
  upload('replacement-upload', 'failed');
  temporaryFile('team-staging/replacement-upload/parts/1.part', '1234');
  const replacementPreview = createCleanupPreview({ db, storageRoot, backupRoot, protectedDataRoots: [dataRoot, oldRoot] });
  replacementStore = new CleanupPreviewStore(backupRoot);
  replacementStore.bind(replacementPreview.id, 'admin');
  const replacementCandidate = replacementStore.candidates(replacementPreview.id).find((candidate) => candidate.sourceType === 'failed_upload')!;
  const replacementPath = path.join(storageRoot, ...replacementCandidate.relativePaths[0].split('/'));
  fs.mkdirSync(path.dirname(replacementPath), { recursive: true });
  fs.writeFileSync(replacementPath, 'replaced-not-the-same-file');
  const rejectedReplacement = executeCleanupPreview({ db, previewId: replacementPreview.id, storageRoot, backupRoot, protectedDataRoots: [dataRoot, oldRoot], store: replacementStore });
  assert.equal(rejectedReplacement.deletedCount, 0);
  assert.equal(rejectedReplacement.failures[0]?.reasonCode, 'path_changed');
  assert.equal(fs.existsSync(replacementPath), true, '同名替换文件不得被旧预览删除');
  const foreignRoot = path.join(fixture, 'foreign-storage');
  fs.mkdirSync(foreignRoot, { recursive: true });
  assert.throws(() => executeCleanupPreview({ db, previewId: replacementPreview.id, storageRoot: foreignRoot, backupRoot, protectedDataRoots: [dataRoot, oldRoot], store: replacementStore }), /其他数据根/);
  const { writeTeamRestoreHold } = await import('../lib/team-service/maintenance/hold.ts');
  upload('restore-hold-upload', 'failed');
  temporaryFile('team-staging/restore-hold-upload/parts/1.part', 'keep');
  const heldPreview = createCleanupPreview({ db, storageRoot, backupRoot, protectedDataRoots: [dataRoot, oldRoot] });
  const heldStore = new CleanupPreviewStore(backupRoot);
  try {
    heldStore.bind(heldPreview.id, 'admin');
    await writeTeamRestoreHold(oldRoot, 'backup-isolated', new Date('2026-11-01'));
    const heldResult = executeCleanupPreview({ db, previewId: heldPreview.id, storageRoot, backupRoot, protectedDataRoots: [dataRoot, oldRoot], store: heldStore });
    assert.equal(heldResult.deletedCount, 0);
    assert.ok(heldResult.skipped.some((item) => item.reasonCode === 'restore_reconciliation'));
    assert.equal(fs.existsSync(path.join(storageRoot, 'team-staging', 'restore-hold-upload', 'parts', '1.part')), true);
  } finally { heldStore.close(); }
  console.log('cleanup replacement rejection, cross-root rejection and restore-hold protection passed');
} finally {
  replacementStore?.close();
  previewStore?.close();
  db.close();
  fs.rmSync(fixture, { recursive: true, force: true });
}
