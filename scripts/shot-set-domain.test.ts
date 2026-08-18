import assert from 'node:assert/strict';
import {
  MAX_SHOTS_PER_SET,
  SHOT_VISION_FULL_QUALITY_MAX,
  isShotSetKind,
  normalizeShotImageIds,
} from '../lib/shot-set-domain.ts';

// ── 常量自身的不变量 ──
assert.equal(MAX_SHOTS_PER_SET, 20, '上限变动必须是有意的产品决策');
assert.ok(
  SHOT_VISION_FULL_QUALITY_MAX < MAX_SHOTS_PER_SET,
  '满配阈值必须小于上限,否则软提示永远不会触发',
);

// ── 回归:新建项目页不发送 shotImageIds(app/projects/new/page.tsx) ──
// 这三条挡的是一个真实炸过的方案:allowEmpty 下把 undefined 当成非法值,
// 会让每一次「新建空项目」都返回 400。
assert.deepEqual(
  normalizeShotImageIds(undefined, { allowEmpty: true }),
  { ok: true, ids: [] },
  'allowEmpty 时 undefined 必须当成空数组,否则新建空项目会 400',
);
assert.deepEqual(
  normalizeShotImageIds(null, { allowEmpty: true }),
  { ok: true, ids: [] },
);
assert.equal(
  normalizeShotImageIds(undefined).ok,
  false,
  '不带 allowEmpty 时 undefined 仍必须失败',
);

// ── 类型不对 ──
assert.deepEqual(normalizeShotImageIds('nope'), { ok: false, error: 'shotImageIds 必须是数组' });
assert.equal(
  normalizeShotImageIds('nope', { allowEmpty: true }).ok,
  false,
  'allowEmpty 只放宽缺省,不放宽「传了但不是数组」',
);

// ── 脏值过滤 + 去重 ──
assert.deepEqual(normalizeShotImageIds(['a', 'b', 'a']), { ok: true, ids: ['a', 'b'] });
assert.deepEqual(
  normalizeShotImageIds(['a', '', null, 3, { id: 'x' }, 'b']),
  { ok: true, ids: ['a', 'b'] },
);

// ── 空数组的两种契约 ──
assert.equal(normalizeShotImageIds([]).ok, false);
assert.deepEqual(normalizeShotImageIds([], { allowEmpty: true }), { ok: true, ids: [] });

// ── 20 / 21 边界 ──
const twenty = Array.from({ length: MAX_SHOTS_PER_SET }, (_, i) => `img-${i}`);
assert.equal(normalizeShotImageIds(twenty).ok, true, '刚好 20 张必须放行');
const overLimit = normalizeShotImageIds([...twenty, 'img-extra']);
assert.equal(overLimit.ok, false, '21 张必须被挡住');
assert.match(
  overLimit.ok ? '' : overLimit.error,
  new RegExp(String(MAX_SHOTS_PER_SET)),
  '错误信息要带上真实上限,不能写死 9',
);

// ── 去重发生在数量校验之前 ──
assert.equal(
  normalizeShotImageIds([...twenty, twenty[0]]).ok,
  true,
  '21 个 id 里有重复,去重后是 20 张,不能误杀',
);

// ── D18:自由素材工位不限张数 ──
const fifty = Array.from({ length: 50 }, (_, i) => `free-${i}`);
assert.equal(
  normalizeShotImageIds(fifty, { max: null }).ok,
  true,
  'max: null 时不限张数(自由素材工位)',
);
assert.equal(normalizeShotImageIds(fifty).ok, false, '不传 max 时仍走 20 张上限');

// ── kind ──
assert.ok(isShotSetKind('storyboard'));
assert.ok(isShotSetKind('free'));
assert.ok(!isShotSetKind('bogus'));
assert.ok(!isShotSetKind(''));
assert.ok(!isShotSetKind(undefined));

console.log('shot-set-domain.test.ts OK');
