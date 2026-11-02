import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

const db = new Database(':memory:');
db.pragma('foreign_keys = ON');

const { TEAM_SERVICE_MIGRATIONS } = await import('../lib/team-service/schema.ts');
for (const migration of TEAM_SERVICE_MIGRATIONS) db.exec(migration.sql);
db.exec(`
  CREATE TABLE projects (id TEXT PRIMARY KEY);
  CREATE TABLE creative_canvases (id TEXT PRIMARY KEY);
  CREATE TABLE image_assets (id TEXT PRIMARY KEY, projectId TEXT);
  CREATE TABLE jobs (id TEXT PRIMARY KEY, projectId TEXT NOT NULL);
  CREATE TABLE video_prompt_templates (id TEXT PRIMARY KEY);
  INSERT INTO team_users (id, employeeId, displayName, role, status, passwordHash, mustChangePassword, sessionVersion, createdAt, updatedAt)
  VALUES
    ('user-a', '0001', '甲', 'employee', 'active', 'x', 0, 1, '2026-11-02', '2026-11-02'),
    ('user-b', '0002', '乙', 'employee', 'active', 'x', 0, 1, '2026-11-02', '2026-11-02'),
    ('admin', '0000', '管理员', 'admin', 'active', 'x', 0, 1, '2026-11-02', '2026-11-02');
`);

const {
  registerRootScope,
  registerInheritedScope,
  requireResourceAccess,
  assertScopeConsistency,
  createTeamAccessContext,
  ResourceAccessError,
} = await import('../lib/team-service/resource-scopes.ts');
const { registerTaskPrincipal, getTaskPrincipal } = await import('../lib/team-service/task-principals.ts');
const { runWithAccessContext, requireAccessContext } = await import('../lib/media-core/access-context.ts');

function principal(userId: string, role: 'employee' | 'admin' = 'employee') {
  return {
    kind: 'user' as const,
    userId,
    employeeId: userId,
    displayName: userId,
    role,
    sessionId: `session-${userId}`,
    sessionVersion: 1,
    mustChangePassword: false,
    absoluteExpiresAt: '2026-12-02T00:00:00.000Z',
  };
}

