/**
 * 08 号票：脚本页三条纯规则（验收要求可断言，不靠点界面）。
 *
 * 1. 字数与预计时长：规则**沿用** `lib/script-duration-policy.ts`（每秒 4.2 字，20 帧片头不算口播），
 *    只是把「一边打字一边算」这一步做成纯函数，界面和测试用同一份口径。
 * 2. 卖点库默认收起、默认全选：默认选中集合 = 通过核验且未被排除的卖点。
 * 3. 爆文模板条数合计上限：沿用现有规则（最多 6 条，单模板 1–6 条，顺序即生成顺序）。
 */
import assert from 'node:assert/strict';
import {
  SCRIPT_CALIBRATED_CHARS_PER_SECOND,
  buildScriptDurationAdvisory,
  countScriptContentCharacters,
} from '../lib/script-duration-policy.ts';
import {
  countTemplateEntries,
  defaultSelectedSellingPointIds,
  describeTemplateSelection,
  scriptLiveMetrics,
  setTemplateEntryCount,
  summarizeSellingPoints,
  toggleTemplateEntry,
} from '../lib/script-studio/panel-rules.ts';

// ── 1. 字数 / 预计时长 / 偏长或在预算内 ───────────────────────────────
{
  const budget = buildScriptDurationAdvisory(15);
  assert.equal(scriptLiveMetrics('', 15).characterCount, 0, '空文本字数为 0');
  assert.equal(scriptLiveMetrics('', 15).label, '偏短', '空文本提示偏短，不能报「在预算内」');

  const text = '沙发托住疲惫的身体，想了解这款就看看这些细节。';
  const metrics = scriptLiveMetrics(text, 15);
  assert.equal(metrics.characterCount, countScriptContentCharacters(text), '字数必须与生成侧同一口径（只数字母数字，不算标点）');
  assert.equal(
    metrics.estimatedNarrationSec,
    Number((metrics.characterCount / SCRIPT_CALIBRATED_CHARS_PER_SECOND).toFixed(1)),
    '预计口播 = 字数 / 4.2，保留一位小数',
  );
  assert.equal(metrics.targetTotalSec, 15);
  assert.equal(metrics.introDurationSec, Number((budget.introDurationSec).toFixed(2)), '片头时长沿用 20 帧 / 24fps');
  assert.equal(metrics.minContentCharacters, budget.minContentCharacters, '下限沿用既有预算');
  assert.equal(metrics.maxContentCharacters, budget.maxContentCharacters, '上限沿用既有预算');

  // 边界：正好等于上限算预算内，多一个字算偏长；正好等于下限算预算内，少一个字算偏短。
  const atMax = '字'.repeat(budget.maxContentCharacters);
  assert.equal(scriptLiveMetrics(atMax, 15).label, '在预算内', '正好到上限仍在预算内');
  assert.equal(scriptLiveMetrics(`${atMax}字`, 15).label, '偏长', '超过上限提示偏长');
  const atMin = '字'.repeat(budget.minContentCharacters);
  assert.equal(scriptLiveMetrics(atMin, 15).label, '在预算内', '正好到下限仍在预算内');
  assert.equal(scriptLiveMetrics('字'.repeat(budget.minContentCharacters - 1), 15).label, '偏短', '少于下限提示偏短');

  // 目标时长变了，预算跟着变（第 1 页换时长、第 3 页换时长都要实时反映）。
  const longer = scriptLiveMetrics(text, 30);
  assert.ok(longer.maxContentCharacters > metrics.maxContentCharacters, '目标时长变长时上限变大');
  assert.equal(scriptLiveMetrics(text, 30).status, 'too_short', '15 秒的文案放到 30 秒就是偏短');
  const midOf30 = Math.ceil((longer.minContentCharacters + longer.maxContentCharacters) / 2);
  assert.equal(scriptLiveMetrics('字'.repeat(midOf30), 30).status, 'qualified', '同样的长度按 30 秒预算算就落在区间里');
  assert.equal(scriptLiveMetrics('字'.repeat(longer.maxContentCharacters), 30).label, '在预算内', '30 秒的上限本身也在预算内');
  assert.equal(scriptLiveMetrics('字'.repeat(longer.maxContentCharacters + 1), 30).label, '偏长', '超过 30 秒上限提示偏长');
}

