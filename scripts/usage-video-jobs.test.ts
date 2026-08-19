import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

import {
  persistVideoJobUsageSnapshot,
  recordVideoJobUsage,
} from '../lib/usage-async-jobs.ts';
import { parseUsageSnapshot } from '../lib/usage-ledger.ts';
import { initUsageSchema } from '../lib/usage-schema.ts';

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE video_jobs (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL,
      providerId TEXT NOT NULL,
      model TEXT NOT NULL,
      durationSec INTEGER NOT NULL DEFAULT 5,
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

const klingProvider = {
  id: 'company-kling-3-0',
  name: '公司网关可灵 3.0',
  type: 'openai-video',
  model: 'kling-3.0',
};
const seedanceProvider = {
  id: 'company-seedance-2-0-fast',
  name: '公司网关 Seedance 2.0 Fast',
  type: 'openai-video',
  model: 'doubao-seedance-2-0-fast-260128',
};

function insertJob(
  db: Database.Database,
  input: {
    id: string;
    provider: typeof klingProvider | typeof seedanceProvider;
    model?: string;
    durationSec?: number;
    attempt?: number;
    providerTaskId?: string | null;
    snapshot?: string | null;
  },
): void {
  db.prepare(`
    INSERT INTO video_jobs
      (id, projectId, providerId, model, durationSec, attempt, providerTaskId, usageSnapshotJson)
    VALUES (?, 'project-1', ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.provider.id,
    input.model ?? input.provider.model,
    input.durationSec ?? 5,
    input.attempt ?? 1,
    input.providerTaskId ?? null,
    input.snapshot ?? null,
  );
}

function snapshotFor(db: Database.Database, jobId: string): string | null {
  const row = db.prepare(`SELECT usageSnapshotJson FROM video_jobs WHERE id = ?`).get(jobId) as { usageSnapshotJson: string | null };
  return row.usageSnapshotJson;
}

function freeze(
  db: Database.Database,
  jobId: string,
  provider: typeof klingProvider | typeof seedanceProvider,
  requestModel = provider.model,
): string | null {
  return persistVideoJobUsageSnapshot(db, {
    jobId,
    projectId: 'project-1',
    requestModel,
    provider,
    refType: 'video-job',
    refId: jobId,
    startedAt: '2026-08-18T06:00:00.000Z',
  });
}

// Both canonical company video identities are eligible, with their fixed 5s prices.
for (const [jobId, provider, expectedCoreModel, expectedCostMicros] of [
  ['video-kling', klingProvider, 'company-kling-3-0', 2_990_000],
  ['video-seedance', seedanceProvider, 'company-seedance-fast', 11_730_000],
] as const) {
  const db = createDb();
  insertJob(db, { id: jobId, provider });
  const snapshot = freeze(db, jobId, provider);
  assert.ok(snapshot, `${jobId} should freeze an eligible usage snapshot`);
  const parsed = parseUsageSnapshot(snapshot);
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.parsed.snapshot.coreModelKey, expectedCoreModel);
  const result = recordVideoJobUsage(db, {
    jobId,
    projectId: 'project-1',
    durationSec: 5,
    snapshot,
    finishedAt: '2026-08-18T06:00:05.000Z',
  });
  assert.equal(result.ok, true);
  assert.equal(result.inserted, true);
  const row = db.prepare(`SELECT eventKey, quantity, callCount, costMicros, createdAt FROM usage_ledger`).get() as {
    eventKey: string;
    quantity: number;
    callCount: number;
    costMicros: number;
    createdAt: string;
  };
  assert.deepEqual(row, {
    eventKey: `video-job:${jobId}:succeeded`,
    quantity: 5,
    callCount: 1,
    costMicros: expectedCostMicros,
    createdAt: '2026-08-18T06:00:05.000Z',
  });
  db.close();
}

// Similar/public identities and model mismatches must not freeze a snapshot.
for (const [jobId, provider, requestModel] of [
  ['video-wrong-id', { ...klingProvider, id: 'company-gateway-kling-3' }, 'kling-3.0'],
  ['video-wrong-type', { ...klingProvider, type: 'kling' }, 'kling-3.0'],
  ['video-wrong-configured-model', { ...klingProvider, model: 'kling-v3' }, 'kling-v3'],
  ['video-wrong-request-model', klingProvider, 'kling-v3'],
  ['video-public', { ...seedanceProvider, id: 'manual-company-seedance' }, seedanceProvider.model],
] as const) {
  const db = createDb();
  insertJob(db, { id: jobId, provider, model: requestModel });
  assert.equal(freeze(db, jobId, provider, requestModel), null, `${jobId} must not freeze usage`);
  assert.equal(snapshotFor(db, jobId), null);
  db.close();
}

// An already submitted remote task must never synthesize a snapshot at its current price.
{
  const db = createDb();
  insertJob(db, { id: 'video-existing-task', provider: klingProvider, providerTaskId: 'remote-123' });
  assert.equal(freeze(db, 'video-existing-task', klingProvider), null);
  assert.equal(snapshotFor(db, 'video-existing-task'), null);
  const result = recordVideoJobUsage(db, {
    jobId: 'video-existing-task',
    projectId: 'project-1',
    durationSec: 5,
    snapshot: null,
    finishedAt: '2026-08-18T06:10:00.000Z',
  });
  assert.equal(result.ok, true);
  assert.equal(result.inserted, false);
  assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM usage_ledger`).get() as { count: number }).count, 0);
  db.close();
}

