// node scripts/unified-channel-health.test.ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unified-channel-health-'));
const previousRoot = process.env.CREATIVE_STUDIO_DATA_ROOT;
process.env.CREATIVE_STUDIO_DATA_ROOT = root;

const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
const { checkExecutionReadiness } = await import('../lib/media-core/execution/readiness.ts');
const {
  UNIFIED_CHANNEL_BASE_COOLDOWN_MS,
  UNIFIED_CHANNEL_FAILURE_THRESHOLD,
  claimUnifiedChannelHealthForSelection,
  clearUnifiedChannelHealthAvoidance,
  listUnifiedChannelHealthDefinitions,
  readUnifiedChannelHealth,
  recordUnifiedChannelFailure,
  recordUnifiedChannelSuccess,
  unifiedChannelFailureReasonFromEvidence,
} = await import('../lib/media-core/unified-media/health.ts');
const { classifyImageSubmissionFailure } = await import('../lib/media-core/submission-evidence.ts');
const { providerHttpError } = await import('../lib/media-core/submission-evidence.ts');
const { readTeamChannelHealth, clearTeamChannelHealth } = await import('../lib/team-service/channel-health.ts');

fs.mkdirSync(path.join(root, 'data'), { recursive: true });
const db = new Database(path.join(root, 'data', 'workbench.db'));
db.pragma('foreign_keys = ON');
const readiness = await checkExecutionReadiness({ db, ...schemaUpgradeRuntimePaths(root) });
assert.equal(readiness.available, true);
assert.ok(readiness.appliedVersions.includes(9));

db.exec(`
  CREATE TABLE providers (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, baseUrl TEXT NOT NULL DEFAULT '',
    apiKey TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', type TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1, defaultCostPerImage REAL
  )
`);
db.prepare(`INSERT INTO providers (id, name, baseUrl, apiKey, model, type, enabled)
  VALUES ('company-gateway-qiniuyun-gpt-image-2-medium', '七牛 Image 2', 'https://qiniu.test', 'key', 'qiniuyun/gpt-image-2-medium', 'gateway-task-image', 1)`)
  .run();
db.prepare(`INSERT INTO providers (id, name, baseUrl, apiKey, model, type, enabled)
  VALUES ('company-gateway-image2-medium', '腾讯 Image 2', 'https://tencent.test', 'key', 'image2-medium', 'gateway-task-image', 1)`)
  .run();

const admin = { userId: 'admin', role: 'admin' as const };
const employee = { userId: 'employee', role: 'employee' as const };
const qiniu = listUnifiedChannelHealthDefinitions().find((channel) => channel.channelKey === 'qiniu')!;
const tencent = listUnifiedChannelHealthDefinitions().find((channel) => channel.channelKey === 'tencent')!;

function failureEvidence(status: number) {
  return classifyImageSubmissionFailure({
    taskId: 'job-health', businessAttemptNo: 1, adapterId: 'gateway-task-image',
    stage: 'submit', source: 'transport', error: providerHttpError(status),
  });
}

