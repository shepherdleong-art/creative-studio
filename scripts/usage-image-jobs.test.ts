import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

import {
  persistImageJobUsageSnapshot,
  recordImageJobUsage,
} from '../lib/usage-async-jobs.ts';
import { parseUsageSnapshot } from '../lib/usage-ledger.ts';
import { CORE_USAGE_PRICING_VERSION } from '../lib/usage-pricing.ts';
import { initUsageSchema } from '../lib/usage-schema.ts';

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL,
      providerId TEXT NOT NULL,
      model TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      providerTaskId TEXT,
      startedAt TEXT,
      finishedAt TEXT,
      usageSnapshotJson TEXT
    );
  `);
  initUsageSchema(db);
  return db;
}

const exactProvider = {
  id: 'company-gateway-image2-medium',
  name: '公司网关 image2-medium',
  type: 'gateway-task-image',
  model: 'image2-medium',
};

function insertJob(
  db: Database.Database,
  input: {
    id: string;
    model?: string;
    projectId?: string;
    attempt?: number;
    providerTaskId?: string | null;
    snapshot?: string | null;
  } = { id: 'image-job-1' },
): void {
  db.prepare(`
    INSERT INTO jobs (id, projectId, providerId, model, attempt, providerTaskId, usageSnapshotJson)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.projectId ?? 'project-1',
    exactProvider.id,
    input.model ?? 'image2-medium',
    input.attempt ?? 1,
    input.providerTaskId ?? null,
    input.snapshot ?? null,
  );
}

function snapshotFor(db: Database.Database, jobId: string): string | null {
  const row = db.prepare(`SELECT usageSnapshotJson FROM jobs WHERE id = ?`).get(jobId) as { usageSnapshotJson: string | null };
  return row.usageSnapshotJson;
}

// Exact identity is the only image job that may freeze a core usage snapshot.
{
  const db = createDb();
  insertJob(db, { id: 'exact-job', attempt: 2 });
  const snapshot = persistImageJobUsageSnapshot(db, {
    jobId: 'exact-job',
    projectId: 'project-1',
    requestModel: 'image2-medium',
    provider: exactProvider,
    refType: 'job',
    refId: 'exact-job',
    startedAt: '2026-08-18T01:02:03.000Z',
  });
  assert.ok(snapshot, 'exact company image identity should persist a snapshot');
  const parsed = parseUsageSnapshot(snapshot);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.parsed.snapshot.pricingVersion, CORE_USAGE_PRICING_VERSION);
    assert.equal(parsed.parsed.snapshot.coreModelKey, 'company-image2-medium');
    assert.equal(parsed.parsed.snapshot.provider.providerId, exactProvider.id);
    assert.equal(parsed.parsed.snapshot.provider.requestModel, 'image2-medium');
  }
  assert.equal(snapshotFor(db, 'exact-job'), snapshot);
  db.close();
}

// An already-submitted remote image task must never receive a new snapshot.
{
  const db = createDb();
  insertJob(db, { id: 'already-submitted-job', providerTaskId: 'remote-image-task-1' });
  const snapshot = persistImageJobUsageSnapshot(db, {
    jobId: 'already-submitted-job',
    projectId: 'project-1',
    requestModel: 'image2-medium',
    provider: exactProvider,
    refType: 'job',
    refId: 'already-submitted-job',
  });
  assert.equal(snapshot, null, 'an existing providerTaskId must block snapshot creation');
  assert.equal(snapshotFor(db, 'already-submitted-job'), null);
  db.close();
}

