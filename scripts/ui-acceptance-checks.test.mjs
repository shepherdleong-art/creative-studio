import assert from 'node:assert/strict';
import {
  CHECK_KEYS,
  CONTROL_SELECTOR,
  PRESET_RATIOS,
  TOLERANCE,
  evaluateClippedControls,
  evaluateHiddenOverflowContent,
  evaluateHorizontalOverflow,
  evaluateMediaFrames,
} from './team-server/ui-acceptance-checks.mjs';
import {
  ALL_CHECKS,
  SCREENS,
  selectScreens,
  validateScreens,
} from './team-server/ui-acceptance-screens.mjs';
import { FIXTURE_HOOKS, resolveHooks } from './team-server/ui-acceptance-fixtures.mjs';

// 说明：这里只测「判定规则」本身，不启浏览器 —— 尺寸判定是这一票真正的产出，
// 判错了整套验收就白跑。浏览器测量在 scripts/ui-acceptance.playwright.test.mjs 里跑真页面。

// ---------- 检查一：横向滚动 ----------
assert.deepEqual(evaluateHorizontalOverflow({ innerWidth: 1536, scrollWidth: 1536, overflowPx: 0 }).passed, true);
assert.deepEqual(evaluateHorizontalOverflow({ innerWidth: 1536, scrollWidth: 1537, overflowPx: 1 }).passed, true, '1px 取整误差不算横向滚动');
const overflow = evaluateHorizontalOverflow({
  innerWidth: 1536, scrollWidth: 1597, overflowPx: 61,
  offenders: [{ signature: 'div.mixcut-shell-module__fjjAuG__shell', right: 1597, width: 1438, text: '' }],
});
assert.equal(overflow.passed, false);
assert.match(overflow.detail, /横向多出 61px/);
assert.match(overflow.detail, /div\./);
assert.equal(evaluateHorizontalOverflow(null).passed, false, '没有测量结果不能当通过');

// ---------- 检查二：控件被切 ----------
assert.equal(evaluateClippedControls([]).passed, true);
const clipped = evaluateClippedControls([
  { signature: 'button「预览调整」', clipped: 'right', left: 1500, right: 1580, visibleRight: 1536 },
]);
assert.equal(clipped.passed, false);
assert.match(clipped.detail, /被右边切掉/);

// ---------- 检查三：工具栏藏内容 ----------
assert.equal(evaluateHiddenOverflowContent([]).passed, true);
const hidden = evaluateHiddenOverflowContent([
  { signature: 'div.toolbar', scrollWidth: 800, clientWidth: 640, overflowPx: 160, scrollbarGutter: 0 },
]);
assert.equal(hidden.passed, false);
assert.match(hidden.detail, /800px \/ 可见 640px/);

// ---------- 检查四：画面比例 ----------
const base = { innerWidth: 1536, innerHeight: 864, top: 100, right: 800, bottom: 600, width: 300, height: 400, ratio: 0.75 };
assert.equal(evaluateMediaFrames([{ ...base, signature: 'div[3x4]', expected: 3 / 4, source: 'data 标注 3x4' }]).passed, true);
const wrongRatio = evaluateMediaFrames([{ ...base, signature: 'div[9x16]', expected: 9 / 16, ratio: 0.75, source: 'data 标注 9x16' }]);
assert.equal(wrongRatio.passed, false);
assert.match(wrongRatio.detail, /比例/);
const tooSmall = evaluateMediaFrames([{ ...base, signature: 'video', expected: 3 / 4, width: 60, height: 80, ratio: 0.75, source: '视频固有尺寸 3:4' }]);
assert.equal(tooSmall.passed, false);
assert.match(tooSmall.detail, /画面太小/);
const offscreen = evaluateMediaFrames([{ ...base, signature: 'div[3x4]', expected: 3 / 4, bottom: 900, right: 1600, source: 'data 标注 3x4' }]);
assert.equal(offscreen.passed, false);
assert.match(offscreen.detail, /超出窗口/);
// 没有期望比例的容器（例如只有 data-preset 但没有数值）不算失败，但要报「没量到」。
const unmeasurable = evaluateMediaFrames([{ ...base, signature: 'div', expected: null, source: '没有画幅标记' }]);
assert.equal(unmeasurable.passed, true);
assert.equal(unmeasurable.measured, 0);
assert.match(unmeasurable.detail, /没有可测画面/);
assert.equal(evaluateMediaFrames(null).passed, false);

