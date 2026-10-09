import assert from 'node:assert/strict';
import { batchAllocationProgress, batchExportElapsedSec, batchSemanticProgress, splitBatchRenderTasks } from '../lib/batch-production/progress-summary.ts';
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

const planned = { allocationReport: null, cards: [{ versionId: null }, { versionId: null }] };
const speaking = [{ workType: 'narration', status: 'running' }] as const;
const spoken = [{ workType: 'narration', status: 'succeeded' }] as const;
assert.deepEqual(batchAllocationProgress(speaking, planned), {
  status: 'waiting', detail: '等待口播完成',
}, '截图回归：已有两张计划卡但口播未齐，配画面不得提前完成');
assert.equal(batchAllocationProgress([], planned).status, 'waiting', '任务尚未拉到时不把空计划当成片');
assert.equal(batchAllocationProgress(spoken, planned).status, 'running', '口播完成但分配结果未到时继续显示处理中');
const allocated = { allocationReport: { status: 'ready' }, cards: [{ versionId: 'v1' }] };
assert.equal(batchAllocationProgress(speaking, allocated).status, 'waiting', '已有旧结果也必须等待本轮口播');
assert.equal(batchAllocationProgress([{ workType: 'semantic_score', status: 'queued' }], allocated).status,
  'waiting', '语义任务排队时不得显示配画面完成');
assert.equal(batchAllocationProgress(spoken, allocated).status, 'done', '真正分配完成后展示完成');
assert.equal(batchAllocationProgress(spoken, { ...allocated, allocationReport: null }).status,
  'done', '兼容存在实际版本而无报告的历史成片');
assert.equal(batchAllocationProgress(spoken, { allocationReport: null, cards: [{ versionId: 'v1' }, { versionId: null }] }).status,
  'running', '仅部分计划有版本不能代表全部完成');
assert.equal(batchAllocationProgress(spoken, { ...allocated, allocationReport: { status: 'blocked' } }).status,
  'failed', '分配受阻不得因为报告存在就标记完成');
assert.equal(batchAllocationProgress([{ workType: 'narration', status: 'failed' }], planned).status,
  'running', '口播失败后的静音预览分配仍可推进');

const semanticFailed = { ...task(0, 1), status: 'failed' as const, attemptCount: 3 };
semanticFailed.attempts[0].errorCode = 'semantic_fallback';
assert.equal(batchSemanticProgress([semanticFailed], true).status, 'warning', '关键词兜底不能把整批进度显示成失败');
assert.match(batchSemanticProgress([semanticFailed], true).detail!, /已使用.*关键词/);
assert.match(batchSemanticProgress([semanticFailed], false).detail!, /将使用/);
assert.equal(batchSemanticProgress([{ ...semanticFailed, attemptCount: 1 }], false).status, 'waiting', '尚待自动重试时不得谎称已经降级');
assert.equal(batchSemanticProgress([semanticFailed, { ...semanticFailed, status: 'running' }], false).status, 'running', '部分失败不能盖住仍在匹配的任务');
const realFailure = { ...semanticFailed, attempts: [{ ...semanticFailed.attempts[0], errorCode: 'executor_error' }] };
assert.equal(batchSemanticProgress([realFailure], true).status, 'failed', '未知错误不得隐藏为正常降级');
assert.equal(batchSemanticProgress([{ ...semanticFailed, status: 'succeeded' }], true).status, 'done', '成功重试后不显示历史失败');
console.log('batch progress summary tests passed');
