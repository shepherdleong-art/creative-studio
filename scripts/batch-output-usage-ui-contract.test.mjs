/**
 * F3 UI 契约：素材列表徽标显示「本片已用 ×N / 其他成片已用 ×M」。
 *
 * 数据来自 arrangement 视图的 useCountByPlanId（按成片计划计数的片段出现次数），
 * 两个数字独立计算、独立显示：同一素材同时用于本片和其他成片时必须两个徽标并存，
 * 不能再用「!usedByThis」把「其他成片已用」隐藏掉。
 *
 * 断言按**语义**写，不锁源码字面量：改个变量名或重新格式化不该让这里变红，
 * 只有口径真的退回去（次数变回布尔、两个徽标重新互斥）才该红。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';

const editor = fs.readFileSync('components/batch-production/BatchOutputEditor.tsx', 'utf8');
const view = fs.readFileSync('lib/batch-production/output-arrangement.ts', 'utf8');

// 0. 视图侧契约：按计划计数的字段存在，去重的兼容字段保留
assert.match(view, /useCountByPlanId:\s*Record<string,\s*number>/, '视图必须导出按成片计划计数的 useCountByPlanId');
assert.match(view, /usedByPlanIds:\s*string\[\]/, 'usedByPlanIds 兼容字段必须保留');

// 1. 本片次数取自 useCountByPlanId[planId]，缺省 0
assert.match(editor, /useCountByPlanId\[planId\]\s*\?\?\s*0/, '本片次数必须取 useCountByPlanId[planId] 且缺省 0');

// 2. 其他次数 = 遍历 useCountByPlanId、排除本片 planId 后求和
assert.match(
  editor,
  /Object\.entries\(\s*asset\.useCountByPlanId\s*\)[\s\S]{0,200}?id !== planId[\s\S]{0,200}?\.reduce\(/,
  '其他次数必须遍历 useCountByPlanId、排除本片 planId 后求和',
);

// 3. 两个徽标独立开关，不再用「本片未用」把「其他成片已用」挡掉
assert.match(editor, /usedByThis\s*=\s*thisCount\s*>\s*0/, '本片徽标开关必须由本片次数决定');
assert.match(editor, /usedByOthers\s*=\s*otherCount\s*>\s*0/, '其他成片徽标开关必须由其他次数决定');
assert.doesNotMatch(editor, /usedByOthers\s*=\s*!\s*usedByThis/, '其他成片已用不得再依赖「本片未用」判断');

// 4. 徽标文案带次数，且次数为 1 时省略 ×1
assert.match(editor, /本片已用\{[\s\S]{0,80}?×\$\{thisCount\}/, '「本片已用」徽标必须带 ×N');
assert.match(editor, /其他成片已用\{[\s\S]{0,80}?×\$\{otherCount\}/, '「其他成片已用」徽标必须带 ×M');
assert.match(editor, /thisCount\s*>\s*1\s*\?/, '本片次数为 1 时必须省略 ×1');
assert.match(editor, /otherCount\s*>\s*1\s*\?/, '其他次数为 1 时必须省略 ×1');

// 5. 顶部「已用 / 未用」统计保持按素材种类（usedByPlanIds）口径，不与出现次数混用
assert.match(
  editor,
  /usedHere\s*=\s*poolAssets\.filter\([\s\S]{0,120}?usedByPlanIds\.includes\(planId\)/,
  '顶部「已用」统计仍按素材种类计，不得换成出现次数',
);

console.log('batch-output-usage ui contract passed');