// 阈值就是需求：不放宽。
assert.equal(TOLERANCE.ratio, 0.02);
assert.equal(TOLERANCE.minMediaWidth, 100);
assert.equal(PRESET_RATIOS['3x4'], 3 / 4);
assert.equal(PRESET_RATIOS['9x16'], 9 / 16);
assert.deepEqual([...CHECK_KEYS], ['horizontalScroll', 'clippedControls', 'hiddenOverflowContent', 'mediaFrames']);
assert.match(CONTROL_SELECTOR, /button/, '控件选择器必须包含 button');

// ---------- 屏幕清单自检 ----------
validateScreens();
assert.ok(SCREENS.length >= 20, `现有页面都应该进清单，实际 ${SCREENS.length} 条`);
assert.equal(new Set(SCREENS.map((screen) => screen.id)).size, SCREENS.length, '屏幕 id 必须唯一');
for (const screen of SCREENS) {
  assert.ok(screen.owner.match(/^ui-\d{2}$/), `屏幕 ${screen.id} 必须写明负责票号`);
  assert.deepEqual([...screen.checks], [...ALL_CHECKS], `屏幕 ${screen.id} 默认要跑全部四项检查`);
}
// 已知失败必须挂在 09 上，并且只豁免「横向溢出连带」的三项 —— 画面比例真失败不许被豁免。
const mixcut = SCREENS.filter((screen) => screen.id.startsWith('mixcut-'));
assert.equal(mixcut.length, 2);
for (const screen of mixcut) {
  assert.equal(screen.knownFailure, 'ui-09');
  assert.deepEqual([...screen.knownFailureChecks], ['horizontalScroll', 'clippedControls', 'hiddenOverflowContent']);
  assert.equal(screen.knownFailureChecks.includes('mediaFrames'), false, '画面比例不属于 09 的已知问题，不许豁免');
  assert.match(screen.knownFailureReason, /85px/);
  assert.match(screen.knownFailureReason, /61px/);
}
assert.throws(() => validateScreens([{ id: 'Bad_Id', title: 'x', owner: 'ui-01', audience: 'employee', href: () => '/', ready: async () => {} }]), /kebab-case/);
assert.throws(() => validateScreens([{ id: 'a', title: 'x', owner: 'ui-01', audience: 'employee', href: () => '/' }]), /ready/);
assert.throws(
  () => validateScreens([{ id: 'a', title: 'x', owner: 'ui-01', audience: 'employee', href: () => '/', ready: async () => {}, knownFailure: 'ticket-9', knownFailureReason: 'x' }]),
  /票号/,
);
assert.throws(
  () => validateScreens([{ id: 'a', title: 'x', owner: 'ui-01', audience: 'employee', href: () => '/', ready: async () => {}, knownFailure: 'ui-09' }]),
  /没写原因/,
);
assert.throws(() => selectScreens(['no-such-screen']), /未知的屏幕 id/);
assert.deepEqual(selectScreens(['mixcut-single']).map((screen) => screen.id), ['mixcut-single']);
assert.equal(selectScreens([]).length, SCREENS.length);

// ---------- 数据钩子入口 ----------
assert.equal(typeof FIXTURE_HOOKS.base, 'function', '基础数据钩子必须在');
assert.deepEqual(resolveHooks({}, ['base', 'videos']).missing, ['videos']);
assert.deepEqual(resolveHooks({}, ['base']).missing, []);

console.log(`ui acceptance check rules passed: ${SCREENS.length} screens, ${CHECK_KEYS.length} checks, ${Object.keys(FIXTURE_HOOKS).length} fixture hooks`);
