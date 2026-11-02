import assert from 'node:assert/strict';

process.env.CREATIVE_STUDIO_MEDIA_CONCURRENCY = '2';

const {
  getMediaResourceSnapshot,
  MediaResourceDeferredError,
  withMediaResource,
} = await import('../lib/media-core/media-resource-gate.ts');

let releaseFirst!: () => void;
let releaseSecond!: () => void;
const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
let nestedValue = 0;
const first = withMediaResource({ taskId: 'batch-render', wait: true }, async () => {
  nestedValue = await withMediaResource({ taskId: 'frame-extract', wait: false }, async () => 42);
  await firstGate;
});
const second = withMediaResource({ taskId: 'final-edit-prepare', wait: true }, () => secondGate);
await new Promise((resolve) => setTimeout(resolve, 10));
assert.equal(getMediaResourceSnapshot().active, 2, '批量与单条必须竞争同一实测容量');
assert.equal(nestedValue, 42, '已授权调用栈内的抽帧/渲染不得重复申请导致嵌套死锁');

await assert.rejects(
  withMediaResource({ taskId: 'lazy-preview', wait: false }, async () => undefined),
  (error: unknown) => error instanceof MediaResourceDeferredError
    && (error as { code?: string }).code === 'media_resource_deferred',
);
assert.equal(getMediaResourceSnapshot().active, 2);

const controller = new AbortController();
const waiting = withMediaResource({ taskId: 'packaging', wait: true, signal: controller.signal }, async () => undefined);
controller.abort();
await assert.rejects(waiting, { name: 'AbortError' });
assert.equal(getMediaResourceSnapshot().queued, 0, '取消等待不得遗留队列项');

let thirdRan = false;
const third = withMediaResource({ taskId: 'proxy', wait: true }, async () => { thirdRan = true; });
releaseFirst();
await first;
await third;
assert.equal(thirdRan, true, '释放后 FIFO 等待任务应获得授权');
releaseSecond();
await second;
assert.equal(getMediaResourceSnapshot().active, 0);
assert.equal(getMediaResourceSnapshot().capacity, 2);

console.log('media resource gate: shared capacity, nested lease, deferred, cancellation and FIFO passed');