try {
  const initial = readTeamChannelHealth(db, admin);
  assert.equal(initial.failureThreshold, UNIFIED_CHANNEL_FAILURE_THRESHOLD);
  assert.equal(initial.items.length, 2);
  assert.equal(initial.items.find((item) => item.channelKey === 'qiniu')?.manualEnabled, true);
  assert.equal(initial.items.find((item) => item.channelKey === 'qiniu')?.state, 'healthy');
  assert.equal(initial.items.find((item) => item.channelKey === 'qiniu')?.version, 0);

  assert.throws(() => readTeamChannelHealth(db, employee), /管理员/);
  assert.throws(() => clearTeamChannelHealth(db, employee, {
    healthKey: 'image2:qiniu', expectedVersion: 0,
  }), /管理员/);

  const now = new Date('2026-11-11T00:00:00.000Z');
  recordUnifiedChannelSuccess(db, {
    unifiedModel: qiniu.unifiedModel, channelKey: qiniu.channelKey,
    providerId: qiniu.providerId, now,
  });
  assert.equal(readUnifiedChannelHealth(db, qiniu.unifiedModel, qiniu.channelKey)?.state, 'healthy');

  const serverFailure = failureEvidence(503);
  assert.equal(unifiedChannelFailureReasonFromEvidence(serverFailure), 'provider_server_error');
  assert.equal(unifiedChannelFailureReasonFromEvidence(failureEvidence(400)), null,
    'a single-material 400/audit rejection must not affect channel health');
  assert.equal(
    unifiedChannelFailureReasonFromEvidence(classifyImageSubmissionFailure({
      taskId: 'network', businessAttemptNo: 1, adapterId: 'gateway-task-image',
      stage: 'submit', source: 'transport', error: new TypeError('socket reset'),
    })),
    'provider_network',
  );

  for (let index = 1; index <= UNIFIED_CHANNEL_FAILURE_THRESHOLD; index += 1) {
    const record = recordUnifiedChannelFailure(db, {
      unifiedModel: qiniu.unifiedModel,
      channelKey: qiniu.channelKey,
      providerId: qiniu.providerId,
      reasonCode: 'provider_server_error',
      now: new Date(now.getTime() + index * 1_000),
    });
    if (index < UNIFIED_CHANNEL_FAILURE_THRESHOLD) assert.equal(record.state, 'healthy');
    else {
      assert.equal(record.state, 'avoided');
      assert.equal(record.reasonCode, 'provider_server_error');
      assert.ok(Date.parse(record.avoidUntil!) >= now.getTime() + UNIFIED_CHANNEL_BASE_COOLDOWN_MS);
    }
  }
  const avoided = readTeamChannelHealth(db, admin).items.find((item) => item.channelKey === 'qiniu')!;
  assert.equal(avoided.state, 'avoided');
  assert.equal(avoided.reasonLabel, '上游连续返回服务错误');
  assert.equal(avoided.canClear, true);

  assert.equal(claimUnifiedChannelHealthForSelection(db, {
    unifiedModel: qiniu.unifiedModel, channelKey: qiniu.channelKey, providerId: qiniu.providerId,
    now: new Date(now.getTime() + 1_000),
  }), false, 'avoided channel must not be selected before cooling down');

  const due = new Date(Date.parse(avoided.avoidUntil!) + 1_000);
  assert.equal(claimUnifiedChannelHealthForSelection(db, {
    unifiedModel: qiniu.unifiedModel, channelKey: qiniu.channelKey, providerId: qiniu.providerId,
    now: due,
  }), true);
  assert.equal(readUnifiedChannelHealth(db, qiniu.unifiedModel, qiniu.channelKey)?.state, 'recovering');
  assert.equal(claimUnifiedChannelHealthForSelection(db, {
    unifiedModel: qiniu.unifiedModel, channelKey: qiniu.channelKey, providerId: qiniu.providerId,
    now: new Date(due.getTime() + 1_000),
  }), false, 'only one ordinary task may act as a recovery probe');
  recordUnifiedChannelSuccess(db, {
    unifiedModel: qiniu.unifiedModel, channelKey: qiniu.channelKey,
    providerId: qiniu.providerId, now: new Date(due.getTime() + 2_000),
  });
  assert.equal(readUnifiedChannelHealth(db, qiniu.unifiedModel, qiniu.channelKey)?.state, 'healthy');

  const auditRows = db.prepare(`SELECT action, reasonCode FROM execution_media_channel_health_events
    WHERE healthKey = ? ORDER BY rowid`).all(`${qiniu.unifiedModel}:${qiniu.channelKey}`) as Array<{
      action: string; reasonCode: string | null;
    }>;
  assert.ok(auditRows.some((row) => row.action === 'system_avoid'));
  assert.ok(auditRows.some((row) => row.action === 'recovery_probe_claimed'));
  assert.ok(auditRows.some((row) => row.action === 'recovered_by_success'));

  const tencentSuccess = recordUnifiedChannelSuccess(db, {
    unifiedModel: tencent.unifiedModel, channelKey: tencent.channelKey,
    providerId: tencent.providerId, now,
  });
  const cleared = clearTeamChannelHealth(db, admin, {
    healthKey: tencentSuccess.healthKey,
    expectedVersion: tencentSuccess.version,
    now: new Date(now.getTime() + 5_000),
  });
  assert.equal(cleared.state, 'healthy');
  assert.equal(cleared.version, tencentSuccess.version + 1);
  assert.throws(() => clearTeamChannelHealth(db, admin, {
    healthKey: cleared.healthKey,
    expectedVersion: tencentSuccess.version,
  }), /版本/);

  db.prepare("UPDATE providers SET enabled = 0 WHERE id = ?").run(qiniu.providerId);
  clearUnifiedChannelHealthAvoidance(db, {
    unifiedModel: qiniu.unifiedModel, channelKey: qiniu.channelKey,
    providerId: qiniu.providerId, actorId: 'admin', expectedVersion:
      readUnifiedChannelHealth(db, qiniu.unifiedModel, qiniu.channelKey)!.version,
  });
  assert.equal(
    db.prepare('SELECT enabled FROM providers WHERE id = ?').pluck().get(qiniu.providerId),
    0,
    'system recovery must never re-enable the provider manually disabled by an administrator',
  );
  assert.equal(
    readTeamChannelHealth(db, admin).items.find((item) => item.channelKey === 'qiniu')?.manualEnabled,
    false,
  );

  console.log('unified channel health tests passed (paid calls: 0)');
} finally {
  db.close();
  if (previousRoot === undefined) delete process.env.CREATIVE_STUDIO_DATA_ROOT;
  else process.env.CREATIVE_STUDIO_DATA_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
}