// If the task identity cannot be read, snapshot creation must fail closed too.
{
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL,
      providerId TEXT NOT NULL,
      model TEXT NOT NULL,
      usageSnapshotJson TEXT
    );
  `);
  initUsageSchema(db);
  db.prepare(`
    INSERT INTO jobs (id, projectId, providerId, model)
    VALUES ('unreadable-task-identity', 'project-1', ?, 'image2-medium')
  `).run(exactProvider.id);
  assert.equal(
    persistImageJobUsageSnapshot(db, {
      jobId: 'unreadable-task-identity',
      projectId: 'project-1',
      requestModel: 'image2-medium',
      provider: exactProvider,
      refType: 'job',
      refId: 'unreadable-task-identity',
    }),
    null,
    'an unreadable providerTaskId must fail closed',
  );
  db.close();
}

// A similar/public provider or a request-model mismatch must not write.
for (const [name, provider, requestModel] of [
  ['wrong-provider-id', { ...exactProvider, id: 'company-gateway-image2-medium-copy' }, 'image2-medium'],
  ['wrong-provider-type', { ...exactProvider, type: 'openai-compatible' }, 'image2-medium'],
  ['wrong-configured-model', { ...exactProvider, model: 'image2-large' }, 'image2-large'],
  ['wrong-request-model', exactProvider, 'image2-large'],
  ['public-provider', { ...exactProvider, id: 'public-image2-medium' }, 'image2-medium'],
] as const) {
  const db = createDb();
  insertJob(db, { id: name });
  const snapshot = persistImageJobUsageSnapshot(db, {
    jobId: name,
    projectId: 'project-1',
    requestModel,
    provider,
    refType: 'job',
    refId: name,
  });
  assert.equal(snapshot, null, `${name} must not produce a usage snapshot`);
  assert.equal(snapshotFor(db, name), null, `${name} must not write jobs.usageSnapshotJson`);
  db.close();
}

// The schema gate is fail-open for the image request: no snapshot is written.
{
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL,
      providerId TEXT NOT NULL,
      model TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0,
      providerTaskId TEXT,
      usageSnapshotJson TEXT
    );
  `);
  insertJob(db, { id: 'schema-unavailable-job' });
  assert.equal(
    persistImageJobUsageSnapshot(db, {
      jobId: 'schema-unavailable-job',
      projectId: 'project-1',
      requestModel: 'image2-medium',
      provider: exactProvider,
      refType: 'job',
      refId: 'schema-unavailable-job',
    }),
    null,
  );
  assert.equal(snapshotFor(db, 'schema-unavailable-job'), null);
  db.close();
}

// A retry/recovery must reuse the original snapshot and never overwrite its pricing version.
{
  const db = createDb();
  insertJob(db, { id: 'reuse-job', attempt: 1 });
  const first = persistImageJobUsageSnapshot(db, {
    jobId: 'reuse-job',
    projectId: 'project-1',
    requestModel: 'image2-medium',
    provider: exactProvider,
    refType: 'job',
    refId: 'reuse-job',
    startedAt: '2026-08-18T02:00:00.000Z',
  });
  assert.ok(first);
  db.prepare(`UPDATE jobs SET attempt = 3 WHERE id = 'reuse-job'`).run();
  const second = persistImageJobUsageSnapshot(db, {
    jobId: 'reuse-job',
    projectId: 'project-1',
    requestModel: 'image2-medium',
    provider: exactProvider,
    refType: 'job',
    refId: 'reuse-job',
    startedAt: '2026-08-18T03:00:00.000Z',
  });
  assert.equal(second, first, 'a non-empty snapshot is immutable across retry/recovery');
  assert.equal(snapshotFor(db, 'reuse-job'), first);
  db.close();
}

