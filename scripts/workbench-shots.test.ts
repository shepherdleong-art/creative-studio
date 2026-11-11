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
  canStepShotVersion,
  formatLatestShotVersionHint,
  formatShotVersionAriaLabel,
  formatShotVersionSummary,
  formatShotVersionTag,
  getOpeningShotId,
  hasShotResult,
  isAllPicked,
  isOpeningShot,
  movePickedToFront,
  removePickedId,
  resolveShotResultState,
  resolveShotVersion,
  stepIndex,
  stepShotVersion,
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

// ── 版本计算：缩略图、网格、大图共用同一份结果 ──
// 无结果：不显示 V0，也不编造版本
const noVersion = resolveShotVersion(undefined);
assert.equal(noVersion.total, 0);
assert.equal(noVersion.current, 0, '没有结果时不能显示 V0');
assert.equal(formatShotVersionTag(noVersion), '');
assert.equal(formatShotVersionSummary(noVersion), '');
assert.equal(formatShotVersionAriaLabel(2, noVersion), '分镜 2，暂无结果');
assert.equal(canStepShotVersion(noVersion), false);
assert.deepEqual(resolveShotVersion(null), noVersion, '空数据安全，返回同样的空版本');

// 兼容旧数据：没有 candidates 数组但有旧结果 → 按现有回退显示 V1
const legacy = resolveShotVersion({
  latestGeneratedImageId: 'old-asset',
  generatedImageUrl: '/api/images/outputs/old.png',
  generatedFilename: 'old.png',
});
assert.equal(legacy.total, 1);
assert.equal(legacy.current, 1, '旧数据只有一条回退结果，是 V1');
assert.equal(legacy.isLegacyFallback, true);
assert.equal(legacy.imageUrl, '/api/images/outputs/old.png');
assert.equal(formatShotVersionTag(legacy), 'V1');
assert.equal(formatShotVersionSummary(legacy), '当前使用 V1 · 共 1 版');
assert.equal(formatLatestShotVersionHint(legacy), '', '只有一版不提示「最新」');
assert.equal(canStepShotVersion(legacy), false, '只有一版时不能切版');

// 三个有效候选，选中间那条：V2 / 共 3 版，旧版另示「最新 V3」
const three = resolveShotVersion({
  latestGeneratedImageId: 'v2',
  generatedImageUrl: '/api/images/outputs/v3.png',
  resultCandidates: [
    { imageAssetId: 'v1', imageUrl: '/api/images/outputs/v1.png' },
    { imageAssetId: 'v2', imageUrl: '/api/images/outputs/v2.png' },
    { imageAssetId: 'v3', imageUrl: '/api/images/outputs/v3.png' },
  ],
});
assert.equal(three.total, 3);
assert.equal(three.current, 2, '当前选用旧版时必须标出实际选中的那一版');
assert.equal(three.latest, 3);
assert.equal(three.imageUrl, '/api/images/outputs/v2.png', '标签与实际展示的图片必须是同一版');
assert.equal(formatShotVersionTag(three), 'V2');
assert.equal(formatShotVersionSummary(three), '当前使用 V2 · 共 3 版');
assert.equal(formatLatestShotVersionHint(three), '最新 V3', '选用旧版时另示最新版号');
assert.equal(formatShotVersionAriaLabel(6, three), '分镜 6，当前使用第 2 版，共 3 版');
assert.equal(canStepShotVersion(three), true);
assert.deepEqual(three.candidates.map((candidate) => candidate.imageAssetId), ['v1', 'v2', 'v3'], '候选顺序沿用服务端顺序，不重排');

// 选最新一条：不再另示「最新」（避免同号重复）
const newest = resolveShotVersion({
  latestGeneratedImageId: 'v3',
  resultCandidates: three.candidates,
});
assert.equal(newest.current, 3);
assert.equal(formatLatestShotVersionHint(newest), '');

// 选用 ID 不在候选数组（旧数据）：回退到最后一条可展示候选，不越界
const staleSelection = resolveShotVersion({
  latestGeneratedImageId: 'deleted-asset',
  resultCandidates: [
    { imageAssetId: 'v1', imageUrl: '/api/images/outputs/v1.png' },
    { imageAssetId: 'v2', imageUrl: '/api/images/outputs/v2.png' },
  ],
});
assert.equal(staleSelection.current, 2, '选用 ID 不在候选里时回退到最后一条');
assert.equal(staleSelection.imageUrl, '/api/images/outputs/v2.png');
assert.equal(staleSelection.latest, 2);

// 没有选用记录时也回退到最后一条（与既有展示规则一致）
const noSelection = resolveShotVersion({ resultCandidates: three.candidates });
assert.equal(noSelection.current, 3);

// 候选缺少可展示图片：过滤后为空时退回旧的单图结果，不能拿 3 条无效候选编出 V3
const missingImages = resolveShotVersion({
  latestGeneratedImageId: 'deleted-asset',
  generatedImageUrl: '/api/images/outputs/legacy.png',
  resultCandidates: [
    { imageAssetId: 'gone-1' },
    { imageAssetId: 'gone-2' },
    { imageAssetId: 'gone-3' },
  ],
});
assert.equal(missingImages.total, 1, '有效候选为 0 时按一条旧结果回退');
assert.equal(missingImages.current, 1, '不能显示虚构的 V3');
assert.equal(missingImages.isLegacyFallback, true);
assert.equal(missingImages.imageUrl, '/api/images/outputs/legacy.png');
assert.equal(formatShotVersionTag(missingImages), 'V1');

// 只有 filename 没有 URL 的候选仍算可展示（沿用现有缺图过滤口径）
const filenameOnly = resolveShotVersion({
  latestGeneratedImageId: 'v1',
  resultCandidates: [{ imageAssetId: 'v1', filename: 'v1.png' }],
});
assert.equal(filenameOnly.total, 1);
assert.equal(filenameOnly.imageUrl, '', '没有 URL 时由调用方继续回退到 generatedImageUrl');

// 上一版 / 下一版：首尾回绕；单版没有可到的版本
assert.equal(stepShotVersion(three, -1)?.imageAssetId, 'v1');
assert.equal(stepShotVersion(three, 1)?.imageAssetId, 'v3');
assert.equal(stepShotVersion({ ...three, index: 0, current: 1 }, -1)?.imageAssetId, 'v3', '第一版再往前回到最后一版');
assert.equal(stepShotVersion({ ...three, index: 2, current: 3 }, 1)?.imageAssetId, 'v1', '最后一版再往后回到第一版');
assert.equal(stepShotVersion(legacy, 1), null, '只有一版时没有可切换的目标');
assert.equal(stepShotVersion(noVersion, -1), null);

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
assert.equal(resolveShotResultState('canceled', true), 'succeeded',
  'a canceled task with a retained late result is viewable but still not auto-promoted');
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
