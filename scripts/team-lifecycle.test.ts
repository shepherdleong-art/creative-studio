import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

const db = new Database(':memory:');
db.pragma('foreign_keys = ON');
const { TEAM_SERVICE_MIGRATIONS } = await import('../lib/team-service/schema.ts');
for (const migration of TEAM_SERVICE_MIGRATIONS) db.exec(migration.sql);
db.exec(`
  CREATE TABLE projects (id TEXT PRIMARY KEY);
  CREATE TABLE jobs (id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE);
  INSERT INTO team_users (id, employeeId, displayName, role, status, passwordHash, mustChangePassword, sessionVersion, createdAt, updatedAt)
  VALUES
    ('user-a', '0001', '甲', 'employee', 'active', 'x', 0, 1, '2026-11-02', '2026-11-02'),
    ('admin', '0000', '管理员', 'admin', 'active', 'x', 0, 1, '2026-11-02', '2026-11-02');
  INSERT INTO projects VALUES ('project-a');
  INSERT INTO jobs VALUES ('job-a', 'project-a');
`);

const {
  registerRootScope,
  registerInheritedScope,
  requireResourceAccess,
} = await import('../lib/team-service/resource-scopes.ts');
const { registerTaskPrincipal } = await import('../lib/team-service/task-principals.ts');
const {
  softDeleteResource,
  restoreResource,
  isAutomaticDeliverySuppressed,
} = await import('../lib/team-service/lifecycle/index.ts');
const { createAcceptedTaskAccessContext } = await import('../lib/team-service/accepted-access.ts');

const userA = {
  kind: 'user' as const,
  userId: 'user-a', employeeId: '0001', displayName: '甲', role: 'employee' as const,
  sessionId: 'session-a', sessionVersion: 1, mustChangePassword: false,
  absoluteExpiresAt: '2099-01-01T00:00:00.000Z',
};

try {
  registerRootScope(db, { resourceType: 'project', resourceId: 'project-a', ownerUserId: 'user-a' });
  registerInheritedScope(db, {
    resourceType: 'job', resourceId: 'job-a', parent: { resourceType: 'project', resourceId: 'project-a' },
  });
  registerTaskPrincipal(db, {
    module: 'image', taskId: 'job-a', actorUserId: 'user-a',
    scope: { resourceType: 'project', resourceId: 'project-a' }, creationSnapshot: { frozen: true },
  });

  const deleted = softDeleteResource(db, userA, {
    resourceType: 'project', resourceId: 'project-a',
  }, () => new Date('2026-11-02T08:00:00.000Z'));
  assert.equal(deleted.deletedAt, '2026-11-02T08:00:00.000Z');
  assert.ok(db.prepare('SELECT 1 FROM projects WHERE id = ?').get('project-a'), '软删除不得删除业务行');
  assert.ok(db.prepare('SELECT 1 FROM jobs WHERE id = ?').get('job-a'), '软删除不得删除已接受任务');
  assert.ok(db.prepare("SELECT 1 FROM team_resource_scopes WHERE resourceType = 'job' AND resourceId = 'job-a' AND deletedAt IS NOT NULL").get());
  assert.throws(() => requireResourceAccess(db, userA, 'project', 'project-a', 'write'), /不存在或不可用/);
  assert.throws(() => registerInheritedScope(db, {
    resourceType: 'job', resourceId: 'job-new', parent: { resourceType: 'project', resourceId: 'project-a' },
  }), /父资源不可用/);
  assert.equal(isAutomaticDeliverySuppressed(db, 'project-a'), true);

  const accepted = createAcceptedTaskAccessContext(db, 'image', 'job-a');
  accepted.assertAccess('project', 'project-a', 'read');
  accepted.assertAccess('job', 'job-a', 'read');

  const restored = restoreResource(db, userA, { resourceType: 'project', resourceId: 'project-a' });
  assert.equal(restored.restored, true);
  assert.equal(isAutomaticDeliverySuppressed(db, 'project-a'), false);
  assert.equal(requireResourceAccess(db, userA, 'project', 'project-a', 'write').resourceId, 'project-a');

  console.log('PASS: server soft delete, accepted-task reads, automatic-delivery suppression and restore');
} finally {
  db.close();
}
