/**
 * 第 3 步脚本页的三条纯规则（08 号票）。
 *
 * 为什么单独抽出来：这三条都是「界面随手算一下」的逻辑，却各自有验收条件
 * （字数与预计时长实时更新、卖点库默认收起全选、模板条数合计上限）。
 * 放在组件里只能靠点界面验，抽成纯函数就能用 `scripts/script-panel-rules.test.ts`
 * 直接钉住口径，界面只负责显示。
 *
 * 三条都不是新规则：
 * - 字数与时长**沿用** `lib/script-duration-policy.ts`（每秒 4.2 字，片头 20 帧 / 24fps
 *   不算口播，下浮 10% 为下限），与生成侧的 `durationStatus` 判定同源；
 * - 卖点默认选中 = 可用且没被人工排除（`usable === 1 && disabledByUser !== 1
 *   && evidenceGate !== 'failed'`），与服务端 fail closed 一致；
 * - 模板上限沿用 `SCRIPT_GENERATION_MAX_COUNT`（6 条），同一模板重复出现即该模板的条数。
 */
import {
  buildScriptDurationAdvisory,
  countScriptContentCharacters,
  estimateNarrationDurationSec,
} from '../script-duration-policy.ts';
import { SCRIPT_GENERATION_MAX_COUNT } from './generation-contract.ts';

// ---------------------------------------------------------------------------
// 1. 字数与预计时长
// ---------------------------------------------------------------------------

export type ScriptBudgetStatus = 'too_short' | 'qualified' | 'too_long';

export interface ScriptLiveMetrics {
  targetTotalSec: number;
  /** 片头时长（秒）：20 帧 / 24fps，不算口播。 */
  introDurationSec: number;
  /** 字数：只数字母与数字，不算标点（与生成侧同一口径）。 */
  characterCount: number;
  /** 预计口播时长（秒），保留一位小数。 */
  estimatedNarrationSec: number;
  minContentCharacters: number;
  maxContentCharacters: number;
  status: ScriptBudgetStatus;
  /** 界面提示：「在预算内」/「偏长」/「偏短」。 */
  label: '在预算内' | '偏长' | '偏短';
}

const BUDGET_LABELS: Record<ScriptBudgetStatus, ScriptLiveMetrics['label']> = {
  qualified: '在预算内',
  too_long: '偏长',
  too_short: '偏短',
};

/**
 * 一边打字一边算的字数/时长。目标时长非法时退到 15 秒（界面下拉只给白名单，
 * 这里只为「正在输入/历史上限外的旧任务」兜底，不改变预算规则本身）。
 */
export function scriptLiveMetrics(text: string, targetTotalSec: number): ScriptLiveMetrics {
  const target = Number.isFinite(targetTotalSec) && targetTotalSec > 0 ? targetTotalSec : 15;
  const budget = buildScriptDurationAdvisory(target);
  const characterCount = countScriptContentCharacters(text);
  const estimatedNarrationSec = Number(estimateNarrationDurationSec(characterCount).toFixed(1));
  const status: ScriptBudgetStatus = characterCount < budget.minContentCharacters
    ? 'too_short'
    : characterCount > budget.maxContentCharacters ? 'too_long' : 'qualified';
  return {
    targetTotalSec: target,
    introDurationSec: Number(budget.introDurationSec.toFixed(2)),
    characterCount,
    estimatedNarrationSec,
    minContentCharacters: budget.minContentCharacters,
    maxContentCharacters: budget.maxContentCharacters,
    status,
    label: BUDGET_LABELS[status],
  };
}

// ---------------------------------------------------------------------------
// 2. 卖点库：默认收起、默认全选
// ---------------------------------------------------------------------------

export interface SellingPointSelectionFlags {
  id: string;
  usable: number | boolean;
  disabledByUser: number | boolean;
  evidenceGate: string;
}

