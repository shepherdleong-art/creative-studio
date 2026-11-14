import assert from 'node:assert/strict';
import fs from 'node:fs';
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

// 在途期间只保留一个共享尾随 Promise:重复 refresh 共用它,不会无界累积 resolver,
// 也不会因为尾随次数多而多跑几轮。
{
  const first = deferred();
  const second = deferred();
  let calls = 0;
  const coordinator = createRefreshCoordinator(async () => {
    calls += 1;
    if (calls === 1) await first.promise;
    else if (calls === 2) await second.promise;
  });
  coordinator.setActiveBatch('b1');
  const run1 = coordinator.refresh('b1');
  const trailing = Array.from({ length: 8 }, () => coordinator.refresh('b1'));
  assert.ok(trailing.every((promise) => promise === trailing[0]), '在途期间的重复尾随刷新必须共享同一个 Promise');
  first.resolve();
  await tick();
  assert.equal(calls, 2, '在途期间的多轮尾随只补跑一次');
  const nextRound = Array.from({ length: 4 }, () => coordinator.refresh('b1'));
  assert.ok(nextRound.every((promise) => promise === nextRound[0]), '下一轮在途期间也只有一个共享尾随 Promise');
  assert.notEqual(nextRound[0], trailing[0], '新一轮必须使用新的共享尾随 Promise');
  second.resolve();
  await tick();
  assert.equal(calls, 3, '第二轮尾随同样只补跑一次');
  await Promise.all([run1, ...trailing, ...nextRound]);
}

// 悬挂的 worker（模拟 fetch 超时后 reject）不得永久锁死刷新。
{
  let calls = 0;
  const coordinator = createRefreshCoordinator(async () => {
    calls += 1;
    if (calls === 1) {
      await new Promise<void>((_, reject) => {
        setTimeout(() => reject(new Error('fetch timeout')), 10);
      });
    }
  });
  coordinator.setActiveBatch('b1');
  await coordinator.refresh('b1');
  await coordinator.refresh('b1');
  assert.equal(calls, 2, 'worker 拒绝后协调器必须继续接受并执行后续刷新');
}

// 切批次后到达的旧响应必须被忽略:响应回来时同步核对最新活动批次（getter），
// 不依赖滞后的 setActiveBatch effect。
{
  let activeBatch = 'b1';
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
  }, () => activeBatch);
  const b1Run = coordinator.refresh('b1');
  activeBatch = 'b2';
  const b2Run = coordinator.refresh('b2');
  first.resolve();
  await tick();
  assert.deepEqual(applied, [], '旧批次的响应不得被应用');
  second.resolve();
  await Promise.all([b1Run, b2Run]);
  assert.deepEqual(applied, ['b2'], '只有当前批次的响应可以落状态');
}

// 非当前活动批次的 refresh 直接 resolve:不排队、不启动 worker,
// 也不得覆盖当前批次的尾随刷新目标。
{
  let activeBatch = 'b1';
  const first = deferred();
  const second = deferred();
  const batches: string[] = [];
  const coordinator = createRefreshCoordinator(async (request) => {
    batches.push(request.batchId);
    if (request.batchId === 'b1') await first.promise;
    else await second.promise;
  }, () => activeBatch);
  const b1Run = coordinator.refresh('b1');
  activeBatch = 'b2';
  await coordinator.refresh('b1');
  assert.deepEqual(batches, ['b1'], '非当前批次不得启动 worker');
  const b2Trailing = coordinator.refresh('b2');
  first.resolve();
  await tick();
  assert.deepEqual(batches, ['b1', 'b2'], '尾随刷新只跑当前批次');
  second.resolve();
  await Promise.all([b1Run, b2Trailing]);
}

// 显式用旧 batchId 刷新时,响应仍按当前活动批次核对。
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
  assert.deepEqual(applied, ['b1', 'b2'], '旧 batchId 的迟到刷新不得把活动批次改回去,也不得落旧状态');
}

// 面板里的两个刷新 fetch 必须带超时,否则一次永不 settle 的请求会锁死协调器。
{
  const panelSource = fs.readFileSync('components/batch-production/BatchPreparationPanel.tsx', 'utf8');
  const timeouts = panelSource.match(/signal: AbortSignal\.timeout\(15_000\)/g) ?? [];
  assert.equal(timeouts.length, 2, 'tasks 与 workspace 两个 fetch 都必须带 15 秒超时');
  assert.match(panelSource, /createRefreshCoordinator\(\s*\(request\) => loadTasksWorkerRef\.current\(request\),\s*\(\) => selectedBatchIdRef\.current,/, 'tasks 协调器必须同步读取当前批次 ref');
  assert.match(panelSource, /createRefreshCoordinator\(\s*\(request\) => loadWorkspaceWorkerRef\.current\(request\),\s*\(\) => selectedBatchIdRef\.current,/, 'workspace 协调器必须同步读取当前批次 ref');
  assert.doesNotMatch(panelSource, /Refresher\.setActiveBatch\(selectedBatchId\)/, '不得保留滞后的 setActiveBatch effect');
}

console.log('batch workspace refresh coordinator tests passed');
