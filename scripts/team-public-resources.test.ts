import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';

register('./typescript-extension-loader.mjs', import.meta.url);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-team-public-resources-'));
const previousEnv = { ...process.env };
Object.assign(process.env, {
  CREATIVE_STUDIO_DATA_ROOT: root,
  CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
  CREATIVE_STUDIO_PORT: '3300',
  CREATIVE_STUDIO_DEPLOYMENT_ID: 'deployment-public-resources',
  CREATIVE_STUDIO_TRUSTED_ORIGIN: 'https://studio.example.test',
});
const { ensureServerDeploymentMarker } = await import('../lib/team-service/config.ts');
const { getDb, closeDb } = await import('../lib/db.ts');
const { checkTeamServiceReadiness } = await import('../lib/team-service/readiness.ts');
const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
const { createTeamAccessContext, requireResourceAccess } = await import('../lib/team-service/resource-scopes.ts');
const { runWithAccessContext } = await import('../lib/media-core/access-context.ts');
const { importFinalEditBgmFiles } = await import('../lib/final-edit/bgm-import.ts');
const { readBatchBgmPool } = await import('../lib/batch-production/bgm.ts');
const { publishTeamResource } = await import('../lib/team-service/files/publication.ts');
const { ensureScriptStudioSchemaReady } = await import('../lib/script-studio/schema.ts');
const { getOrCreateCatalog, createCatalogRevision, getCatalogCurrentRevisionId, getCatalogRevision } = await import('../lib/script-studio/catalogs.ts');
const { getOrCreateViralTemplateLibrary } = await import('../lib/script-studio/viral-templates.ts');

ensureServerDeploymentMarker({
  mode: 'server', dataRoot: root, hostname: '127.0.0.1', port: 3300,
  deploymentId: 'deployment-public-resources', trustedOrigin: 'https://studio.example.test',
});
const db = getDb();
assert.equal((await checkTeamServiceReadiness({ db, ...schemaUpgradeRuntimePaths(root) })).available, true);
assert.notEqual((await ensureScriptStudioSchemaReady({ db, backupRoot: path.join(root, 'script-backups') })).state, 'compatibility_only');
const insertUser = db.prepare(`INSERT INTO team_users (
  id, employeeId, displayName, role, status, passwordHash, mustChangePassword, sessionVersion, createdAt, updatedAt
) VALUES (?, ?, ?, ?, 'active', 'test', 0, 1, '2026-11-02', '2026-11-02')`);
insertUser.run('admin', '0000', '管理员', 'admin');
insertUser.run('user-a', '0001', '甲', 'employee');
insertUser.run('user-b', '0002', '乙', 'employee');
const principal = (userId: string, role: 'employee' | 'admin' = 'employee') => ({
  kind: 'user' as const, userId, employeeId: userId, displayName: userId, role,
  sessionId: `session-${userId}`, sessionVersion: 1, mustChangePassword: false,
  absoluteExpiresAt: '2099-01-01T00:00:00.000Z',
});
const admin = principal('admin', 'admin');
const userA = principal('user-a');
const userB = principal('user-b');
const contextA = createTeamAccessContext({ db, principal: userA });
const contextB = createTeamAccessContext({ db, principal: userB });
const storageRoot = path.join(root, 'storage');
fs.mkdirSync(storageRoot, { recursive: true });
const upload = path.join(root, 'same.mp3');
fs.writeFileSync(upload, Buffer.from('same audio bytes'));
const deps = { db, storageRoot, probeDurationSec: async () => 2 };

try {
  const importedA = await runWithAccessContext(contextA, () => importFinalEditBgmFiles(deps, [
    { filename: 'same.mp3', mimeType: 'audio/mpeg', temporaryPath: upload, size: 16 },
  ]));
  const trackA = importedA.imported[0];
  assert.ok(trackA);
  assert.deepEqual(runWithAccessContext(contextB, () => readBatchBgmPool(db)), []);

  const importedB = await runWithAccessContext(contextB, () => importFinalEditBgmFiles(deps, [
    { filename: 'same.mp3', mimeType: 'audio/mpeg', temporaryPath: upload, size: 16 },
  ]));
  const trackB = importedB.imported[0];
  assert.ok(trackB);
  assert.notEqual(trackA.id, trackB.id);
  assert.equal(runWithAccessContext(contextA, () => readBatchBgmPool(db)).length, 1);
  assert.equal(runWithAccessContext(contextB, () => readBatchBgmPool(db)).length, 1);
  assert.throws(() => contextA.authorizeFileRead!(path.join(storageRoot, trackB.relativePath)), /不存在或不可用/);
  assert.ok(contextB.authorizeFileRead!(path.join(storageRoot, trackB.relativePath)).fileId);

  publishTeamResource(db, admin, { resourceType: 'bgm', resourceId: trackB.id });
  assert.ok(contextA.authorizeFileRead!(path.join(storageRoot, trackB.relativePath)).fileId);
  assert.equal(runWithAccessContext(contextA, () => readBatchBgmPool(db)).length, 2);
  assert.throws(() => requireResourceAccess(db, userA, 'bgm', trackB.id, 'write'), /无权/);
  assert.throws(() => publishTeamResource(db, userA, { resourceType: 'bgm', resourceId: trackA.id }), /管理员/);

  const catalogA = runWithAccessContext(contextA, () => getOrCreateCatalog(db, 'template'));
  const catalogB = runWithAccessContext(contextB, () => getOrCreateCatalog(db, 'template'));
  assert.notEqual(catalogA.id, catalogB.id);
  const revisionA = runWithAccessContext(contextA, () => createCatalogRevision(db, {
    catalogId: catalogA.id, sourceFilename: 'same.xlsx', sourceSha256: 'same-hash', importReport: {},
  })).revisionId;
  const revisionB = runWithAccessContext(contextB, () => createCatalogRevision(db, {
    catalogId: catalogB.id, sourceFilename: 'same.xlsx', sourceSha256: 'same-hash', importReport: {},
  })).revisionId;
  assert.notEqual(revisionA, revisionB);
  assert.equal(runWithAccessContext(contextA, () => getCatalogCurrentRevisionId(db, 'template')), revisionA);
  assert.equal(runWithAccessContext(contextB, () => getCatalogCurrentRevisionId(db, 'template')), revisionB);
  assert.throws(() => runWithAccessContext(contextA, () => getCatalogRevision(db, revisionB)), /无权/);
  publishTeamResource(db, admin, { resourceType: 'script_catalog', resourceId: catalogB.id });
  publishTeamResource(db, admin, { resourceType: 'script_catalog_revision', resourceId: revisionB });
  assert.equal(runWithAccessContext(contextA, () => getCatalogRevision(db, revisionB))?.id, revisionB);
  assert.throws(() => requireResourceAccess(db, userA, 'script_catalog_revision', revisionB, 'write'), /无权/);

  const viralA = runWithAccessContext(contextA, () => getOrCreateViralTemplateLibrary(db));
  const viralB = runWithAccessContext(contextB, () => getOrCreateViralTemplateLibrary(db));
  assert.notEqual(viralA.id, viralB.id);
  console.log('PASS: same-hash BGM/catalog records stay independent; public revisions are read-only');
} finally {
  closeDb();
  process.env = previousEnv;
  fs.rmSync(root, { recursive: true, force: true });
}
