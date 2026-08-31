import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ScriptStudioSchedulerController } from '../lib/script-studio/scheduler.ts';

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
} finally {
  delete globalScope[schedulerModule.SCRIPT_STUDIO_SCHEDULER_KEY];
  closeDb();
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log('script-studio-scheduler-version.test.ts: ok');
