import assert from 'node:assert/strict';
import { batchExportElapsedSec, splitBatchRenderTasks } from '../lib/batch-production/progress-summary.ts';
import type { BatchTaskView } from '../lib/batch-production/tasks.ts';

const groups = splitBatchRenderTasks([
  { id: 'cover-1', workType: 'render', targetKind: 'output_version_cover' },
  { id: 'full-1', workType: 'render', targetKind: 'output_version' },
  { id: 'narration-1', workType: 'narration', targetKind: 'script_snapshot' },
  { id: 'legacy-1', workType: 'render', targetKind: 'legacy_proxy_cache' },
] as const);

assert.deepEqual(groups.cover.map(({ id }) => id), ['cover-1'], '封面任务必须单独归类');
assert.deepEqual(groups.full.map(({ id }) => id), ['full-1'], '整片任务必须单独归类');

const at = (sec: number) => new Date(sec * 1000).toISOString();
function task(start: number, end: number | null, targetKind: BatchTaskView['targetKind'] = 'output_version'): BatchTaskView {
  return {
    id: `task-${start}`, workType: 'render', targetKind, targetId: 'version',
    status: end === null ? 'running' : 'succeeded', expectedState: 'running',
    attemptCount: 1, createdAt: at(0), progressJson: {}, attempts: [{
      id: `attempt-${start}`, attemptNumber: 1, status: end === null ? 'running' : 'succeeded',
      progressJson: {}, resultJson: null, errorCode: null, errorMessage: null,
      startedAt: at(start), finishedAt: end === null ? null : at(end),
    }],
  };
}
assert.equal(batchExportElapsedSec([], 10_000), 0, '未导出不能沿用准备阶段计时');
const exports = [task(600, 620), task(610, 640), task(1000, 1010)];
assert.equal(batchExportElapsedSec([task(0, 500, 'output_version_cover'), ...exports], 2000_000), 50,
  '排除封面准备、审片空闲，并行导出区间只计一次');
assert.equal(batchExportElapsedSec(exports, 9999_000), 50, '已结束的导出在刷新后停表');
assert.equal(batchExportElapsedSec([task(600, null)], 615_000), 15, '活跃导出实时计时');
const retry = task(600, 610);
retry.attempts[0].status = 'failed';
retry.attempts.push({ ...task(1000, 1020).attempts[0], attemptNumber: 2 });
assert.equal(batchExportElapsedSec([retry], 2000_000), 30, '重试累计真实运行时间，排除重试前等待');
const queued = { ...task(600, 610), status: 'queued' as const, attempts: [] };
assert.equal(batchExportElapsedSec([queued], 9999_000), 0, '排队尚未渲染时不计时');
const broken = task(600, 610);
broken.attempts[0].finishedAt = 'invalid';
assert.equal(batchExportElapsedSec([broken], 9999_000), 0, '损坏时间不传播 NaN');

console.log('batch progress summary tests passed');
