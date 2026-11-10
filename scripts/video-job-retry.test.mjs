import assert from 'node:assert/strict';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import ts from 'typescript';

// Execute the actual route with an in-memory DB and a queue stub; never submit paid jobs.
const db = new Database(':memory:');
db.exec(`CREATE TABLE video_jobs (
  id TEXT PRIMARY KEY, projectId TEXT, status TEXT, providerStatus TEXT,
  providerTaskId TEXT, providerRawResponse TEXT, remoteVideoUrl TEXT, localVideoPath TEXT,
  lastPolledAt TEXT, pollCount INTEGER, startedAt TEXT, finishedAt TEXT,
  attempt INTEGER, errorMessage TEXT, usageSnapshotJson TEXT, executionRevision INTEGER DEFAULT 0,
  model TEXT, multiShot INTEGER, prompt TEXT, sourceImageId TEXT, tailImageId TEXT, durationSec INTEGER,
  unifiedModel TEXT, unifiedRuleVersion TEXT, unifiedTaskId TEXT, unifiedGenerationId TEXT,
  unifiedRequestJson TEXT, cancelRequestedAt TEXT
); CREATE TABLE projects (id TEXT PRIMARY KEY, videoConcurrency INTEGER);`);
db.prepare('INSERT INTO projects VALUES (?, ?)').run('project', 3);
const logs = [];
let queueStarts = 0;
const deps = {
  'next/server': { NextResponse: { json: (body, init) => Response.json(body, init) } },
  '@/lib/db': { getDb: () => db },
  '@/lib/logger': { writeLog: (entry) => logs.push(entry) },
  '@/lib/video-queue': {
    getVideoQueueStatus: () => 'idle',
    runVideoQueue: async () => { queueStarts += 1; },
    DEFAULT_VIDEO_CONCURRENCY: 10, DEFAULT_VIDEO_TIMEOUT_MS: 60_000,
  },
  '@/lib/team-service/config': {
    readRuntimeConfig: () => ({ mode: 'local' }),
  },
  '@/lib/team-service/production-defaults': {
    productionParamsFor: (_config, input) => ({
      videoConcurrency: Number(input?.videoConcurrency) || 10,
    }),
  },
  // local 部署下 wrapper 原样调用 handler；本测试不进入 server 身份路径。
  '@/lib/team-service/route-wrapper': { withTeamRoute: (_route, _method, handler) => handler },
};
const source = fs.readFileSync('app/api/video-jobs/[id]/retry/route.ts', 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const route = { exports: {} };
new Function('require', 'module', 'exports', compiled)((id) => {
  assert.ok(deps[id], `Unexpected dependency: ${id}`);
  return deps[id];
}, route, route.exports);

function fixture(id, overrides = {}) {
  const row = {
    id, projectId: 'project', status: 'failed', providerStatus: 'failed', providerTaskId: 'old-remote',
    providerRawResponse: '{"status":"failed"}', remoteVideoUrl: null, localVideoPath: null,
    lastPolledAt: 'old-time', pollCount: 7, startedAt: 'old-time', finishedAt: 'old-time',
    attempt: 4, errorMessage: "shot_type value 'intelligent' is invalid", usageSnapshotJson: '{}', executionRevision: 0,
    model: 'qiniuyun/kling-3.0', multiShot: 1, prompt: 'frozen prompt',
    sourceImageId: 'first-frame', tailImageId: 'last-frame', durationSec: 5,
    unifiedModel: 'kling-3.0', unifiedRuleVersion: 'unified-media-2026-11-10-v1',
    unifiedTaskId: 'old-unified-parent', unifiedGenerationId: 'old-generation',
    unifiedRequestJson: '{"frozen":true}', cancelRequestedAt: 'old-cancel',
    ...overrides,
  };
  db.prepare(`INSERT INTO video_jobs (${Object.keys(row)}) VALUES (${Object.keys(row).map(() => '?')})`).run(...Object.values(row));
  return row;
}
const retry = (id) => route.exports.POST(null, { params: Promise.resolve({ id }) });
const read = (id) => db.prepare('SELECT * FROM video_jobs WHERE id=?').get(id);

try {
  const before = fixture('terminal-failed');
  assert.equal((await retry(before.id)).status, 200);
  const after = read(before.id);
  assert.equal(after.providerTaskId, null, 'manual retry of a confirmed remote failure must submit a new task, not poll the old failure');
  assert.equal(after.status, 'pending');
  assert.equal(after.errorMessage, null);
  assert.equal(after.providerStatus, null);
  assert.equal(after.providerRawResponse, null);
  assert.equal(after.lastPolledAt, null);
  assert.equal(after.finishedAt, null);
  assert.equal(after.pollCount, 0);
  assert.equal(after.attempt, 0);
  assert.equal(after.usageSnapshotJson, null, 'a new paid task must re-freeze its own usage snapshot before submit');
  assert.equal(after.executionRevision, 1, 'confirmed manual resubmit must create a new execution operation revision');
  assert.equal(after.unifiedTaskId, null, 'a new unified generation gets a new logical task');
  assert.equal(after.unifiedGenerationId, null, 'a new unified generation gets a fresh task key turn');
  assert.equal(after.cancelRequestedAt, null);
  assert.equal(after.unifiedModel, before.unifiedModel);
  assert.equal(after.unifiedRequestJson, before.unifiedRequestJson);
  for (const key of ['model', 'multiShot', 'prompt', 'sourceImageId', 'tailImageId', 'durationSec']) {
    assert.equal(after[key], before[key], `retry must preserve frozen ${key}`);
  }
  assert.ok(logs.some((entry) => entry.jobId === before.id && entry.message.includes('old-remote')));
  assert.equal(queueStarts, 1);
  assert.equal((await retry(before.id)).status, 400, 'duplicate clicks cannot enqueue another retry');
  assert.equal(queueStarts, 1);

  for (const [id, overrides] of [
    ['unknown', { providerStatus: 'unknown' }],
    ['timeout', { providerStatus: 'needs_check' }],
    ['canceled', { status: 'canceled', providerStatus: 'running' }],
    ['completed', { providerStatus: 'succeeded', remoteVideoUrl: 'https://example.com/video.mp4' }],
    ['output-exists', { localVideoPath: '/local/video.mp4' }],
  ]) {
    const old = fixture(id, overrides);
    assert.equal((await retry(id)).status, 200);
    const current = read(id);
    assert.equal(current.providerTaskId, old.providerTaskId, `${id}: must resume existing task to avoid duplicate generation`);
    assert.equal(current.providerRawResponse, old.providerRawResponse);
    assert.equal(current.usageSnapshotJson, old.usageSnapshotJson, `${id}: resuming the same task keeps its frozen usage snapshot`);
  }
  const neverSubmitted = fixture('never-submitted', { providerTaskId: null, providerStatus: null });
  assert.equal((await retry('never-submitted')).status, 200);
  assert.equal(read('never-submitted').providerTaskId, null);
  assert.equal(read('never-submitted').executionRevision, neverSubmitted.executionRevision + 1,
    'a retry after terminal submission failure must create a new execution operation');
  const downloadOnly = fixture('download-only-no-task', {
    providerTaskId: null, providerStatus: 'download_failed', remoteVideoUrl: 'https://example.com/video.mp4',
    executionRevision: 4,
  });
  assert.equal((await retry(downloadOnly.id)).status, 200);
  assert.equal(read(downloadOnly.id).executionRevision, downloadOnly.executionRevision,
    'download-only recovery must keep the original execution operation');
  fixture('running', { status: 'running' });
  assert.equal((await retry('running')).status, 400);
  assert.equal((await retry('missing')).status, 404);
  console.log('video job retry tests passed');
} finally {
  db.close();
}
