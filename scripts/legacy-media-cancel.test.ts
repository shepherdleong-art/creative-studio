import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';

// 老通道取消契约：已受理只写取消意图、未受理立即取消、历史孤儿可被修复。
// 只碰隔离 SQLite，不发起任何供应商请求。
register('./typescript-extension-loader.mjs', import.meta.url);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-media-cancel-'));
const previousEnv = { ...process.env };
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
process.env.CREATIVE_STUDIO_DEPLOYMENT_MODE = 'local';

const { getDb, closeDb } = await import('../lib/db.ts');
const {
  applyLegacyVideoJobCancel,
  applyLegacyVideoQueueCancelIntents,
  repairLegacyCanceledMediaJobs,
} = await import('../lib/legacy-media-cancel.ts');

try {
  const db = getDb();
  const now = new Date().toISOString();

  db.prepare(`INSERT INTO video_providers (
    id, name, type, baseUrlEnv, apiKeyEnv, modelEnv, defaultModel, enabled, baseUrl, apiKey
  ) VALUES ('vp', 'vp', 'openai-video', '', '', '', 'kling-2.5', 1, 'https://example.test', 'key')`).run();
  db.prepare(`INSERT INTO providers (id, name, baseUrl, apiKeyEnv, apiKey, model, type, enabled)
    VALUES ('ip', 'ip', 'https://example.test', '', 'key', 'image2', 'gateway-task-image', 1)`).run();
  db.prepare(`INSERT INTO projects (id, name, providerId, model, prompt)
    VALUES ('project', 'project', 'ip', 'image2', 'prompt')`).run();
  db.prepare(`INSERT INTO image_assets (id, projectId, role, filename, path, mimeType)
    VALUES ('input', 'project', 'input', 'input.png', ?, 'image/png')`).run(path.join(root, 'input.png'));

  function videoJob(id: string, overrides: {
    status?: string;
    providerTaskId?: string | null;
    providerStatus?: string | null;
    cancelRequestedAt?: string | null;
    localVideoPath?: string | null;
    finishedAt?: string | null;
  } = {}): void {
    db.prepare(`INSERT INTO video_jobs (
      id, projectId, sourceImageId, providerId, model, prompt, durationSec, status,
      providerTaskId, providerStatus, cancelRequestedAt, localVideoPath, finishedAt, createdAt
    ) VALUES (?, 'project', 'input', 'vp', 'kling-2.5', 'prompt', 5, ?, ?, ?, ?, ?, ?, ?)`).run(
      id,
      overrides.status ?? 'running',
      overrides.providerTaskId ?? null,
      overrides.providerStatus ?? null,
      overrides.cancelRequestedAt ?? null,
      overrides.localVideoPath ?? null,
      overrides.finishedAt ?? null,
      now,
    );
  }
  const read = (id: string) => db.prepare(`SELECT status, cancelRequestedAt, errorMessage, finishedAt
    FROM video_jobs WHERE id = ?`).get(id) as {
      status: string; cancelRequestedAt: string | null; errorMessage: string | null; finishedAt: string | null;
    };

  // 1) 已受理：只写意图，状态保持 running，供队列继续只读收尾
  videoJob('accepted', { status: 'running', providerTaskId: 'remote-1', providerStatus: 'submitted' });
  {
    const result = applyLegacyVideoJobCancel(db, 'accepted');
    assert.equal(result?.acceptedSubmittedWork, true);
    assert.equal(result?.idempotent, false);
    const row = read('accepted');
    assert.equal(row.status, 'running', '已受理任务取消后必须保持 running，交给队列收尾');
    assert.ok(row.cancelRequestedAt, '必须写取消意图');
    assert.equal(row.finishedAt, null, '收尾未完成前不能写 finishedAt');
    assert.match(row.errorMessage ?? '', /收尾|保留/);
  }

  // 2) 重复取消幂等，不覆盖首次意图时间
  {
    const first = read('accepted').cancelRequestedAt;
    const again = applyLegacyVideoJobCancel(db, 'accepted');
    assert.equal(again?.idempotent, true);
    assert.equal(read('accepted').cancelRequestedAt, first);
  }

  // 3) 未受理：立即 canceled + 意图
  videoJob('pending', { status: 'pending' });
  {
    const result = applyLegacyVideoJobCancel(db, 'pending');
    assert.equal(result?.acceptedSubmittedWork, false);
    const row = read('pending');
    assert.equal(row.status, 'canceled');
    assert.ok(row.cancelRequestedAt);
  }

  // 4) 已终态不写意图
  videoJob('succeeded', { status: 'succeeded', providerTaskId: 'remote-2', providerStatus: 'succeeded' });
  {
    assert.equal(applyLegacyVideoJobCancel(db, 'succeeded')?.idempotent, true);
    assert.equal(read('succeeded').cancelRequestedAt, null);
  }

  // 5) 未知任务返回 null
  assert.equal(applyLegacyVideoJobCancel(db, 'missing'), null);

  // 6) 项目级取消覆盖已受理与尚未提交任务，已受理保持收尾
  videoJob('q-accepted', { status: 'running', providerTaskId: 'remote-3', providerStatus: 'submitted' });
  videoJob('q-unsent', { status: 'pending' });
  {
    const changed = applyLegacyVideoQueueCancelIntents(db, 'project');
    assert.equal(changed, 2, '已受理和未提交任务都应写取消意图');
    assert.ok(read('q-accepted').cancelRequestedAt);
    assert.ok(read('q-unsent').cancelRequestedAt);
    assert.equal(read('q-unsent').status, 'canceled');
  }

  // 7) 历史孤儿修复：已取消但没意图的活任务补上意图，终态的不动
  videoJob('orphan', {
    status: 'canceled', providerTaskId: 'remote-4', providerStatus: 'submitted',
    finishedAt: '2026-11-11 10:10:36',
  });
  videoJob('orphan-terminal', {
    status: 'canceled', providerTaskId: 'remote-5', providerStatus: 'failed',
  });
  db.prepare(`INSERT INTO jobs (id, projectId, inputImageId, providerId, model, prompt, status,
      providerTaskId, providerStatus, cancelRequestedAt, finishedAt, createdAt)
    VALUES ('orphan-image', 'project', 'input', 'ip', 'image2', 'prompt', 'canceled',
      'remote-6', 'submitted', NULL, '2026-11-11 10:10:36', ?)`).run(now);
  {
    const repaired = repairLegacyCanceledMediaJobs(db);
    assert.equal(repaired.video, 1, '只有仍持远端身份的已取消视频任务需要修复');
    assert.equal(repaired.image, 1);

    const orphan = read('orphan');
    assert.ok(orphan.cancelRequestedAt, '孤儿任务必须补上取消意图，队列才能续跑');
    assert.equal(orphan.finishedAt, null, '清空 finishedAt，让续跑领取条件命中');
    assert.equal(read('orphan-terminal').cancelRequestedAt, null, '远端已终态的不修复');
    assert.ok(db.prepare(`SELECT cancelRequestedAt FROM jobs WHERE id = 'orphan-image'`).pluck().get());

    // 幂等：再跑一次不重复修改
    assert.deepEqual(repairLegacyCanceledMediaJobs(db), { video: 0, image: 0 });
  }

  // 8) 修复后的孤儿满足续跑条件：canceled + 意图 + 远端身份非终态
  {
    const eligible = db.prepare(`SELECT COUNT(*) FROM video_jobs
      WHERE id = 'orphan' AND status = 'canceled' AND cancelRequestedAt IS NOT NULL
        AND providerTaskId IS NOT NULL
        AND COALESCE(providerStatus, '') NOT IN ('succeeded', 'failed', 'not_created')`).pluck().get();
    assert.equal(eligible, 1);
  }

  // 9) 任务中心的显示口径：执行记录仍停在 accepted、业务行已取消且有取消意图时，
  //    必须显示「已取消」。这正是线上那条任务卡了三小时的状态——只改业务行不改执行记录时，
  //    列表一直取 o.status 就会永远显示「供应商已受理」。
  {
    const { checkTeamServiceReadiness } = await import('../lib/team-service/readiness.ts');
    const { checkExecutionReadiness } = await import('../lib/media-core/execution/readiness.ts');
    const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
    const shared = { db, ...schemaUpgradeRuntimePaths(root) };
    assert.equal((await checkTeamServiceReadiness(shared)).available, true);
    assert.equal((await checkExecutionReadiness(shared)).available, true);

    const { listTeamTasks } = await import('../lib/team-service/tasks.ts');
    db.prepare(`INSERT INTO team_users (id, employeeId, displayName, role, status, passwordHash, createdAt, updatedAt)
      VALUES ('member', 'member', 'member', 'employee', 'active', 'hash', ?, ?)`).run(now, now);
    db.prepare(`INSERT INTO team_resource_scopes (resourceType, resourceId, ownerUserId, rootType, rootId, createdAt, updatedAt)
      VALUES ('project', 'project', 'member', 'project', 'project', ?, ?)`).run(now, now);
    db.prepare(`INSERT INTO execution_operations (id, module, taskId, step, operationKey, actorId,
        scopeType, scopeId, status, inputRevision, inputHash, continuationKey,
        businessAttemptId, businessAttemptNo, inputSnapshotJson, providerSnapshotJson,
        requiredPoolsJson, quoteJson, configVersion, readySeq, createdAt, updatedAt)
      VALUES ('op-stuck', 'video', 'orphan', 'submit', 'video/orphan/submit/r0', 'member',
        'project', 'project', 'accepted', 'r0', 'hash', 'legacy-video.submit',
        'orphan:r0', 1, '{}', '{}', '[]', '{}', 'v', 1, ?, ?)`).run(now, now);

    const stuck = listTeamTasks(db, { userId: 'member', role: 'employee' }, {}, { page: 1, pageSize: 25 })
      .items.find((item) => item.taskId === 'orphan');
    assert.ok(stuck, '任务列表应包含这条已取消任务');
    assert.equal(stuck!.status, 'canceled',
      '执行记录仍 accepted 但业务行已取消且有取消意图时，任务中心必须显示已取消');
  }

  console.log('legacy media cancel tests passed');
} finally {
  closeDb();
  process.env = previousEnv;
  fs.rmSync(root, { recursive: true, force: true });
}