export interface SellingPointSummary {
  total: number;
  selected: number;
  excluded: number;
  unavailable: number;
  /** 一条都没被人工排除时，副标题写「默认全选」。 */
  allSelected: boolean;
  /** 卖点库默认收起：界面初始值就是这个，点「展开卖点」才逐个排除。 */
  collapsedByDefault: true;
}

function isUsablePoint(point: SellingPointSelectionFlags): boolean {
  return Boolean(point.usable) && !point.disabledByUser && point.evidenceGate !== 'failed';
}

/** 默认选中集合：可用卖点全选（排除项与未通过核验的都不算）。 */
export function defaultSelectedSellingPointIds(
  points: readonly SellingPointSelectionFlags[],
): string[] {
  return points.filter(isUsablePoint).map((point) => point.id);
}

export function summarizeSellingPoints(
  points: readonly SellingPointSelectionFlags[],
): SellingPointSummary {
  // 「排除」只看 `disabledByUser`：界面取消勾选时同时提交 usable=0 与 disabledByUser=1，
  // 所以不能要求 usable 仍为 1 才算排除。
  // 未通过核验（evidenceGate=failed）的卖点本来就不可选，不记成「用户排除的」。
  const excluded = points.filter(
    (point) => Boolean(point.disabledByUser) && point.evidenceGate !== 'failed',
  ).length;
  const selected = points.filter(isUsablePoint).length;
  return {
    total: points.length,
    selected,
    excluded,
    unavailable: Math.max(0, points.length - selected - excluded),
    allSelected: excluded === 0,
    collapsedByDefault: true,
  };
}

// ---------------------------------------------------------------------------
// 3. 爆文模板条数
// ---------------------------------------------------------------------------

/** 合计条数（展开数组的长度，同一模板重复出现即多条变体）。 */
export function countTemplateEntries(selectedIds: readonly string[]): number {
  return selectedIds.length;
}

/** 勾选 / 取消一个模板；合计不超过 `maxCount`（沿用现有 6 条）。 */
export function toggleTemplateEntry(
  selectedIds: readonly string[],
  entryId: string,
  maxCount: number = SCRIPT_GENERATION_MAX_COUNT,
): string[] {
  if (selectedIds.includes(entryId)) return selectedIds.filter((id) => id !== entryId);
  if (selectedIds.length >= maxCount) return [...selectedIds];
  return [...selectedIds, entryId];
}

/**
 * 调整某个模板的生成条数：保持该模板在生成顺序中的首个位置，其余模板顺序不变；
 * 合计超过上限或少于 1 条时原样返回（界面此时应禁用按钮）。
 */
export function setTemplateEntryCount(
  selectedIds: readonly string[],
  entryId: string,
  nextCount: number,
  maxCount: number = SCRIPT_GENERATION_MAX_COUNT,
): string[] {
  if (!Number.isInteger(nextCount) || nextCount < 1) return [...selectedIds];
  const others = selectedIds.filter((id) => id !== entryId).length;
  if (others + nextCount > maxCount) return [...selectedIds];
  if (!selectedIds.includes(entryId)) return [...selectedIds];
  const next: string[] = [];
  let placed = false;
  for (const id of selectedIds) {
    if (id !== entryId) {
      next.push(id);
      continue;
    }
    if (placed) continue;
    for (let index = 0; index < nextCount; index += 1) next.push(entryId);
    placed = true;
  }
  return next;
}

export interface TemplateSelectionSummary {
  /** 模板个数（去重）。 */
  templateCount: number;
  /** 合计条数（展开数组长度）。 */
  totalCount: number;
  /** 还能再加几条。 */
  remaining: number;
  atLimit: boolean;
  maxCount: number;
}

export function describeTemplateSelection(
  selectedIds: readonly string[],
  maxCount: number = SCRIPT_GENERATION_MAX_COUNT,
): TemplateSelectionSummary {
  return {
    templateCount: new Set(selectedIds).size,
    totalCount: selectedIds.length,
    remaining: Math.max(0, maxCount - selectedIds.length),
    atLimit: selectedIds.length >= maxCount,
    maxCount,
  };
}
