/**
 * 07 号票（项目工作台框架、第 1 步场景图、第 2 步分镜）的规则单测。
 *
 * 这些函数就是界面按钮背后的判断，所以断言写的是「点下去会发生什么」：
 * 点选顺序、全选再点取消、设为开场、版本切换、失败不能标可用、左右键回绕。
 */
import assert from 'node:assert/strict';
import {
  SCENE_VIEW_MODES,
  canMarkShotAvailable,
  canRegenerateShot,
  canRetryShot,
  formatShotVersionLabel,
  getOpeningShotId,
  hasShotResult,
  isAllPicked,
  isOpeningShot,
  movePickedToFront,
  removePickedId,
  resolveShotResultState,
  stepIndex,
  togglePickedId,
  toggleSelectAll,
  isSceneViewMode,
  clampIndex,
} from '../lib/workbench-shots.ts';

// ── 第 1 步视图：对照是默认值，网格是另一种 ──
assert.deepEqual([...SCENE_VIEW_MODES], ['compare', 'grid']);
assert.equal(isSceneViewMode('compare'), true);
assert.equal(isSceneViewMode('grid'), true);
assert.equal(isSceneViewMode('list'), false, '只有对照与网格两种视图');

// ── 点选顺序 = 镜头顺序；再点一次取消 ──
let picks: string[] = [];
picks = togglePickedId(picks, 'r2', 20);
picks = togglePickedId(picks, 'r5', 20);
picks = togglePickedId(picks, 'r7', 20);
assert.deepEqual(picks, ['r2', 'r5', 'r7'], '点选顺序就是镜头顺序');
picks = togglePickedId(picks, 'r5', 20);
assert.deepEqual(picks, ['r2', 'r7'], '再点一次取消该张，其余顺序不变');
assert.equal(getOpeningShotId(picks), 'r2', '第一张是开场图');
assert.equal(isOpeningShot(picks, 'r2'), true);
assert.equal(isOpeningShot(picks, 'r7'), false);

// 上限：到顶后不再追加，且不改变已有顺序
let capped: string[] = [];
for (const id of ['a', 'b', 'c']) capped = togglePickedId(capped, id, 2);
assert.deepEqual(capped, ['a', 'b'], '超过上限时不追加');

// ── 全选 / 再点一次取消全选 ──
const library = ['r1', 'r2', 'r3', 'r4'];
assert.equal(isAllPicked([], library, 20), false);
let all = toggleSelectAll(['r3'], library, 20);
assert.deepEqual(all, ['r3', 'r1', 'r2', 'r4'], '全选保留已选顺序，按列表顺序补齐');
assert.equal(isAllPicked(all, library, 20), true);
all = toggleSelectAll(all, library, 20);
assert.deepEqual(all, [], '再点一次取消全选');
// 素材数超过上限时，「全选」只选到上限，且仍算全选状态（否则按钮永远取消不了）
const many = Array.from({ length: 25 }, (_, index) => `m${index}`);
const limited = toggleSelectAll([], many, 20);
assert.equal(limited.length, 20, '全选最多到上限');
assert.equal(isAllPicked(limited, many, 20), true, '选到上限即视为已全选，按钮可以取消');
assert.deepEqual(toggleSelectAll(limited, many, 20), [], '选到上限后再点取消全选');
assert.deepEqual(toggleSelectAll([], [], 20), [], '没有素材时全选是空操作');
assert.equal(isAllPicked([], [], 20), false);

// ── 设为开场：移到第一位，其余顺序不变 ──
const ordered = ['r1', 'r2', 'r3', 'r4'];
assert.deepEqual(movePickedToFront(ordered, 'r3'), ['r3', 'r1', 'r2', 'r4'], '其余顺序不变');
assert.deepEqual(movePickedToFront(ordered, 'r1'), ['r1', 'r2', 'r3', 'r4'], '已经是第一张时不动');
assert.deepEqual(movePickedToFront(ordered, 'r9'), ordered, '未选中的图不会插进来');
assert.deepEqual(movePickedToFront(['r5'], 'r5'), ['r5']);
assert.deepEqual(removePickedId(ordered, 'r2'), ['r1', 'r3', 'r4'], '删图后从已选里移除，顺序不变');

// ── 版本显示与切换 ──
assert.equal(formatShotVersionLabel(1, 2), '第 2 版（共 2 版）');
assert.equal(formatShotVersionLabel(0, 1), '第 1 版（共 1 版）');
assert.equal(formatShotVersionLabel(0, 0), '第 1 版', '还没有版本时不写「共 0 版」');
assert.equal(formatShotVersionLabel(9, 3), '第 3 版（共 3 版）', '越界下标收口到最后一版');
assert.equal(clampIndex(-5, 3), 0);
assert.equal(clampIndex(1.7, 3), 1);

// ── 左右键：切换不翻页（这里只管下标，preventDefault 在组件里） ──
assert.equal(stepIndex(0, 1, 3), 1);
assert.equal(stepIndex(2, 1, 3), 0, '到最后一张再按右键回到第一张');
assert.equal(stepIndex(0, -1, 3), 2, '在第一张按左键回到最后一张');
assert.equal(stepIndex(0, 1, 0), 0, '空列表安全');
assert.equal(stepIndex(1, 0, 3), 1);

// ── 失败分镜不能标可用 ──
assert.equal(resolveShotResultState('pending', false), 'queued');
assert.equal(resolveShotResultState('running', false), 'generating');
assert.equal(resolveShotResultState('retrying', false), 'generating');
assert.equal(resolveShotResultState('needs_check', false), 'checking');
assert.equal(resolveShotResultState('succeeded', true), 'succeeded');
assert.equal(resolveShotResultState('succeeded', false), 'failed', '状态成功但输出文件缺失按失败处理');
assert.equal(resolveShotResultState('failed', false), 'failed');
assert.equal(resolveShotResultState('canceled', false), 'failed');
assert.equal(resolveShotResultState(undefined, false), 'empty');
assert.equal(resolveShotResultState(null, true), 'succeeded');

assert.equal(canMarkShotAvailable('failed'), false, '失败的分镜不能标可用');
assert.equal(canMarkShotAvailable('queued'), false, '还没出图不能标可用');
assert.equal(canMarkShotAvailable('generating'), false);
assert.equal(canMarkShotAvailable('succeeded'), true);
assert.equal(canRetryShot('failed'), true, '失败的分镜能重试');
assert.equal(canRetryShot('succeeded'), false);
assert.equal(canRetryShot('generating'), false);
assert.equal(hasShotResult('succeeded'), true);
assert.equal(hasShotResult('failed'), false);

// ── 重新生成：失败的分镜也能换供应商重做（不能拿「能否标可用」当门禁）──
assert.equal(canRegenerateShot('succeeded'), true, '有结果的分镜能重新生成');
assert.equal(canRegenerateShot('failed'), true, '失败的分镜也能重新生成（换供应商重做）');
assert.equal(canRegenerateShot('empty'), false, '还没有任务时没有可重做的对象');
assert.equal(canRegenerateShot('queued'), false, '排队中不重复提交');
assert.equal(canRegenerateShot('generating'), false, '生成中不重复提交');
assert.equal(canRegenerateShot('checking'), false, '等待补抓结果时先补抓，不另开新任务');

console.log('workbench-shots ok');
