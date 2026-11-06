import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-canvas-server-bootstrap-'));
const previousEnv = { ...process.env };
Object.assign(process.env, {
  CREATIVE_STUDIO_DATA_ROOT: root,
  CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
  CREATIVE_STUDIO_PORT: '3300',
  CREATIVE_STUDIO_DEPLOYMENT_ID: 'deployment-canvas-bootstrap',
  CREATIVE_STUDIO_TRUSTED_ORIGIN: 'https://studio.example.test',
  CREATIVE_STUDIO_INSTANCE_ID: 'canvas-bootstrap-owner',
  CREATIVE_STUDIO_CANVAS_ENABLE: '1',
  CREATIVE_STUDIO_CANVAS_TEST_ROOT: '1',
  CREATIVE_STUDIO_CANVAS_EXECUTOR: 'fixture',
});

const { ensureServerDeploymentMarker } = await import('../lib/team-service/config.ts');
const { getDb, closeDb } = await import('../lib/db.ts');
const { checkTeamServiceReadiness } = await import('../lib/team-service/readiness.ts');
const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
const { ensureCreativeCanvasSchemaReady } = await import('../lib/creative-canvas/schema.ts');
const { createTeamAccessContext } = await import('../lib/team-service/resource-scopes.ts');
const { runWithAccessContext } = await import('../lib/media-core/access-context.ts');
const { clearCanvasCapabilities, registerCanvasCapability } = await import('../lib/creative-canvas/capabilities.ts');
const { createCanvas, saveCanvasGraph } = await import('../lib/creative-canvas/repository.ts');
const { startCanvasRun } = await import('../lib/creative-canvas/runs.ts');
const { claimCanvasTasks, getCanvasTask } = await import('../lib/creative-canvas/tasks.ts');
const { createCanvasFixtureAdapter } = await import('../lib/creative-canvas/adapters/fixture.ts');
const { registerCanvasAdapterFactory } = await import('../lib/creative-canvas/adapters/index.ts');
const {
  startCanvasAfterReadiness,
  getCanvasSchedulerController,
  ensureCanvasSchedulerStarted,
  stopCanvasScheduler,
} = await import('../lib/creative-canvas/bootstrap.ts');
const {
  startTeamServiceRuntime,
  drainTeamRuntime,
  releaseTeamRuntimeOwner,
} = await import('../lib/team-service/runtime/index.ts');

ensureServerDeploymentMarker({
  mode: 'server', dataRoot: root, hostname: '127.0.0.1', port: 3300,
  deploymentId: 'deployment-canvas-bootstrap', trustedOrigin: 'https://studio.example.test',
});
const db = getDb();
assert.equal((await checkTeamServiceReadiness({ db, ...schemaUpgradeRuntimePaths(root) })).available, true);
assert.notEqual((await ensureCreativeCanvasSchemaReady({ db, backupRoot: path.join(root, 'canvas-backups') })).state, 'compatibility_only');
const now = new Date().toISOString();
db.prepare(`INSERT INTO team_users (
  id, employeeId, displayName, role, status, passwordHash, mustChangePassword, sessionVersion, createdAt, updatedAt
) VALUES ('owner-user', '0001', '发起人', 'employee', 'active', 'test', 0, 1, ?, ?)`).run(now, now);
const access = createTeamAccessContext({
  db,
  principal: {
    kind: 'user', userId: 'owner-user', employeeId: '0001', displayName: '发起人', role: 'employee',
    sessionId: 'owner-session', sessionVersion: 1, mustChangePassword: false,
    absoluteExpiresAt: '2099-01-01T00:00:00.000Z',
  },
});
clearCanvasCapabilities();
registerCanvasCapability({
  key: 'fixture-bootstrap-image', displayName: '启动测试', providerKind: 'external',
  providerIdentity: 'fixture-bootstrap', modelAlias: 'fixture-bootstrap', mediaKind: 'image',
  modes: ['text-to-image'], inputs: [], parameters: [], cancellation: false,
  evidence: 'candidate', evidenceNote: '仅隔离启动测试。',
});
const canvasId = runWithAccessContext(access, () => createCanvas(db, { name: 'owner 恢复' }).id);
runWithAccessContext(access, () => saveCanvasGraph({
  db, canvasId, expectedGraphRevision: 0,
  graph: {
    schemaVersion: 1,
    nodes: [{
      id: 'interrupted', kind: 'image-generation', position: { x: 0, y: 0 },
      data: {
        title: '中断任务', modelKey: 'fixture-bootstrap-image', generationMode: 'text-to-image',
        prompt: '不得自动重提', parameters: {}, references: [], referenceLabelCounter: 0,
      },
    }],
    edges: [],
  },
}));
const taskId = runWithAccessContext(access, () => startCanvasRun({
  db,
  request: { canvasId, mode: 'single', targetNodeId: 'interrupted', requestKey: 'owner-recovery' },
})).tasks[0]!.id;
runWithAccessContext(access, () => claimCanvasTasks({ db, workerId: 'dead-owner', limit: 1 }));
const adapter = createCanvasFixtureAdapter();
registerCanvasAdapterFactory('fixture', () => adapter);
const readPhase = () => runWithAccessContext(access, () => getCanvasTask(db, taskId)?.phase);

try {
  assert.equal(readPhase(), 'preparing');
  assert.equal(await startCanvasAfterReadiness(), null, 'server 普通入口不得绕过 owner 恢复');
  assert.equal(await ensureCanvasSchedulerStarted(), null, 'API 补启动不得创建无 owner worker');
  assert.equal(getCanvasSchedulerController(), null);
  assert.equal(readPhase(), 'preparing', '无 owner 时不得改变中断任务');

  const state = await startTeamServiceRuntime();
  assert.equal(state.ready, true, JSON.stringify(state));
  assert.equal(readPhase(), 'resume_pending', '团队 owner 才执行中断恢复');
  assert.equal(getCanvasSchedulerController()?.running, true);
  assert.equal(await ensureCanvasSchedulerStarted(), getCanvasSchedulerController());
  assert.equal(adapter.submissions.length, 0, '恢复不得自动重新付费提交');

  await drainTeamRuntime(5_000);
  assert.equal(getCanvasSchedulerController(), null, '团队 drain 同时停画布 worker');
  console.log('creative-canvas-server-bootstrap.test.ts 通过');
} finally {
  await stopCanvasScheduler();
  releaseTeamRuntimeOwner();
  clearCanvasCapabilities();
  closeDb();
  process.env = previousEnv;
  fs.rmSync(root, { recursive: true, force: true });
}