// Existing non-empty snapshots are immutable across retries/recovery and successes are idempotent.
{
  const db = createDb();
  insertJob(db, { id: 'video-retry', provider: klingProvider, attempt: 2 });
  const first = freeze(db, 'video-retry', klingProvider);
  assert.ok(first);
  db.prepare(`UPDATE video_jobs SET attempt = 4 WHERE id = 'video-retry'`).run();
  assert.equal(freeze(db, 'video-retry', klingProvider), first);
  const firstRecord = recordVideoJobUsage(db, {
    jobId: 'video-retry',
    projectId: 'project-1',
    durationSec: 5,
    snapshot: first,
    finishedAt: '2026-08-18T06:20:05.000Z',
  });
  const secondRecord = recordVideoJobUsage(db, {
    jobId: 'video-retry',
    projectId: 'project-1',
    durationSec: 5,
    snapshot: first,
    finishedAt: '2026-08-18T06:20:05.000Z',
  });
  assert.equal(firstRecord.inserted, true);
  assert.equal(secondRecord.inserted, false);
  assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM usage_ledger`).get() as { count: number }).count, 1);
  db.close();
}

// Queue/route boundaries: snapshot only before the first submit and record only after atomic success.
{
  const queueSource = fs.readFileSync(path.resolve('lib/video-queue.ts'), 'utf8');
  const resumeSource = fs.readFileSync(path.resolve('app/api/video-jobs/[id]/resume-poll/route.ts'), 'utf8');
  const retrySource = fs.readFileSync(path.resolve('app/api/video-jobs/[id]/retry/route.ts'), 'utf8');
  const submitIndex = queueSource.indexOf('adapter.submit(');
  const snapshotIndex = queueSource.indexOf('persistVideoJobUsageSnapshot(');
  const successIndex = queueSource.indexOf("status = 'succeeded'");
  const recordIndex = queueSource.indexOf('recordVideoJobUsage(');
  assert.ok(snapshotIndex >= 0 && submitIndex >= 0 && snapshotIndex < submitIndex, 'queue must freeze before adapter.submit');
  assert.match(queueSource, /existingTaskId/);
  assert.match(queueSource, /if \(existingTaskId\)/, 'existing remote task must skip submit/snapshot');
  assert.ok(recordIndex > successIndex, 'queue must record only after atomic success');
  assert.match(queueSource, /WHERE id = \? AND status = 'running'/, 'queue success must be atomic');
  assert.match(resumeSource, /WHERE id = \? AND status = 'running'/, 'resume success must be atomic');
  assert.match(resumeSource, /recordVideoJobUsage\(/, 'resume must record from existing snapshot');
  assert.doesNotMatch(retrySource, /usageSnapshotJson\s*=\s*NULL/i, 'retry must preserve usageSnapshotJson');
}

console.log('usage-video-jobs tests passed');
