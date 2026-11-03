import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const {
  runTeamRelease, rollbackTeamRelease, writeTeamReleasePointer, readTeamReleasePointer,
  switchTeamReleasePointerIdempotent,
} = await import('../lib/team-service/maintenance/release.ts');
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'team-maintenance-release-'));
const backupRoot = path.join(fixtureRoot, 'backups');
const deploymentRoot = path.join(fixtureRoot, 'deployment');
const serviceRoot = path.join(deploymentRoot, 'service');
fs.mkdirSync(path.join(deploymentRoot, 'releases', 'old'), { recursive: true });
fs.mkdirSync(path.join(deploymentRoot, 'releases', 'new'), { recursive: true });
fs.writeFileSync(path.join(deploymentRoot, 'releases', 'old', 'release.txt'), 'old-immutable');
fs.writeFileSync(path.join(deploymentRoot, 'releases', 'new', 'release.txt'), 'new-immutable');
const oldRelease = { releaseId: 'old', packageSha256: 'a'.repeat(64) };
const newRelease = { releaseId: 'new', packageSha256: 'b'.repeat(64) };
await writeTeamReleasePointer({ serviceRoot, release: oldRelease });

function operation(overrides = {}) {
  const events: string[] = [];
  let failSwitch = false;
  let failSelfCheck = false;
  let backupCalls = 0;
  const adapters = {
    async preflight() { events.push('preflight'); },
    async enterMaintenance() { events.push('maintenance'); },
    async drainInflight() { events.push('drain'); return { pendingTasks: 0, unknownAttemptIds: ['unknown-kept'] }; },
    async captureExecution() { events.push('capture'); return { evidenceSha256: 'c'.repeat(64), operationCount: 1 }; },
    async stopOldInstance() {
      events.push('stop');
      return { deploymentId: 'deployment-release', instanceId: 'old-instance', stopped: true, residualPids: [] };
    },
    async createPreUpgradeBackup() { backupCalls += 1; events.push('backup'); return { backupId: 'pre-upgrade-release', verified: true }; },
    async switchRelease() {
      events.push('switch');
      if (failSwitch) throw new Error('injected switch failure');
      await writeTeamReleasePointer({ serviceRoot, release: newRelease, expectedReleaseId: 'old' });
    },
    async startMaintenance() { events.push('start-maintenance'); },
    async migrate() { events.push('migrate'); },
    async selfCheck() {
      events.push('self-check');
      if (failSelfCheck) return { available: false, automaticRetries: 0 };
      return { available: true, automaticRetries: 0 };
    },
    async resume() { events.push('resume'); },
  };
  return {
    operationId: 'release-operation-1', deploymentId: 'deployment-release', backupRoot, stateDirectory: serviceRoot,
    fromRelease: oldRelease, toRelease: newRelease, adapters,
    events,
    failSwitchOnce() { failSwitch = true; },
    failSelfCheckOnce() { failSelfCheck = true; },
    clearFailures() { failSwitch = false; failSelfCheck = false; },
    get backupCalls() { return backupCalls; },
    ...overrides,
  };
}

