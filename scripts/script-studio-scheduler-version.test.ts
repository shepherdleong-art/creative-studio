import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';
import type { ScriptStudioSchedulerController } from '../lib/script-studio/scheduler.ts';

// lib/script-providers/index.ts 里有不带 .ts 后缀的相对导入，先注册补后缀的解析器，再动态导入业务模块。
register('./typescript-extension-loader.mjs', import.meta.url);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'script-studio-scheduler-version-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = tempRoot;
process.env.CREATIVE_STUDIO_SCRIPT_STUDIO_ENABLE_SCHEDULER = '1';

const [{ closeDb, getDb }, { ensureScriptStudioSchemaReady }, bootstrap, schedulerModule] = await Promise.all([
  import('../lib/db.ts'),
  import('../lib/script-studio/schema.ts'),
  import('../lib/script-studio/bootstrap.ts'),
  import('../lib/script-studio/scheduler.ts'),
]);

await ensureScriptStudioSchemaReady({
  db: getDb(),
  backupRoot: path.join(tempRoot, 'backups'),
});

const globalScope = globalThis as Record<PropertyKey, unknown>;
let staleStopCount = 0;
const staleScheduler: ScriptStudioSchedulerController = {
  async stop() { staleStopCount += 1; },
  async runPendingOnce() { return 0; },
  requestCancel() { return false; },
};
globalScope[schedulerModule.SCRIPT_STUDIO_SCHEDULER_KEY] = staleScheduler;
const versionKey = Symbol.for('creative-studio.script-studio-scheduler-version');
globalScope[versionKey] = 28; // 上一版闭包不能绕过新的模板恢复与白名单规则。

try {
  const refreshed = await bootstrap.ensureScriptStudioSchedulerStarted();
  assert.notEqual(
    refreshed,
    staleScheduler,
    '执行器代码升级后不得继续复用旧全局调度器，否则新任务快照会显示 Gemini/Mimo、实际请求仍走旧 Luna 绑定',
  );
  assert.equal(staleStopCount, 1, '替换旧调度器前必须先停止它，避免两个调度器争抢任务');
  assert.equal(
    await bootstrap.ensureScriptStudioSchedulerStarted(),
    refreshed,
    '同一执行器版本内必须继续复用当前调度器',
  );
  await refreshed.stop();

  // 同一 scheduler 的 interval 与手动 wake 可并发触发；单轮必须互斥，活跃数仍受 concurrency 限制。
  const db = getDb();
  db.prepare(`INSERT OR IGNORE INTO providers (id, name, baseUrl) VALUES ('tick-provider', 'tick', 'https://example.invalid')`).run();
  db.prepare(`
    INSERT OR IGNORE INTO projects (id, name, providerId, model, prompt)
    VALUES ('tick-project', 'tick', 'tick-provider', 'fixture', '')
  `).run();
  const at = new Date().toISOString();
  for (let index = 0; index < 4; index += 1) {
    db.prepare(`
      INSERT INTO script_studio_tasks
        (id, projectId, requestKey, mode, inputSnapshotJson, requestedCount, status, createdAt, updatedAt)
      VALUES (?, 'tick-project', ?, 'reuse', '{}', 1, 'queued', ?, ?)
    `).run(`tick-task-${index}`, `tick-request-${index}`, at, at);
  }
  let active = 0;
  let maxActive = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const ticking = schedulerModule.startScriptStudioScheduler({
    db,
    workerId: 'tick-worker',
    concurrency: 2,
    intervalMs: 60_000,
    executor: {
      async execute() {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await gate;
        active -= 1;
        db.prepare(`UPDATE script_studio_tasks SET status = 'succeeded' WHERE status = 'running'`).run();
      },
    },
  });
  const firstRound = ticking.runPendingOnce();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(active, 2);
  assert.equal(await ticking.runPendingOnce(), 0, '重叠 tick 不得再开一轮 worker pool');
  assert.equal(maxActive, 2, 'interval/手动 tick 并发不得突破真实活跃上限');
  release();
  assert.equal(await firstRound, 4);
  await ticking.stop();

  db.prepare(`
    INSERT INTO script_studio_tasks
      (id, projectId, requestKey, mode, inputSnapshotJson, requestedCount, status, errorCode, attemptCount, createdAt, updatedAt)
    VALUES ('tick-deferred', 'tick-project', 'tick-deferred', 'reuse', '{}', 1, 'queued', 'execution_deferred', 1, ?, ?)
  `).run(at, at);
  const resumed = schedulerModule.claimNextScriptStudioTask(db, { workerId: 'resume-worker' });
  assert.equal(resumed?.task.attemptCount, 1, 'deferred 续跑不得增加业务 attempt');

  db.prepare(`UPDATE script_studio_tasks SET status = 'queued', errorCode = 'execution_deferred', leaseUntil = NULL WHERE id = 'tick-deferred'`).run();
  let deferredExecutions = 0;
  const deferring = schedulerModule.startScriptStudioScheduler({
    db,
    workerId: 'deferred-worker',
    intervalMs: 60_000,
    executor: {
      async execute(task) {
        deferredExecutions += 1;
        if (deferredExecutions > 1) {
          db.prepare(`UPDATE script_studio_tasks SET status = 'cancelled', errorCode = 'test_stop' WHERE id = ?`).run(task.id);
          return;
        }
        db.prepare(`UPDATE script_studio_tasks SET status = 'queued', errorCode = 'execution_deferred', leaseUntil = NULL WHERE id = ?`).run(task.id);
      },
    },
  });
  assert.equal(await deferring.runPendingOnce(), 1, 'deferred 必须让出当前 slot，等待下一次 tick');
  assert.equal(deferredExecutions, 1, '同一轮不得立刻重领 deferred 任务形成 tight loop');
  await deferring.stop();
} finally {
  delete globalScope[schedulerModule.SCRIPT_STUDIO_SCHEDULER_KEY];
  delete globalScope[versionKey];
  closeDb();
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log('script-studio-scheduler-version.test.ts: ok');
