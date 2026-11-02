import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-team-list-filter-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
Object.assign(process.env, {
  CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
  CREATIVE_STUDIO_PORT: '3300',
  CREATIVE_STUDIO_DEPLOYMENT_ID: 'deployment-list-filter',
  CREATIVE_STUDIO_TRUSTED_ORIGIN: 'https://studio.example.test',
});
const { getDb, closeDb } = await import('../lib/db.ts');
const { ensureServerDeploymentMarker } = await import('../lib/team-service/config.ts');
ensureServerDeploymentMarker({
  mode: 'server', dataRoot: root, hostname: '127.0.0.1', port: 3300,
  deploymentId: 'deployment-list-filter', trustedOrigin: 'https://studio.example.test',
});
const db = getDb();
const { TEAM_SERVICE_MIGRATIONS } = await import('../lib/team-service/schema.ts');
const { BATCH_SCHEMA_MIGRATIONS } = await import('../lib/batch-production/schema.ts');
const { CREATIVE_CANVAS_MIGRATIONS } = await import('../lib/creative-canvas/schema.ts');
const { SCRIPT_STUDIO_MIGRATIONS } = await import('../lib/script-studio/schema.ts');
for (const migration of [
  ...TEAM_SERVICE_MIGRATIONS,
  ...BATCH_SCHEMA_MIGRATIONS,
  ...CREATIVE_CANVAS_MIGRATIONS,
  ...SCRIPT_STUDIO_MIGRATIONS,
]) db.exec(migration.sql);
db.exec(`
  INSERT INTO team_users (id, employeeId, displayName, role, status, passwordHash, mustChangePassword, sessionVersion, createdAt, updatedAt)
  VALUES ('user-a', '0001', '甲', 'employee', 'active', 'x', 0, 1, '2026-11-02', '2026-11-02');
  INSERT OR IGNORE INTO providers (id, name, baseUrl) VALUES ('provider', '测试', 'http://127.0.0.1');
  INSERT INTO projects (id, name, providerId, model, prompt) VALUES ('project-a', '项目', 'provider', 'model', '');
  INSERT INTO creative_canvases (id, name, graphRevision, graphJson, viewportJson, createdAt, updatedAt)
  VALUES ('canvas-a', '画布', 0, '{"nodes":[],"edges":[]}', '{}', '2026-11-02', '2026-11-02');
  INSERT INTO batch_productions (id, projectId, name, status, progressJson, createdAt, updatedAt)
  VALUES ('batch-a', 'project-a', '批次', 'draft', '{}', '2026-11-02', '2026-11-02');
  INSERT INTO batch_scripts (id, projectId, sourceKind, sourceId, title, bodyText, sourceVersion, createdAt, updatedAt)
  VALUES ('batch-script-a', 'project-a', 'script_draft', 'manual:a', '批量脚本', '正文', '1', '2026-11-02', '2026-11-02');
  INSERT INTO project_scripts (id, projectId, createdAt, updatedAt)
  VALUES ('project-script-a', 'project-a', '2026-11-02', '2026-11-02');
`);
const {
  registerRootScope, registerInheritedScope, createTeamAccessContext,
} = await import('../lib/team-service/resource-scopes.ts');
const { softDeleteResource } = await import('../lib/team-service/lifecycle/index.ts');
const { runWithAccessContext } = await import('../lib/media-core/access-context.ts');
const { listCanvases } = await import('../lib/creative-canvas/repository.ts');
const { listProjectBatchProductions } = await import('../lib/batch-production/versions.ts');
const { listProjectScripts: listBatchScripts } = await import('../lib/batch-production/scripts.ts');
const { listProjectScripts: listStudioScripts } = await import('../lib/script-studio/scripts.ts');

const actor = {
  kind: 'user' as const, userId: 'user-a', employeeId: '0001', displayName: '甲', role: 'employee' as const,
  sessionId: 'session', sessionVersion: 1, mustChangePassword: false,
  absoluteExpiresAt: '2099-01-01T00:00:00.000Z',
};
const context = createTeamAccessContext({ db, principal: actor });

try {
  registerRootScope(db, { resourceType: 'project', resourceId: 'project-a', ownerUserId: 'user-a' });
  registerRootScope(db, { resourceType: 'canvas', resourceId: 'canvas-a', ownerUserId: 'user-a' });
  for (const [resourceType, resourceId] of [
    ['batch', 'batch-a'], ['batch_script', 'batch-script-a'], ['project_script', 'project-script-a'],
  ] as const) {
    registerInheritedScope(db, { resourceType, resourceId, parent: { resourceType: 'project', resourceId: 'project-a' } });
  }
  for (const ref of [
    { resourceType: 'canvas', resourceId: 'canvas-a' },
    { resourceType: 'batch', resourceId: 'batch-a' },
    { resourceType: 'batch_script', resourceId: 'batch-script-a' },
    { resourceType: 'project_script', resourceId: 'project-script-a' },
  ]) softDeleteResource(db, actor, ref);

  await runWithAccessContext(context, async () => {
    assert.deepEqual(listCanvases(db), []);
    assert.deepEqual(listProjectBatchProductions(db, 'project-a'), []);
    assert.deepEqual(listBatchScripts(db, 'project-a'), []);
    assert.deepEqual(listStudioScripts(db, 'project-a').scripts, []);
  });
  assert.ok(db.prepare("SELECT 1 FROM creative_canvases WHERE id = 'canvas-a'").get());
  assert.ok(db.prepare("SELECT 1 FROM batch_productions WHERE id = 'batch-a'").get());
  assert.ok(db.prepare("SELECT 1 FROM batch_scripts WHERE id = 'batch-script-a'").get());
  assert.ok(db.prepare("SELECT 1 FROM project_scripts WHERE id = 'project-script-a'").get());
  console.log('PASS: deleted canvas, batches and script resources stay recoverable but leave normal lists');
} finally {
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
}
