import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { register } from 'node:module';

register('./typescript-extension-loader.mjs', import.meta.url);
const { createFinalEditExecutionLifecycle } = await import('../lib/final-edit/lifecycle.ts');

const db = new Database(':memory:');
const events: string[] = [];
const lifecycle = createFinalEditExecutionLifecycle(db, {
  recoverPrepare: () => { events.push('recover-prepare'); },
  wakeWorker: () => { events.push('wake-render-worker'); },
});
await lifecycle.start({
  deploymentId: 'startup-test', instanceId: 'startup-test', fence: 1,
  signal: new AbortController().signal,
});
assert.deepEqual(events, ['recover-prepare', 'wake-render-worker'], 'server 启动必须主动恢复 prepare 并唤醒 render，不依赖页面');

const controller = new AbortController();
controller.abort();
await lifecycle.start({
  deploymentId: 'startup-test', instanceId: 'startup-test', fence: 1,
  signal: controller.signal,
});
assert.deepEqual(events, ['recover-prepare', 'wake-render-worker'], '停机屏障后不得领取恢复工作');

db.close();
console.log('final edit startup recovery: prepare/render start without page and shutdown barrier passed');