// Success accounting is immutable/idempotent and bills the successful attempt count.
{
  const db = createDb();
  insertJob(db, { id: 'ledger-job', attempt: 3 });
  const snapshot = persistImageJobUsageSnapshot(db, {
    jobId: 'ledger-job',
    projectId: 'project-1',
    requestModel: 'image2-medium',
    provider: exactProvider,
    refType: 'job',
    refId: 'ledger-job',
    startedAt: '2026-08-18T04:00:00.000Z',
  });
  assert.ok(snapshot);
  const finishedAt = '2026-08-18T04:00:12.000Z';
  const first = recordImageJobUsage(db, {
    jobId: 'ledger-job',
    projectId: 'project-1',
    attempt: 3,
    snapshot,
    finishedAt,
  });
  assert.equal(first.ok, true);
  assert.equal(first.inserted, true);
  const second = recordImageJobUsage(db, {
    jobId: 'ledger-job',
    projectId: 'project-1',
    attempt: 3,
    snapshot,
    finishedAt,
  });
  assert.equal(second.ok, true);
  assert.equal(second.inserted, false, 'repeating the success event must be a no-op');
  const row = db.prepare(`
    SELECT eventKey, callCount, quantity, costMicros, createdAt
    FROM usage_ledger
  `).get() as { eventKey: string; callCount: number; quantity: number; costMicros: number; createdAt: string };
  assert.deepEqual(row, {
    eventKey: 'image-job:ledger-job:succeeded',
    callCount: 3,
    quantity: 3,
    costMicros: 3_150_000,
    createdAt: finishedAt,
  });
  db.close();
}

// Missing snapshots are not backfilled at the current price during the live success path.
{
  const db = createDb();
  insertJob(db, { id: 'no-snapshot-job', attempt: 2 });
  const result = recordImageJobUsage(db, {
    jobId: 'no-snapshot-job',
    projectId: 'project-1',
    attempt: 2,
    snapshot: null,
    finishedAt: '2026-08-18T05:00:00.000Z',
  });
  assert.equal(result.ok, true);
  assert.equal(result.inserted, false);
  assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM usage_ledger`).get() as { count: number }).count, 0);
  db.close();
}

// Queue and route wiring must place snapshot/ledger calls at the real transition boundaries.
{
  const queueSource = fs.readFileSync(path.resolve('lib/queue.ts'), 'utf8');
  const resumeSource = fs.readFileSync(path.resolve('app/api/jobs/[id]/resume-poll/route.ts'), 'utf8');
  const retrySource = fs.readFileSync(path.resolve('app/api/jobs/[id]/retry/route.ts'), 'utf8');
  const submitIndex = queueSource.indexOf('submitGatewayTaskImage(');
  const snapshotIndex = queueSource.indexOf('persistImageJobUsageSnapshot(');
  const completeIndex = queueSource.indexOf("status = 'succeeded'");
  const queueRecordIndex = queueSource.indexOf('recordImageJobUsage(');
  assert.ok(snapshotIndex >= 0 && submitIndex >= 0 && snapshotIndex < submitIndex, 'queue must freeze usage before submit');
  const existingTaskReadIndex = queueSource.indexOf('SELECT providerTaskId FROM jobs WHERE id = ?');
  assert.ok(existingTaskReadIndex >= 0 && existingTaskReadIndex < snapshotIndex && existingTaskReadIndex < submitIndex, 'queue must inspect an existing remote task before usage or submit');
  assert.match(queueSource, /if \(existingTaskId\)/, 'existing remote task must skip a new image submit');
  assert.match(queueSource, /status = 'needs_check'/, 'an existing remote task must enter the manual resume-poll path');
  const guardedSnapshotIndex = queueSource.indexOf('usageSnapshot = persistImageJobUsageSnapshot');
  const postSnapshotTaskReadIndex = queueSource.indexOf('SELECT providerTaskId FROM jobs WHERE id = ?', guardedSnapshotIndex);
  assert.ok(postSnapshotTaskReadIndex > guardedSnapshotIndex, 'queue must re-check providerTaskId after the guarded snapshot write to close the submit race');
  assert.ok(queueRecordIndex > completeIndex, 'queue must record only after atomic success');
  assert.match(resumeSource, /WHERE id = \? AND status = 'running'/, 'resume success must be atomic');
  assert.match(resumeSource, /recordImageJobUsage\(/, 'resume success must record from the stored snapshot');
  assert.doesNotMatch(retrySource, /usageSnapshotJson\s*=\s*NULL/i, 'retry must preserve usageSnapshotJson');
  assert.match(retrySource, /providerTaskId/, 'retry must inspect an already-submitted remote task');
  assert.match(retrySource, /status = 'needs_check'/, 'retry must route an already-submitted task to resume-poll');
}

console.log('usage-image-jobs tests passed');
