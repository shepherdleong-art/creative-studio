import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-execution-contention-'));
const previousRoot = process.env.CREATIVE_STUDIO_DATA_ROOT;
process.env.CREATIVE_STUDIO_DATA_ROOT = fixtureRoot;
const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
const { checkExecutionReadiness } = await import('../lib/media-core/execution/readiness.ts');
const { createExecutionFacade } = await import('../lib/media-core/execution/operations.ts');
const { createExecutionJournal } = await import('../lib/media-core/execution/journal.ts');
const { updateActorPolicy, upsertExecutionPool } = await import('../lib/media-core/execution/pools.ts');
const workerPath = fileURLToPath(new URL('./execution-admission.worker.ts', import.meta.url));
const databases = new Set<Database.Database>();

async function scenario(name: string, options: { monthlyLimit: number; quote: number; poolCapacity: number; expectedReason: string }) {
  const root = path.join(fixtureRoot, name);
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  const db = new Database(path.join(root, 'data', 'workbench.db'));
  databases.add(db);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  const ready = await checkExecutionReadiness({ db, ...schemaUpgradeRuntimePaths(root) });
  assert.equal(ready.available, true);
  upsertExecutionPool(db, {
    poolKey: 'shared', kind: 'remote', capacity: options.poolCapacity, enabled: true,
    mappingSnapshot: { providerId: 'provider-a' }, expectedVersion: 0,
  });
  updateActorPolicy(db, {
    actorId: 'user-a', monthlyLimitMinor: options.monthlyLimit, personalConcurrency: 2, paused: false, expectedVersion: 0,
  });
  updateActorPolicy(db, {
    actorId: 'user-b', monthlyLimitMinor: null, personalConcurrency: 2, paused: false, expectedVersion: 0,
  });
  const runtime = createExecutionFacade({
    db, deploymentId: 'deployment-contention', journal: createExecutionJournal({ deploymentId: 'deployment-contention' }),
    actorAllowed: () => true, scopeAllowed: () => true, maintenance: () => false,
  });
  const parentIdentity = { instanceId: `parent-${name}`, fence: 90 };
  db.prepare('INSERT INTO execution_instances (instanceId, fence, deploymentId, startedAt) VALUES (?, ?, ?, ?)')
    .run(parentIdentity.instanceId, parentIdentity.fence, 'deployment-contention', new Date().toISOString());
  await runtime.lifecycle.start({ ...parentIdentity, deploymentId: 'deployment-contention', signal: new AbortController().signal });
  const actors = name === 'budget' ? ['user-a', 'user-a'] : ['user-a', 'user-b'];
  for (const [index, actorId] of actors.entries()) {
    const taskId = `${name}-${index + 1}`;
    runtime.facade.enqueue({
      operationKey: `images/${taskId}/submit/r1`, actor: { userId: actorId },
      scope: { resourceType: 'project', resourceId: `${actorId}-project` },
      module: 'images', taskId, step: 'submit', inputRevision: 'r1',
      businessAttempt: { id: `${taskId}-business`, number: 1 },
      inputSnapshot: { taskId }, inputHash: `hash-${taskId}`,
      continuationKey: 'images.submit', providerSnapshot: { providerId: 'provider-a', model: 'model-a' },
      requiredPools: ['shared'],
      quote: { kind: 'priced', reserve: { currency: 'CNY', minor: options.quote }, pricingSnapshot: { version: 1 } },
    });
  }
  runtime.closeNewWork();

  const workers = actors.map((actorId, index) => {
    const readyPath = path.join(root, `ready-${index}`);
    const goPath = path.join(root, 'go');
    const child = spawn(process.execPath, [
      workerPath, path.join(root, 'data', 'workbench.db'), actorId, `worker-${name}-${index}`, String(index + 1), readyPath, goPath,
    ], {
      cwd: path.dirname(workerPath),
      env: { ...process.env, CREATIVE_STUDIO_DATA_ROOT: root },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const exited = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`worker failed (${code}): ${stderr}`)));
    });
    return { child, readyPath, goPath, exited, getStdout: () => stdout };
  });
  const waitDeadline = Date.now() + 10_000;
  while (!workers.every(({ readyPath }) => fs.existsSync(readyPath))) {
    if (Date.now() > waitDeadline) throw new Error('workers did not reach admission barrier');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  fs.writeFileSync(path.join(root, 'go'), 'go', 'utf8');
  await Promise.all(workers.map(({ exited }) => exited));
  const results = workers.map(({ getStdout }) => JSON.parse(getStdout()) as {
    kind: string; reasons: string[]; grantedTaskId: string | null;
  });
  assert.equal(results.filter(({ kind }) => kind === 'admitted').length, 1);
  const deferred = results.find(({ kind }) => kind === 'deferred');
  assert.ok(deferred?.reasons.includes(options.expectedReason), JSON.stringify(results));
  assert.equal(db.prepare('SELECT COUNT(*) FROM execution_attempts').pluck().get(), 1);
  assert.equal(db.prepare("SELECT COUNT(*) FROM execution_reservations WHERE kind = 'cost' AND state = 'held'").pluck().get(), 1);
  assert.equal(db.prepare("SELECT COUNT(*) FROM execution_reservations WHERE kind = 'concurrency' AND poolKey = 'shared' AND state = 'held'").pluck().get(), 1);
  return results;
}

try {
  const budget = await scenario('budget', { monthlyLimit: 100, quote: 80, poolCapacity: 2, expectedReason: 'monthly_budget' });
  assert.equal(budget.find(({ kind }) => kind === 'admitted')?.grantedTaskId, 'budget-1', '同用户 FIFO 队首先获得唯一可支付名额');
  await scenario('pool', { monthlyLimit: 100, quote: 0, poolCapacity: 1, expectedReason: 'pool_capacity' });
  console.log('execution admission contention tests passed');
} finally {
  for (const db of databases) db.close();
  if (previousRoot === undefined) delete process.env.CREATIVE_STUDIO_DATA_ROOT;
  else process.env.CREATIVE_STUDIO_DATA_ROOT = previousRoot;
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