try {
  const context = operation();
  context.failSwitchOnce();
  await assert.rejects(() => runTeamRelease(context), (error: unknown) => {
    assert.equal((error as { stage?: string }).stage, 'switch');
    return true;
  });
  const state = JSON.parse(fs.readFileSync(path.join(serviceRoot, 'release-operation-1.json'), 'utf8'));
  assert.equal(state.status, 'failed');
  assert.equal(state.maintenance, true);
  assert.equal(state.currentStage, 'switch');
  assert.equal((await readTeamReleasePointer(serviceRoot)).releaseId, 'old');
  assert.equal(context.events.includes('resume'), false);
  assert.equal(context.backupCalls, 1);

  context.clearFailures();
  const resumed = await runTeamRelease(context);
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.maintenance, false);
  assert.equal(context.backupCalls, 1, '续跑不得重复 pre-upgrade 成功备份');
  assert.equal(context.events.filter((event) => event === 'switch').length, 2);
  assert.equal(context.events.at(-1), 'resume');
  assert.equal((await readTeamReleasePointer(serviceRoot)).releaseId, 'new');
  assert.deepEqual(resumed.unknownAttemptIds, ['unknown-kept']);
  assert.equal(fs.readFileSync(path.join(deploymentRoot, 'releases', 'old', 'release.txt'), 'utf8'), 'old-immutable');
  assert.equal(fs.readFileSync(path.join(deploymentRoot, 'releases', 'new', 'release.txt'), 'utf8'), 'new-immutable');

  const migration = operation({ operationId: 'release-operation-migration', stateDirectory: path.join(fixtureRoot, 'migration') });
  migration.adapters.switchRelease = async () => {};
  let failMigration = true;
  migration.adapters.migrate = async () => {
    if (failMigration) throw new Error('injected migration failure');
  };
  await assert.rejects(() => runTeamRelease(migration), (error: unknown) => (error as { stage?: string }).stage === 'migrate');
  assert.equal(migration.events.includes('resume'), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'migration', 'release-operation-migration.json'), 'utf8')).maintenance, true);
  failMigration = false;
  const afterMigration = await runTeamRelease(migration);
  assert.equal(afterMigration.status, 'completed');
  assert.equal(migration.backupCalls, 1);

  const stoppedRoot = path.join(fixtureRoot, 'stopped');
  const stoppedEvents: string[] = [];
  const stopped = operation({
    operationId: 'release-operation-stopped', stateDirectory: stoppedRoot,
    adapters: {
      async preflight() {},
      async enterMaintenance() { stoppedEvents.push('maintenance'); },
      async drainInflight() { return { pendingTasks: 0, unknownAttemptIds: [] }; },
      async captureExecution() { return { evidenceSha256: 'd'.repeat(64), operationCount: 0 }; },
      async stopOldInstance() {
        return { deploymentId: 'deployment-release', instanceId: 'old-instance', stopped: false, residualPids: [42] };
      },
      async createPreUpgradeBackup() { throw new Error('must not backup'); },
      async switchRelease() { stoppedEvents.push('switch'); },
      async startMaintenance() {}, async migrate() {},
      async selfCheck() { return { available: true, automaticRetries: 0 }; },
      async resume() { stoppedEvents.push('resume'); },
    },
  });
  await assert.rejects(() => runTeamRelease(stopped), (error: unknown) => (error as { stage?: string }).stage === 'stop');
  assert.equal(stoppedEvents.includes('switch'), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(stoppedRoot, 'release-operation-stopped.json'), 'utf8')).maintenance, true);

  let restoreCalls = 0;
  let rollbackSwitch = 0;
  const rollbackBase = {
    deploymentId: 'deployment-release', backupRoot, stateDirectory: serviceRoot,
    currentRelease: newRelease, targetRelease: oldRelease,
    adapters: {
      async stopCurrentInstance() { return { deploymentId: 'deployment-release', instanceId: 'new-instance', stopped: true, residualPids: [] }; },
      async switchRelease() { rollbackSwitch += 1; await writeTeamReleasePointer({ serviceRoot, release: oldRelease, expectedReleaseId: 'new' }); },
      async startMaintenance() {},
      async selfCheck() { return { available: true, automaticRetries: 0 }; },
      async resume() {},
      async restoreBackup() { restoreCalls += 1; return { restoreRoot: path.join(fixtureRoot, 'restored'), scheduling: false, automaticRetries: 0 }; },
    },
  };
  const compatible = await rollbackTeamRelease({
    ...rollbackBase, operationId: 'rollback-compatible', strategy: 'compatible',
    compatibility: { schemaCompatible: true, irreversibleChanges: false },
  });
  assert.equal(compatible.status, 'completed');
  assert.equal(rollbackSwitch, 1);
  assert.equal(restoreCalls, 0);

  await writeTeamReleasePointer({ serviceRoot, release: newRelease, expectedReleaseId: 'old' });
  const incompatible = await rollbackTeamRelease({
    ...rollbackBase, operationId: 'rollback-restore', strategy: 'restore',
    compatibility: { schemaCompatible: false, irreversibleChanges: true },
    adapters: {
      ...rollbackBase.adapters,
      async switchRelease() { throw new Error('数据不兼容恢复不得回切指针'); },
    },
  });
  assert.equal(incompatible.status, 'restore_hold');
  assert.equal(incompatible.maintenance, true);
  assert.equal(restoreCalls, 1);
  assert.equal((await readTeamReleasePointer(serviceRoot)).releaseId, 'new');
  assert.equal(incompatible.scheduling, false);
  assert.equal(incompatible.automaticRetries, 0);

  const idempotentRoot = path.join(fixtureRoot, 'idempotent');
  await writeTeamReleasePointer({ serviceRoot: idempotentRoot, release: oldRelease });
  const firstSwitch = await switchTeamReleasePointerIdempotent({
    serviceRoot: idempotentRoot, release: newRelease, expectedReleaseId: 'old',
  });
  const repeatedSwitch = await switchTeamReleasePointerIdempotent({
    serviceRoot: idempotentRoot, release: newRelease, expectedReleaseId: 'old',
  });
  assert.equal(firstSwitch.alreadyCurrent, false);
  assert.equal(repeatedSwitch.alreadyCurrent, true);
  assert.equal(repeatedSwitch.pointer.switchedAt, firstSwitch.pointer.switchedAt);

  console.log('team maintenance release and rollback tests passed');
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
