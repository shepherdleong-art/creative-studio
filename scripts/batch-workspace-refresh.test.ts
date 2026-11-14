import assert from 'node:assert/strict';
import { createRefreshCoordinator, type WorkspaceRefreshRequest } from '../components/batch-production/workspace-refresh.ts';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => { resolve = settle; });
  return { promise, resolve };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// 同类请求最多一个在途:并发 refresh 只允许一个 worker 真正执行,
// 后到的请求合并成一次「尾随刷新」,且两次 await 都要等到最终状态。
{
  const first = deferred();
  const second = deferred();
  const requests: WorkspaceRefreshRequest[] = [];
  let active = 0;
  let maxActive = 0;
  const coordinator = createRefreshCoordinator(async (request) => {
    requests.push(request);
    active += 1;
    maxActive = Math.max(maxActive, active);
    if (requests.length === 1) await first.promise;
    else await second.promise;
    active -= 1;
  });
  coordinator.setActiveBatch('b1');
  const firstRun = coordinator.refresh('b1');
  const secondRun = coordinator.refresh('b1');
  await tick();
  assert.equal(requests.length, 1, '第二个同类请求必须等待在途请求,不能并发');
  assert.equal(maxActive, 1);
  first.resolve();
  await tick();
  assert.equal(requests.length, 2, '在途请求结束后必须补跑一次刷新');
  assert.equal(maxActive, 1, '同一时刻只能有一个在途请求');
  assert.ok(requests[1].generation > requests[0].generation, '每次真正执行的请求都要拿到更新的 generation');
  assert.equal(requests[1].isCurrent(), true);
  second.resolve();
  await Promise.all([firstRun, secondRun]);
}

// 切批次后到达的旧响应必须被忽略:请求记录发起时的 batchId/generation,
// 响应回来时再核对当前活动批次。
{
  const first = deferred();
  const second = deferred();
  const applied: string[] = [];
  const coordinator = createRefreshCoordinator(async (request) => {
    if (request.batchId === 'b1') {
      await first.promise;
      if (request.isCurrent()) applied.push('b1');
      return;
    }
    await second.promise;
    if (request.isCurrent()) applied.push('b2');
  });
  coordinator.setActiveBatch('b1');
  const b1Run = coordinator.refresh('b1');
  await tick();
  coordinator.setActiveBatch('b2');
  const b2Run = coordinator.refresh('b2');
  first.resolve();
  await tick();
  assert.deepEqual(applied, [], '旧批次的响应不得被应用');
  second.resolve();
  await Promise.all([b1Run, b2Run]);
  assert.deepEqual(applied, ['b2'], '只有当前批次的响应可以落状态');
}

// 切批次后,旧 batchId 的迟到刷新也不能把活动批次改回去。
{
  const applied: string[] = [];
  const coordinator = createRefreshCoordinator(async (request) => {
    if (request.isCurrent()) applied.push(request.batchId);
  });
  coordinator.setActiveBatch('b1');
  await coordinator.refresh('b1');
  coordinator.setActiveBatch('b2');
  await coordinator.refresh('b1');
  await coordinator.refresh('b2');
  assert.deepEqual(applied, ['b1', 'b2'], '显式用旧 batchId 刷新时,响应仍按当前活动批次核对');
}

console.log('batch workspace refresh coordinator tests passed');
