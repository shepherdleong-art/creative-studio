import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

/**
 * 退避名单不能截断:超过 64 个任务同时延期时,刚延期的任务不得立即重新
 * 领取并再次 defer(否则一个执行位会在微任务链里空转,定时器和关闭都得不到
 * 执行机会)。使用最小内存库隔离调度循环,不触发媒体、供应商或真实文件。
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm7-batch-backoff-overflow-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
process.env.CREATIVE_STUDIO_DEPLOYMENT_MODE = 'local';
const { startBatchScheduler } = await import('../lib/batch-production/runner.ts');

const db = new Database(':memory:');
const stop = new AbortController();
let scheduler: ReturnType<typeof startBatchScheduler> | undefined;

try {
  db.exec(`
    CREATE TABLE batch_productions (id TEXT PRIMARY KEY, controlState TEXT, deletedAt TEXT, progressJson TEXT, updatedAt TEXT);
    CREATE TABLE batch_tasks (id TEXT PRIMARY KEY, batchId TEXT, projectId TEXT, workType TEXT, targetKind TEXT, targetId TEXT, attemptCount INTEGER DEFAULT 0, status TEXT, expectedState TEXT, progressJson TEXT, createdAt TEXT, updatedAt TEXT, requestKey TEXT);
    CREATE TABLE batch_task_attempts (id TEXT PRIMARY KEY, taskId TEXT, attemptNumber INTEGER, status TEXT, claimedBy TEXT, leaseExpiresAt TEXT, heartbeatAt TEXT, startedAt TEXT, createdAt TEXT, finishedAt TEXT, resultJson TEXT, progressJson TEXT, errorCode TEXT, errorMessage TEXT);
    CREATE TABLE batch_output_versions (id TEXT, planId TEXT);
    CREATE TABLE batch_output_plans (id TEXT, scriptSnapshotId TEXT, currentVersionId TEXT);
    INSERT INTO batch_productions VALUES ('batch', 'running', NULL, '{}', '2026-11-14');
  `);
  const insert = db.prepare(`
    INSERT INTO batch_tasks (
      id, batchId, projectId, workType, targetKind, targetId, status, expectedState, createdAt, updatedAt
    ) VALUES (?, 'batch', 'project', 'narration', 'script_snapshot', 'snapshot', 'queued', 'running', ?, ?)
  `);
  for (let index = 0; index < 65; index += 1) {
    const id = String(index).padStart(3, '0');
    insert.run(id, id, id);
  }

  const calls = new Map<string, number[]>();
  let executorCalls = 0;
  const startedAt = Date.now();
  scheduler = startBatchScheduler({
    db,
    workerId: 'review-overflow',
    concurrency: 1,
    intervalMs: 10,
    idlePollMs: 20,
    signal: stop.signal,
    log() {},
    executors: [{
      workTypes: ['narration'],
      async execute({ claim }) {
        const times = calls.get(claim.task.id) ?? [];
        times.push(Date.now());
        calls.set(claim.task.id, times);
        executorCalls += 1;
        throw Object.assign(new Error('wait'), {
          code: 'llm_execution_deferred',
          operationId: 'fake',
          waitReason: 'pool_capacity',
        });
      },
    }],
  });

  // 观察窗覆盖第一轮 + 至少两轮 500ms 准入退避;超时只作看门狗。
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  await scheduler.stop();
  scheduler = undefined;
  const elapsedMs = Date.now() - startedAt;

  assert.equal(calls.size, 65, `65 个任务都必须被领取一次,实际 ${calls.size}`);
  assert.ok(executorCalls < 65 * 6, `延期任务不得空转,实际执行 ${executorCalls} 次`);
  const tooShortGaps: Array<{ taskId: string; gapMs: number }> = [];
  for (const [taskId, times] of calls) {
    for (let index = 1; index < times.length; index += 1) {
      const gapMs = times[index]! - times[index - 1]!;
      if (gapMs < 400) tooShortGaps.push({ taskId, gapMs });
    }
  }
  assert.deepEqual(
    tooShortGaps,
    [],
    `延期任务不得在退避期内被重领: ${JSON.stringify(tooShortGaps.slice(0, 5))}`,
  );
  console.log(
    `batch backoff overflow: 65 tasks, ${executorCalls} executor calls in ${elapsedMs}ms, no immediate re-claim`,
  );
} finally {
  stop.abort();
  await scheduler?.stop();
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}
