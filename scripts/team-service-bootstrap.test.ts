import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-team-bootstrap-'));
const previousRoot = process.env.CREATIVE_STUDIO_DATA_ROOT;
process.env.CREATIVE_STUDIO_DATA_ROOT = fixtureRoot;

const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
const { createTeamServiceBootstrap } = await import('../lib/team-service/bootstrap.ts');
const {
  getTeamRuntimeState,
  resetTeamRuntimeStateForTests,
} = await import('../lib/team-service/runtime/state.ts');
const { assertExecutionFence } = await import('../lib/media-core/execution/contracts.ts');

const config = {
  mode: 'server' as const,
  dataRoot: fixtureRoot,
  hostname: '127.0.0.1' as const,
  port: 3300,
  deploymentId: 'deployment-bootstrap',
  trustedOrigin: 'https://studio.example.test',
};
const identity = { instanceId: 'instance-bootstrap', fence: 7 };
const databases = new Set<Database.Database>();

function setup(name: string, events: string[] = [], withExecution = false) {
  const root = path.join(fixtureRoot, name);
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  const db = new Database(path.join(root, 'data', 'workbench.db'));
  databases.add(db);
  db.exec('CREATE TABLE existing_business_table (id TEXT PRIMARY KEY)');
  const lifecycle = (module: string) => ({
    name: module,
    ensureSchemaReady: () => { events.push(`${module}.schema`); },
    registerRecovery: () => { events.push(`${module}.register`); },
    recover: () => { events.push(`${module}.recover`); },
    start: () => { events.push(`${module}.start`); },
    drain: () => {
      events.push(`${module}.drain`);
      return module === 'b' ? 2 : 0;
    },
  });
  const bootstrap = createTeamServiceBootstrap({
    config: { ...config, dataRoot: root },
    identity,
    db,
    ...schemaUpgradeRuntimePaths(root),
    modules: [lifecycle('a'), lifecycle('b')],
    ...(withExecution ? {
      execution: {
        facade: {} as never,
        lifecycle: lifecycle('execution'),
        closeNewWork() {},
      },
    } : {}),
    checkBusinessReadiness: async () => ({ available: true }),
  });
  return { root, db, bootstrap, events };
}

try {
  {
    resetTeamRuntimeStateForTests();
    const { bootstrap, db, events } = setup('success');
    assert.equal(getTeamRuntimeState().live, true);
    assert.equal(getTeamRuntimeState().ready, false);
    await assert.rejects(() => bootstrap.recover(), /registerRecovery/);

    await bootstrap.ensureSchemaReady();
    assert.deepEqual(events, ['a.schema', 'b.schema']);
    await bootstrap.registerRecovery();
    assert.deepEqual(events, ['a.schema', 'b.schema', 'a.register', 'b.register']);
    assert.deepEqual(
      db.prepare('SELECT instanceId, fence, deploymentId FROM execution_instances').get(),
      { instanceId: 'instance-bootstrap', fence: 7, deploymentId: 'deployment-bootstrap' },
    );
    await bootstrap.recover();
    await bootstrap.start();
    assert.deepEqual(events, [
      'a.schema', 'b.schema',
      'a.register', 'b.register',
      'a.recover', 'b.recover',
      'a.start', 'b.start',
    ]);
    assert.deepEqual(
      {
        ready: getTeamRuntimeState().ready,
        phase: getTeamRuntimeState().phase,
        maintenance: getTeamRuntimeState().maintenance,
        instanceId: getTeamRuntimeState().instanceId,
        fence: getTeamRuntimeState().fence,
      },
      {
        ready: true,
        phase: 'ready',
        maintenance: false,
        instanceId: 'instance-bootstrap',
        fence: 7,
      },
    );
    assert.deepEqual(await bootstrap.drain(), { stopped: false, pendingTasks: 2 });
    assert.deepEqual(events.slice(-2), ['b.drain', 'a.drain']);
    assert.equal(getTeamRuntimeState().ready, false);
    assert.equal(getTeamRuntimeState().maintenance, true);
    assert.throws(
      () => assertExecutionFence(identity, { instanceId: identity.instanceId, fence: 8 }),
      /fence/,
    );
  }

  {
    resetTeamRuntimeStateForTests();
    const { bootstrap, events } = setup('execution-order', [], true);
    await bootstrap.ensureSchemaReady();
    await bootstrap.registerRecovery();
    await bootstrap.recover();
    await bootstrap.start();
    assert.deepEqual(events, [
      'execution.schema', 'a.schema', 'b.schema',
      'execution.register', 'a.register', 'b.register',
      'execution.recover', 'a.recover', 'b.recover',
      'execution.start', 'a.start', 'b.start',
    ], '执行设施必须先于业务恢复和开放');
    assert.deepEqual(await bootstrap.drain(), { stopped: false, pendingTasks: 2 });
    assert.deepEqual(events.slice(-3), ['b.drain', 'a.drain', 'execution.drain'],
      '业务必须先 drain，执行设施最后收尾');
  }

  {
    resetTeamRuntimeStateForTests();
    const { bootstrap, db, events } = setup('migration-failure');
    db.exec('CREATE TABLE team_service_state (id INTEGER PRIMARY KEY)');
    await assert.rejects(
      () => bootstrap.ensureSchemaReady(),
      (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error
        && (error as { code?: string }).code === 'migration_failed'),
    );
    assert.equal(getTeamRuntimeState().ready, false);
    assert.equal(getTeamRuntimeState().phase, 'failed');
    assert.equal(getTeamRuntimeState().maintenance, true);
    assert.deepEqual(events, [], '共享迁移失败不得进入模块恢复或付费启动');
    await assert.rejects(() => bootstrap.start(), /ensureSchemaReady/);
  }

  {
    resetTeamRuntimeStateForTests();
    const root = path.join(fixtureRoot, 'identity-failure');
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    const db = new Database(path.join(root, 'data', 'workbench.db'));
    databases.add(db);
    db.exec('CREATE TABLE existing_business_table (id TEXT PRIMARY KEY)');
    const events: string[] = [];
    const bootstrap = createTeamServiceBootstrap({
      config: { ...config, dataRoot: root },
      identity,
      db,
      ...schemaUpgradeRuntimePaths(root),
      modules: [{
        name: 'business',
        ensureSchemaReady: () => { events.push('schema'); },
        registerRecovery: () => { events.push('register'); },
        recover: () => { events.push('recover'); },
        start: () => { events.push('start'); },
      }],
      checkBusinessReadiness: async () => ({
        available: false as const,
        code: 'identity_unavailable',
        message: '身份设施未就绪',
      }),
    });
    await bootstrap.ensureSchemaReady();
    await assert.rejects(
      () => bootstrap.registerRecovery(),
      (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error
        && (error as { code?: string }).code === 'identity_unavailable'),
    );
    assert.deepEqual(events, ['schema', 'register']);
    assert.equal(getTeamRuntimeState().ready, false);
    assert.equal(getTeamRuntimeState().maintenance, true);
  }

  console.log('team service bootstrap tests passed');
} finally {
  for (const db of databases) db.close();
  resetTeamRuntimeStateForTests();
  if (previousRoot === undefined) delete process.env.CREATIVE_STUDIO_DATA_ROOT;
  else process.env.CREATIVE_STUDIO_DATA_ROOT = previousRoot;
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
