import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

import {
  persistVideoJobUsageSnapshot,
  recordVideoJobUsage,
} from '../lib/usage-async-jobs.ts';
import { BILLING_MODEL_PRICES, calculateUsageCostMicros, createCoreUsageSnapshot, resolveCoreUsagePlan } from '../lib/usage-pricing.ts';
import { videoJobUsageMeasurement } from '../lib/usage-video-measurement.ts';
import { reconcileUsageLedger } from '../lib/usage-ledger.ts';
import { parseUsageSnapshot } from '../lib/usage-snapshot.ts';
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
      resolution TEXT,
      generationMode TEXT NOT NULL DEFAULT 'image-to-video',
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

interface TestVideoProvider {
  id: string;
  name?: string;
  type?: string;
  model?: string;
  baseUrl?: string | null;
}

const klingProvider: TestVideoProvider = {
  id: 'company-kling-3-0',
  name: '公司网关可灵 3.0',
  type: 'openai-video',
  model: 'kling-3.0',
};
const seedanceProvider: TestVideoProvider = {
  id: 'company-seedance-2-0-fast',
  name: '公司网关 Seedance 2.0 Fast',
  type: 'openai-video',
  model: 'doubao-seedance-2-0-fast-260128',
};

function insertJob(
  db: Database.Database,
  input: {
    id: string;
    provider: TestVideoProvider;
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
  provider: TestVideoProvider,
  requestModel = provider.model ?? '',
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

// Canonical company video identities are eligible, with their fixed 5s prices.
for (const [jobId, provider, expectedCoreModel, expectedCostMicros] of [
  ['video-kling', klingProvider, 'company-kling-3-0', 2_990_000],
  ['video-h3', { id: 'company-minimax-h3', type: 'openai-video', model: 'minimax-h3' }, 'company-minimax-h3', 4_000_000],
  ['video-wan', { id: 'company-wan-3-0', type: 'openai-video', model: 'wan-3.0' }, 'company-wan-3-0', 6_000_000],
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
  ['video-public-baseurl', { ...klingProvider, id: 'kling-2-5', baseUrl: 'https://api.klingai.com' }, 'kling-3.0'],
] as const) {
  const db = createDb();
  insertJob(db, { id: jobId, provider, model: requestModel });
  assert.equal(freeze(db, jobId, provider, requestModel), null, `${jobId} must not freeze usage`);
  assert.equal(snapshotFor(db, jobId), null);
  db.close();
}

// A manually added company-gateway row (non-canonical id + loopback baseUrl) is billable too.
{
  const db = createDb();
  const gatewayKling: TestVideoProvider = {
    id: 'kling-2-5',
    name: 'kling-3.0',
    type: 'openai-video',
    model: 'kling-3.0',
    baseUrl: 'http://127.0.0.1:4000',
  };
  insertJob(db, { id: 'video-gateway-kling', provider: gatewayKling });
  const snapshot = freeze(db, 'video-gateway-kling', gatewayKling);
  assert.ok(snapshot, 'gateway-routed manual provider must freeze a usage snapshot');
  const parsed = parseUsageSnapshot(snapshot);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.parsed.snapshot.coreModelKey, 'company-kling-3-0');
    assert.equal(parsed.parsed.snapshot.provider.baseUrl, 'http://127.0.0.1:4000', 'snapshot must keep the gateway baseUrl for replay revalidation');
  }
  const result = recordVideoJobUsage(db, {
    jobId: 'video-gateway-kling',
    projectId: 'project-1',
    durationSec: 5,
    snapshot,
    finishedAt: '2026-08-25T06:00:05.000Z',
  });
  assert.equal(result.ok, true);
  assert.equal(result.inserted, true);
  const row = db.prepare(`SELECT coreModelKey, quantity, costMicros FROM usage_ledger`).get() as {
    coreModelKey: string;
    quantity: number;
    costMicros: number;
  };
  assert.deepEqual(row, { coreModelKey: 'company-kling-3-0', quantity: 5, costMicros: 2_990_000 });
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
  const submitIndex = queueSource.indexOf('adapter.submit(');
  const snapshotIndex = queueSource.indexOf('persistVideoJobUsageSnapshot(');
  const successIndex = queueSource.indexOf("status = 'succeeded'");
  const recordIndex = queueSource.indexOf('recordVideoJobUsage(');
  assert.ok(snapshotIndex >= 0 && submitIndex >= 0 && snapshotIndex < submitIndex, 'queue must freeze before adapter.submit');
  assert.match(queueSource, /existingTaskId/);
  assert.match(queueSource, /if \(existingTaskId\)/, 'existing remote task must skip submit/snapshot');
  assert.ok(recordIndex > successIndex, 'queue must record only after atomic success');
  assert.match(queueSource, /WHERE id = \? AND status = 'running'/, 'queue success must be atomic');
  assert.match(resumeSource, /await resumeVideoJobPolling\(id\)/, 'resume route must delegate to the shared queue');
  const resumeWorkerSource = queueSource.slice(queueSource.indexOf('export async function resumeVideoJobPolling('), queueSource.indexOf('async function runAuthorizedVideoJob('));
  assert.match(resumeWorkerSource, /await runVideoJob\(/, 'resume must use the queue success/usage transaction checked above');
}

// H3 freezes independent Tencent input/output seconds for quoting, settlement and replay.
for (const [resolution, rate] of [['768P', 500_000], ['2K', 800_000]] as const) {
  const db = createDb();
  const provider = { id: BILLING_MODEL_PRICES.find((entry) => entry.model === 'minimax-h3')!.id, type: 'openai-video', model: 'minimax-h3' };
  db.exec(`CREATE TABLE video_reference_assets (id TEXT PRIMARY KEY, projectId TEXT, kind TEXT, durationSec REAL);
    CREATE TABLE video_job_references (jobId TEXT, orderIndex INTEGER, assetId TEXT);`);
  insertJob(db, { id: 'h3-ref', provider });
  db.prepare("UPDATE video_jobs SET resolution = ?, generationMode = 'reference-to-video' WHERE id = 'h3-ref'").run(resolution);
  for (const [index, kind, duration] of [[0, 'video', 2.125], [1, 'video', 3.25], [2, 'audio', 15], [3, 'image', null]] as const) {
    db.prepare('INSERT INTO video_reference_assets VALUES (?, ?, ?, ?)').run(String(index), 'project-1', kind, duration);
    db.prepare('INSERT INTO video_job_references VALUES (?, ?, ?)').run('h3-ref', index, String(index));
  }
  const frozen = freeze(db, 'h3-ref', provider)!;
  const parsed = parseUsageSnapshot(frozen);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error('invalid H3 snapshot');
  assert.deepEqual(parsed.parsed.snapshot.videoUsage, { resolution, inputVideoDurationSec: 5.375, outputVideoDurationSec: 5 });
  const measurement = videoJobUsageMeasurement(parsed.parsed.snapshot, 99)!;
  const expected = Math.round(10.375 * rate);
  assert.equal(calculateUsageCostMicros(parsed.parsed.snapshot.priceComponents, measurement.quantity), expected, 'same measure used by execution reservation and settlement');
  db.prepare("UPDATE video_reference_assets SET durationSec = 14 WHERE kind = 'video'").run();
  db.prepare("UPDATE video_jobs SET resolution = '2K', durationSec = 15 WHERE id = 'h3-ref'").run();
  assert.equal(freeze(db, 'h3-ref', provider), frozen, 'job/provider/reference edits never reprice a submitted snapshot');
  const record = () => recordVideoJobUsage(db, { jobId: 'h3-ref', snapshot: frozen, durationSec: 99, finishedAt: '2026-11-12T00:00:00Z' });
  assert.equal(record().inserted, true);
  assert.equal(record().inserted, false);
  let row = db.prepare('SELECT costMicros, callCount, quantity, detailJson FROM usage_ledger').get() as { costMicros: number; callCount: number; quantity: number; detailJson: string };
  assert.equal(row.costMicros, expected); assert.equal(row.quantity, 10.375); assert.equal(row.callCount, 1);
  const components = JSON.parse(row.detailJson).priceComponents;
  assert.deepEqual(components.map((component: { key: string; quantity: number }) => [component.key, component.quantity]), [['input_second', 5.375], ['output_second', 5]]);
  db.prepare('DELETE FROM usage_ledger').run();
  // Replay with deliberately unequal frozen rates catches accidental input/output mixing.
  parsed.parsed.snapshot.priceComponents[0].unitPriceMicros = 600_000;
  parsed.parsed.snapshot.priceComponents[1].unitPriceMicros = 900_000;
  db.prepare("UPDATE video_jobs SET status = 'succeeded', usageSnapshotJson = ?, finishedAt = '2026-11-12T00:00:00Z' WHERE id = 'h3-ref'")
    .run(JSON.stringify(parsed.parsed.snapshot));
  assert.equal(reconcileUsageLedger(db).recorded, 1);
  row = db.prepare('SELECT costMicros, callCount, quantity, detailJson FROM usage_ledger').get() as typeof row;
  assert.equal(row.costMicros, 7_725_000, 'reconciliation retains both frozen rates and original seconds');
  assert.equal(reconcileUsageLedger(db).recorded, 0);

  insertJob(db, { id: 'h3-unknown', provider });
  db.prepare("UPDATE video_jobs SET generationMode = 'reference-to-video', resolution = ? WHERE id = 'h3-unknown'").run(resolution);
  db.prepare('INSERT INTO video_reference_assets VALUES (?, ?, ?, ?)').run('unknown', 'project-1', 'video', null);
  db.prepare('INSERT INTO video_job_references VALUES (?, ?, ?)').run('h3-unknown', 0, 'unknown');
  assert.equal(freeze(db, 'h3-unknown', provider), null, 'missing reference seconds cannot silently become zero cost');
  db.prepare("UPDATE video_reference_assets SET durationSec = 5, projectId = 'other-project' WHERE id = 'unknown'").run();
  assert.equal(freeze(db, 'h3-unknown', provider), null, 'foreign reference assets are not priced as valid inputs');
  db.prepare("UPDATE video_reference_assets SET projectId = 'project-1', kind = 'audio' WHERE id = 'unknown'").run();
  const audioOnly = parseUsageSnapshot(freeze(db, 'h3-unknown', provider));
  assert.equal(audioOnly.ok, true);
  if (audioOnly.ok) assert.equal(audioOnly.parsed.snapshot.videoUsage!.inputVideoDurationSec, 0);

  const identity = parsed.parsed.snapshot.provider;
  const historical = createCoreUsageSnapshot(identity, resolveCoreUsagePlan(identity)!, { refType: 'video-job', refId: 'h3-old' });
  insertJob(db, { id: 'h3-old', provider, snapshot: JSON.stringify(historical) });
  assert.equal(freeze(db, 'h3-old', provider), JSON.stringify(historical));
  assert.equal(recordVideoJobUsage(db, { jobId: 'h3-old', durationSec: 5, finishedAt: '2026-11-11' }).inserted, true);
  assert.equal((db.prepare("SELECT costMicros FROM usage_ledger WHERE refId = 'h3-old'").get() as { costMicros: number }).costMicros, 4_000_000);
  db.close();
}

console.log('usage-video-jobs tests passed');
