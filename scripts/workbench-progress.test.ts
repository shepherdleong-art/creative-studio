/**
 * 首页的「做到第几步」与「正在生产」口径（06 号票）。
 *
 * 两条验收在这里被钉住：
 *   1. 进度规则：只有渲染阶段显示百分比，其他阶段写「正在做什么、第几条」。
 *      原型里每项都画了百分比只是示意，照抄会在界面上写假数字。
 *   2. 空状态要写明下一步，不能只说「暂无」。
 */
import assert from 'node:assert/strict';

const {
  deriveProjectProgress,
  nextActionForProgress,
  WORKBENCH_STEP_LABELS,
} = await import('../lib/project-progress.ts');
const {
  describeRunningTask,
  describeRunningTasks,
  isTaskInFlight,
  renderPercent,
} = await import('../lib/task-progress.ts');

// ── 项目进度：只看「有没有产出」 ──
const empty = {
  sceneCandidateCount: 0, shotResultCount: 0, approvedShotSetCount: 0,
  scriptCount: 0, videoJobCount: 0, succeededVideoCount: 0, finalGroupCount: 0,
};
assert.deepEqual(deriveProjectProgress(empty), { step: 1, label: '场景图', empty: true },
  '没有任何产出时停在第 1 步且是空状态');
assert.equal(nextActionForProgress(deriveProjectProgress(empty)), '先上传一张原始场景图，生成场景候选。',
  '第 1 步空状态必须写明下一步');

assert.deepEqual(
  deriveProjectProgress({ ...empty, sceneCandidateCount: 4 }),
  { step: 2, label: '分镜', empty: true },
  '有场景候选 → 第 2 步',
);
assert.equal(deriveProjectProgress({ ...empty, sceneCandidateCount: 4 }).empty, true,
  '第 1 步有产出、第 2 步还没有时，「这一步」仍是空的');

assert.equal(deriveProjectProgress({ ...empty, sceneCandidateCount: 4, shotResultCount: 3 }).step, 3,
  '有分镜候选 → 第 3 步');
assert.equal(deriveProjectProgress({ ...empty, sceneCandidateCount: 4, approvedShotSetCount: 1 }).step, 3,
  '分镜组已通过也算走过分镜');
assert.equal(deriveProjectProgress({ ...empty, sceneCandidateCount: 4, shotResultCount: 3, scriptCount: 1 }).step, 4,
  '有脚本 → 第 4 步');
assert.equal(deriveProjectProgress({
  ...empty, sceneCandidateCount: 4, shotResultCount: 3, scriptCount: 1, succeededVideoCount: 1,
}).step, 5, '有成功视频 → 第 5 步');
assert.equal(deriveProjectProgress({
  ...empty, sceneCandidateCount: 4, shotResultCount: 3, scriptCount: 1, succeededVideoCount: 1,
}).label, WORKBENCH_STEP_LABELS[4], '步骤名必须与五步工作台一致');

// 视频任务数不影响「走到第 4 步」的判断：只有成功的视频才算产出。
assert.equal(deriveProjectProgress({
  ...empty, sceneCandidateCount: 4, shotResultCount: 3, scriptCount: 1, videoJobCount: 5, succeededVideoCount: 0,
}).step, 4, '失败/在跑的视频任务不能把项目算成已到第 5 步');

for (const step of [2, 3, 4, 5] as const) {
  const progress = deriveProjectProgress(
    step === 2 ? { ...empty, sceneCandidateCount: 1 }
      : step === 3 ? { ...empty, sceneCandidateCount: 1, shotResultCount: 1 }
        : step === 4 ? { ...empty, sceneCandidateCount: 1, shotResultCount: 1, scriptCount: 1 }
          : { ...empty, sceneCandidateCount: 1, shotResultCount: 1, scriptCount: 1, succeededVideoCount: 1 },
  );
  assert.equal(progress.step, step);
  const action = nextActionForProgress(progress);
  assert.ok(action.length > 8 && action.endsWith('。'), `第 ${step} 步的空状态必须给出可执行的下一步：${action}`);
}

// ── 正在生产：非渲染阶段绝不显示百分比 ──
assert.equal(renderPercent(0.42), 42, '渲染进度 0.42 → 42%');
assert.equal(renderPercent(0), 0);
assert.equal(renderPercent(1), 100);
assert.equal(renderPercent(null), null, '没有进度就是不可测');
assert.equal(renderPercent(Number.NaN), null);
assert.equal(renderPercent(1.5), null, '越界进度按不可测处理，不能显示 150%');

const imageTask = describeRunningTask({
  operationId: 'op-1', module: 'image', status: 'running', taskName: '分镜图生成',
  stepName: '查询生成结果', queuePosition: 2,
});
assert.equal(imageTask.percent, null, '图片任务阶段不可测，不能显示百分比');
assert.match(imageTask.label, /分镜图生成/);
assert.match(imageTask.detail, /第 2 条/, '非渲染阶段必须写「第几条」');
assert.doesNotMatch(imageTask.detail, /%/, '非渲染阶段的副标题不得出现百分比');

const rendered = describeRunningTask({
  operationId: 'op-2', module: 'final_edit', status: 'running', taskName: '智能混剪',
  stepName: 'rendering', renderProgress: 0.37,
});
assert.equal(rendered.percent, 37, '只有渲染阶段显示真实百分比');
assert.match(rendered.detail, /37%/);

const packaging = describeRunningTask({
  operationId: 'op-3', module: 'final_edit', status: 'running', taskName: '成片包装',
  stepName: 'packaging', renderProgress: 0.8,
});
assert.equal(packaging.percent, 80, '包装是同一渲染管线的可测阶段');

const waiting = describeRunningTask({
  operationId: 'op-4', module: 'video', status: 'deferred', taskName: '视频生成',
  stepName: '生成请求', waitLabel: '等待可用资源（供应商名额已满，释放后自动继续）',
});
assert.equal(waiting.percent, null);
assert.match(waiting.detail, /排队中|名额/, '等待中的任务要写清楚在等什么');

// 批量：按「项目 + 模块」编号，渲染项带百分比，非渲染项没有。
const described = describeRunningTasks([
  { operationId: 'a', module: 'image', status: 'admitted', taskName: '新场景图生成', stepName: '生成请求', scope: { resourceType: 'project', resourceId: 'p1' } },
  { operationId: 'b', module: 'image', status: 'pending', taskName: '新场景图生成', stepName: '生成请求', scope: { resourceType: 'project', resourceId: 'p1' } },
  { operationId: 'c', module: 'final_edit', status: 'running', taskName: '智能混剪', stepName: 'rendering', renderProgress: 0.5, scope: { resourceType: 'project', resourceId: 'p1' } },
  { operationId: 'd', module: 'image', status: 'succeeded', taskName: '新场景图生成', stepName: '下载结果', scope: { resourceType: 'project', resourceId: 'p1' } },
]);
assert.equal(described.length, 3, '已完成的任务不进「正在生产」');
assert.equal(described.filter((view) => view.percent !== null).length, 1, '整份列表里只有渲染任务带百分比');
assert.deepEqual(described.filter((view) => view.percent === null).map((view) => view.detail), ['第 1 条', '第 2 条']);

assert.equal(isTaskInFlight('pending'), true);
assert.equal(isTaskInFlight('succeeded'), false);
assert.equal(isTaskInFlight('failed'), false);

console.log('workbench progress tests passed');
