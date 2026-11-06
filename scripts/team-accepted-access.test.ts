import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-accepted-access-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
process.env.CREATIVE_STUDIO_DEPLOYMENT_MODE = 'server';
process.env.CREATIVE_STUDIO_PORT = '3300';
process.env.CREATIVE_STUDIO_DEPLOYMENT_ID = 'deployment-accepted';
process.env.CREATIVE_STUDIO_TRUSTED_ORIGIN = 'https://studio.example.test';

const { TEAM_SERVICE_MIGRATIONS } = await import('../lib/team-service/schema.ts');
const { registerRootScope } = await import('../lib/team-service/resource-scopes.ts');
const { createAcceptedTaskAccessContext } = await import('../lib/team-service/accepted-access.ts');
const { getTaskPrincipal, registerTaskPrincipal } = await import('../lib/team-service/task-principals.ts');

fs.mkdirSync(path.join(root, 'data'), { recursive: true });
const db = new Database(path.join(root, 'data', 'workbench.db'));
db.pragma('foreign_keys = ON');
for (const migration of TEAM_SERVICE_MIGRATIONS) db.exec(migration.sql);

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, baseUrl TEXT NOT NULL DEFAULT '',
      apiKeyEnv TEXT NOT NULL DEFAULT '', apiKey TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '', type TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1, defaultCostPerImage REAL
    );
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, providerId TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT '', prompt TEXT NOT NULL DEFAULT ''
    );
    INSERT INTO team_users (id, employeeId, displayName, role, status, passwordHash, mustChangePassword, sessionVersion, createdAt, updatedAt)
    VALUES ('user-a', '0001', '员工甲', 'employee', 'active', 'x', 0, 1, '2026-11-04', '2026-11-04'),
           ('user-b', '0002', '员工乙', 'employee', 'active', 'x', 0, 1, '2026-11-04', '2026-11-04');
    INSERT INTO providers (id, name, baseUrl) VALUES ('provider', '测试', 'http://127.0.0.1');
    INSERT INTO projects (id, name, providerId, model, prompt) VALUES
      ('project-a', '项目甲', 'provider', 'model', ''),
      ('project-b', '项目乙', 'provider', 'model', '');
  `);
  registerRootScope(db, { resourceType: 'project', resourceId: 'project-a', ownerUserId: 'user-a' });
  registerRootScope(db, { resourceType: 'project', resourceId: 'project-b', ownerUserId: 'user-b' });

  // 受理时是管理员：冻结角色生效，但访问范围仍限定在冻结 scope。
  registerTaskPrincipal(db, {
    module: 'image', taskId: 'task-admin', actorUserId: 'user-a',
    scope: { resourceType: 'project', resourceId: 'project-a' },
    roleAtAcceptance: 'admin',
  });
  const adminFrozen = createAcceptedTaskAccessContext(db, 'image', 'task-admin');
  assert.equal(adminFrozen.actor.role, 'admin', '受理角色来自快照');
  assert.doesNotThrow(() => adminFrozen.assertAccess('project', 'project-a', 'read'));
  assert.throws(
    () => adminFrozen.assertAccess('project', 'project-b', 'read'),
    /冻结的资源范围/,
    '历史 admin 不能读取冻结范围外的项目',
  );
  assert.throws(
    () => adminFrozen.registerRootScope({ resourceType: 'project', resourceId: 'project-b', ownerUserId: 'user-a' }),
    /根资源/,
  );

  // 旧记录没有受理角色证据：按最小 employee 处理，且显式标记待核查。
  db.prepare(`
    INSERT INTO team_task_principals (module, taskId, actorUserId, scopeType, scopeId, creationSnapshot, createdAt)
    VALUES ('image', 'task-legacy', 'user-a', 'project', 'project-a', '{}', '2026-11-04')
  `).run();
  const legacy = getTaskPrincipal(db, 'image', 'task-legacy');
  assert.equal(legacy?.roleAtAcceptance, null);
  assert.equal(legacy?.authorizationEvidence, 'missing');
  const legacyContext = createAcceptedTaskAccessContext(db, 'image', 'task-legacy');
  assert.equal(legacyContext.actor.role, 'employee');
  assert.doesNotThrow(() => legacyContext.assertAccess('project', 'project-a', 'read'));
  assert.throws(() => legacyContext.assertAccess('project', 'project-b', 'read'), /无权访问|冻结的资源范围/);

  // 停用/降权后，已受理任务仍可读取冻结范围内的软删除依赖并收取结果。
  db.prepare("UPDATE team_users SET status = 'disabled', role = 'employee' WHERE id = 'user-a'").run();
  db.prepare("UPDATE team_resource_scopes SET deletedAt = '2026-11-04', deletedBy = 'user-a' WHERE resourceType = 'project' AND resourceId = 'project-a'").run();
  const stillCollecting = createAcceptedTaskAccessContext(db, 'image', 'task-admin');
  assert.doesNotThrow(() => stillCollecting.assertAccess('project', 'project-a', 'write'));
  assert.throws(() => stillCollecting.assertAccess('project', 'project-b', 'read'), /冻结的资源范围/);

  // 任务身份不匹配时拒绝（模块/任务 id 都不是可推导的）。
  assert.throws(() => createAcceptedTaskAccessContext(db, 'image', 'task-does-not-exist'), /持久发起人/);
  assert.throws(() => createAcceptedTaskAccessContext(db, 'video', 'task-admin'), /持久发起人/);

  console.log('team accepted-access boundary tests passed');
} finally {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}