try {
  for (const [type, id] of [['project', 'project-a'], ['canvas', 'canvas-a'], ['image', 'image-a'], ['video_prompt_template', 'template-a']] as const) {
    if (type === 'project') db.prepare('INSERT INTO projects VALUES (?)').run(id);
    if (type === 'canvas') db.prepare('INSERT INTO creative_canvases VALUES (?)').run(id);
    if (type === 'image') db.prepare('INSERT INTO image_assets VALUES (?, NULL)').run(id);
    if (type === 'video_prompt_template') db.prepare('INSERT INTO video_prompt_templates VALUES (?)').run(id);
    registerRootScope(db, { resourceType: type, resourceId: id, ownerUserId: 'user-a', visibility: 'private' });
  }

  db.prepare("INSERT INTO jobs VALUES ('job-a', 'project-a')").run();
  registerInheritedScope(db, {
    resourceType: 'job', resourceId: 'job-a',
    parent: { resourceType: 'project', resourceId: 'project-a' },
  });
  registerTaskPrincipal(db, {
    module: 'image', taskId: 'job-a', actorUserId: 'admin',
    scope: { resourceType: 'project', resourceId: 'project-a' },
    creationSnapshot: { ownerUserId: 'user-a', input: 'frozen' },
  });

  assert.equal(requireResourceAccess(db, principal('user-a'), 'project', 'project-a', 'write').ownerUserId, 'user-a');
  assert.throws(
    () => requireResourceAccess(db, principal('user-b'), 'project', 'project-a', 'read'),
    (error) => error instanceof ResourceAccessError && error.code === 'resource_forbidden',
  );
  assert.equal(requireResourceAccess(db, principal('admin', 'admin'), 'project', 'project-a', 'write').ownerUserId, 'user-a');
  assert.equal(getTaskPrincipal(db, 'image', 'job-a')?.actorUserId, 'admin');
  assert.equal(getTaskPrincipal(db, 'image', 'job-a')?.scope.resourceId, 'project-a');

  db.prepare("INSERT INTO video_prompt_templates VALUES ('template-public')").run();
  registerRootScope(db, { resourceType: 'video_prompt_template', resourceId: 'template-public', ownerUserId: 'admin', visibility: 'public' });
  assert.equal(requireResourceAccess(db, principal('user-b'), 'video_prompt_template', 'template-public', 'read').visibility, 'public');
  assert.throws(
    () => requireResourceAccess(db, principal('user-b'), 'video_prompt_template', 'template-public', 'write'),
    (error) => error instanceof ResourceAccessError && error.code === 'resource_forbidden',
  );

  assert.throws(
    () => requireResourceAccess(db, principal('user-a'), 'project', 'missing', 'read'),
    (error) => error instanceof ResourceAccessError && error.code === 'resource_not_found',
  );
  db.prepare("UPDATE team_resource_scopes SET deletedAt = '2026-11-02', deletedBy = 'admin' WHERE resourceType = 'project' AND resourceId = 'project-a'").run();
  assert.throws(
    () => requireResourceAccess(db, principal('user-a'), 'project', 'project-a', 'read'),
    (error) => error instanceof ResourceAccessError && error.code === 'resource_not_found',
  );
  db.prepare("UPDATE team_resource_scopes SET deletedAt = NULL, deletedBy = NULL WHERE resourceType = 'project' AND resourceId = 'project-a'").run();

  db.prepare("INSERT INTO projects VALUES ('project-b')").run();
  registerRootScope(db, { resourceType: 'project', resourceId: 'project-b', ownerUserId: 'user-b', visibility: 'private' });
  db.prepare("INSERT INTO jobs VALUES ('job-bad-parent', 'project-b')").run();
  assert.throws(
    () => registerInheritedScope(db, {
      resourceType: 'job', resourceId: 'job-bad-parent',
      parent: { resourceType: 'project', resourceId: 'project-a' },
    }),
    (error) => error instanceof ResourceAccessError && error.code === 'scope_inconsistent',
  );
  db.prepare(`
    INSERT INTO team_resource_scopes (
      resourceType, resourceId, ownerUserId, visibility,
      parentType, parentId, rootType, rootId, createdAt, updatedAt
    ) VALUES ('job', 'job-bad-parent', 'user-b', 'private', 'project', 'project-a', 'project', 'project-a', '2026-11-02', '2026-11-02')
  `).run();
  assert.throws(
    () => assertScopeConsistency(db, 'job', 'job-bad-parent'),
    (error) => error instanceof ResourceAccessError && error.code === 'scope_inconsistent',
  );
  assert.throws(
    () => requireResourceAccess(db, principal('user-a'), 'job', 'job-bad-parent', 'read'),
    (error) => error instanceof ResourceAccessError && error.code === 'scope_inconsistent',
  );

  const previousMode = process.env.CREATIVE_STUDIO_DEPLOYMENT_MODE;
  process.env.CREATIVE_STUDIO_DEPLOYMENT_MODE = 'server';
  assert.throws(() => requireAccessContext(), /访问上下文/);
  const context = createTeamAccessContext({ db, principal: principal('user-a') });
  await runWithAccessContext(context, async () => {
    assert.equal(requireAccessContext().actor.userId, 'user-a');
    requireAccessContext().assertAccess('project', 'project-a', 'write');
  });
  if (previousMode === undefined) delete process.env.CREATIVE_STUDIO_DEPLOYMENT_MODE;
  else process.env.CREATIVE_STUDIO_DEPLOYMENT_MODE = previousMode;

  console.log('team resource scope tests passed');
} finally {
  db.close();
}