// ── 2. 卖点库默认收起、默认全选 ──────────────────────────────────────
{
  const points = [
    { id: 'p1', usable: 1, disabledByUser: 0, evidenceGate: 'passed' },
    { id: 'p2', usable: 1, disabledByUser: 0, evidenceGate: 'skipped' },
    { id: 'p3', usable: 1, disabledByUser: 1, evidenceGate: 'passed' },
    { id: 'p4', usable: 0, disabledByUser: 0, evidenceGate: 'failed' },
  ];
  assert.deepEqual(
    defaultSelectedSellingPointIds(points),
    ['p1', 'p2'],
    '默认全选 = 可用且没被用户排除的卖点；未通过核验的不算',
  );
  const summary = summarizeSellingPoints(points);
  assert.equal(summary.total, 4, '总数按库里的卖点算');
  assert.equal(summary.selected, 2, '默认选中的数量');
  assert.equal(summary.excluded, 1, '已被排除的数量');
  assert.equal(summary.unavailable, 1, '未通过核验的数量');
  assert.equal(summary.allSelected, false, '有人工排除项时不再显示「默认全选」');
  assert.equal(
    summarizeSellingPoints(points.filter((point) => point.id !== 'p3')).allSelected,
    true,
    '没有任何人工排除时显示「默认全选」（未通过核验的不算排除项）',
  );
  assert.equal(summarizeSellingPoints([]).allSelected, true, '没有卖点时也不该报「有排除项」');
  assert.deepEqual(defaultSelectedSellingPointIds([]), [], '没有卖点库时默认选中为空');
  // 默认状态是收起的：这是界面的初始值，纯函数只负责「选中集合」。
  assert.equal(summary.collapsedByDefault, true, '卖点库默认收起');
}

// ── 3. 模板条数合计上限 ─────────────────────────────────────────────
{
  assert.equal(countTemplateEntries([]), 0);
  assert.equal(countTemplateEntries(['a', 'a', 'b']), 3, '同一模板重复出现 = 该模板多条变体');

  // 勾选：上限 6 条；满了之后再勾不进去。
  let selected: string[] = [];
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) selected = toggleTemplateEntry(selected, id, 6);
  assert.deepEqual(selected, ['a', 'b', 'c', 'd', 'e', 'f'], '合计上限 6 条，第 7 个勾不进去');
  assert.deepEqual(toggleTemplateEntry(selected, 'a', 6), ['b', 'c', 'd', 'e', 'f'], '再点一次取消该模板（全部变体）');

  // 调条数：保持该模板在生成顺序里的首个位置，总量不超过上限。
  let picks = toggleTemplateEntry(toggleTemplateEntry([], 'a', 6), 'b', 6);
  assert.deepEqual(picks, ['a', 'b']);
  picks = setTemplateEntryCount(picks, 'a', 3, 6);
  assert.deepEqual(picks, ['a', 'a', 'a', 'b'], '增加条数时同一模板连续出现，顺序保持');
  assert.deepEqual(setTemplateEntryCount(picks, 'b', 4, 6), picks, '超过合计上限的调整被拒绝');
  assert.deepEqual(setTemplateEntryCount(picks, 'a', 1, 6), ['a', 'b'], '减少到 1 条只留一个');
  assert.deepEqual(setTemplateEntryCount(picks, 'a', 0, 6), picks, '少于 1 条被拒绝');

  const summary = describeTemplateSelection(picks, 6);
  assert.equal(summary.templateCount, 2, '模板个数按去重算');
  assert.equal(summary.totalCount, 4, '合计条数按展开数组算');
  assert.equal(summary.remaining, 2, '剩余可加条数');
  assert.equal(summary.atLimit, false);
  assert.equal(describeTemplateSelection(selected, 6).atLimit, true, '满了之后 atLimit 为 true');

  // 上限沿用现有规则（SCRIPT_GENERATION_MAX_COUNT = 6），不是这里另定的新数字。
  assert.deepEqual(
    setTemplateEntryCount(['a', 'a', 'a', 'a', 'a', 'a'], 'a', 7, 6),
    ['a', 'a', 'a', 'a', 'a', 'a'],
    '任何路径都不能突破 6 条',
  );
}

console.log('script-panel-rules tests passed');
