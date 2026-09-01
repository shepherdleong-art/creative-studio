import type { PlannedScript } from './planner.ts';
import { structuralGatePassed } from './evidence-gate.ts';
import {
  canonicalThemeKey,
  evidenceRefsOfRecord,
  isSellingPointEvidenceUsable,
  primaryPageIndexOf,
} from './selling-point-normalize.ts';
import type {
  ScriptStudioHierarchyRole,
  ScriptStudioPointType,
  SellingPointRecord,
} from './types.ts';

/**
 * 方向卖点包：脚本生成前由本地编排器为单个创意方向准备的小份候选上下文。
 * 模型只看到这份包而不是完整卖点库；required 为必须优先考虑的卖点。
 */
export interface DirectionSellingPointBrief {
  planIndex: number;
  templateId: string;
  themeKey: string;
  themeTitle: string;
  requiredPointIds: string[];
  optionalPointIds: string[];
  candidateCount: number;
  /** 方向组成未完全满足时为 true（降级填充），并在 rationale 中说明。 */
  degraded: boolean;
  rationale: string;
}

export interface PlanDirectionBriefsInput {
  sellingPoints: SellingPointRecord[];
  plans: PlannedScript[];
  targetDurationSec: number;
  /** 已保存证据的来源范围；复用历史卖点库时用于本地 fail-closed 重验。 */
  evidenceBounds?: { pageCount?: number; pageTileCounts?: number[] };
}

const HIERARCHY_ROLE_SCORE: Record<ScriptStudioHierarchyRole, number> = {
  primary: 3,
  supporting: 2,
  detail: 1,
};

const EVIDENCE_GATE_SCORE = { passed: 2, skipped: 1, failed: 0 } as const;

interface DirectionSlotRule {
  types: ScriptStudioPointType[];
  count: number;
  label: string;
}

interface DirectionRule {
  /** 方向类型匹配的优先级池（越靠前越优先）；空数组表示不限类型。 */
  typePreferences: ScriptStudioPointType[];
  /** 必选组成：按序填充；供给不足时降级为全局排序补位，并在理由中记录。 */
  requiredSlots: DirectionSlotRule[];
}

// 方向组成规则，对应设计文档第 4 节。feature_showcase 的跨主题强事实在选择阶段单独处理。
const DIRECTION_RULES: Record<string, DirectionRule> = {
  pain_point: {
    typePreferences: ['efficacy', 'structure', 'spec', 'certification'],
    requiredSlots: [
      { types: ['efficacy', 'structure'], count: 2, label: '解决问题的事实' },
      { types: ['certification', 'spec'], count: 1, label: '证据型事实' },
    ],
  },
  scene_seeding: {
    typePreferences: ['scenario', 'appearance', 'structure', 'efficacy'],
    requiredSlots: [
      { types: ['scenario', 'appearance'], count: 2, label: '体验/外观事实' },
      { types: ['structure', 'efficacy', 'spec'], count: 1, label: '功能支撑' },
    ],
  },
  feature_showcase: {
    typePreferences: [],
    requiredSlots: [],
  },
  comparison: {
    typePreferences: ['spec', 'structure', 'material', 'efficacy', 'certification'],
    requiredSlots: [
      { types: ['spec', 'structure', 'material', 'efficacy', 'certification'], count: 3, label: '可对比事实' },
    ],
  },
  unboxing: {
    typePreferences: ['appearance', 'structure', 'material', 'other'],
    requiredSlots: [
      { types: ['appearance', 'structure', 'material'], count: 3, label: '外观/结构/材质事实' },
    ],
  },
  problem_solving: {
    typePreferences: ['scenario', 'structure', 'efficacy', 'certification'],
    requiredSlots: [
      { types: ['scenario'], count: 1, label: '场景或问题' },
      { types: ['structure', 'efficacy'], count: 1, label: '结构/功能' },
      { types: ['certification', 'spec'], count: 1, label: '可核验结果' },
    ],
  },
  emotional: {
    typePreferences: ['scenario', 'appearance', 'material', 'structure'],
    requiredSlots: [
      { types: ['scenario', 'appearance', 'material'], count: 2, label: '情绪体验事实' },
      { types: ['structure', 'efficacy', 'spec'], count: 1, label: '功能支撑' },
    ],
  },
};

/**
 * 卖点包容量规则（每方向 6–10 条候选、3–5 条必选）。
 * 15 秒脚本为 8 候选 / 3 必选，落在设计要求的 6–8 / 2–3 区间内；其他时长按比例封顶。
 */
export function directionBriefLimits(targetDurationSec: number): { candidateLimit: number; requiredLimit: number } {
  const candidateLimit = Math.max(6, Math.min(10, Math.round(targetDurationSec / 2)));
  const requiredLimit = Math.max(3, Math.min(5, Math.round(targetDurationSec / 6)));
  return { candidateLimit, requiredLimit };
}

// 旧数据 themeKey 为空时按同一套 canonical 规则派生，保证老卖点库免重读图片即可编排。
function themeKeyOf(point: SellingPointRecord): string {
  if (point.themeKey) return point.themeKey;
  return canonicalThemeKey({
    pageIndex: primaryPageIndexOf(evidenceRefsOfRecord(point)) ?? point.sourcePageIndex,
    themeTitle: point.themeTitle,
    pointType: point.pointType,
  });
}

function themeTitleOf(point: Pick<SellingPointRecord, 'themeTitle' | 'title'>): string {
  return point.themeTitle || point.title;
}

interface ScoredPoint {
  point: SellingPointRecord;
  typeScore: number;
  repeatScore: number;
  themeBonus: number;
  roleScore: number;
  importance: number;
  evidenceScore: number;
}

function typeScoreOf(point: SellingPointRecord, templateId: string): number {
  const preferences = DIRECTION_RULES[templateId]?.typePreferences || [];
  if (preferences.length === 0) return 1;
  const index = preferences.indexOf(point.pointType);
  return index < 0 ? 0 : preferences.length - index;
}

function roleScoreOf(point: SellingPointRecord): number {
  return HIERARCHY_ROLE_SCORE[point.hierarchyRole] ?? HIERARCHY_ROLE_SCORE.supporting;
}

function evidenceScoreOf(point: SellingPointRecord): number {
  return EVIDENCE_GATE_SCORE[point.evidenceGate] ?? 0;
}

function storedEvidenceIsStructurallyUsable(
  point: SellingPointRecord,
  bounds: NonNullable<PlanDirectionBriefsInput['evidenceBounds']>,
): boolean {
  return structuralGatePassed({
    title: point.title,
    factText: point.factText,
    evidenceQuote: point.evidenceQuote,
    sourcePageIndex: point.sourcePageIndex,
    evidenceRefs: evidenceRefsOfRecord(point),
  }, bounds).ok;
}

/**
 * 评分优先级：方向类型匹配 > 本轮重复惩罚 > 主主题连贯 > 主题角色 > 提取重要度 > 证据状态。
 * 重复惩罚提到第二位：已使用卖点会真实让位给未使用卖点，而不是只在完全同分时生效；
 * 主主题只是加分项，不会把方向不匹配的卖点塞进必选。同分按 seq/id 回退，保证确定性。
 */
function compareScored(left: ScoredPoint, right: ScoredPoint): number {
  return (right.typeScore - left.typeScore)
    || (left.repeatScore - right.repeatScore)
    || (right.themeBonus - left.themeBonus)
    || (right.roleScore - left.roleScore)
    || (right.importance - left.importance)
    || (right.evidenceScore - left.evidenceScore)
    || (left.point.seq - right.point.seq)
    || left.point.id.localeCompare(right.point.id);
}

/**
 * 本地确定性编排：一次接收卖点库、全部脚本计划与目标时长，一次返回全部方向卖点包。
 * 证据边界 fail closed：evidenceGate=failed、usable=0 或被用户禁用的卖点一律不进入卖点包。
 * 按 plan 顺序编排并维护修订级使用次数，已使用的卖点与主题对后续方向降权；
 * 事实不足时允许核心主题重复，不追求绝对不重复。
 */
export function planDirectionBriefs(input: PlanDirectionBriefsInput): DirectionSellingPointBrief[] {
  const { candidateLimit, requiredLimit } = directionBriefLimits(input.targetDurationSec);
  const eligible = input.sellingPoints.filter((point) => (
    isSellingPointEvidenceUsable(point)
    && storedEvidenceIsStructurallyUsable(point, input.evidenceBounds ?? {})
  ));
  const pointUsage = new Map<string, number>();
  const themeUsage = new Map<string, number>();
  const typeUsage = new Map<string, number>();

  return input.plans.map((plan) => {
    const score = (mainTheme: string): ScoredPoint[] => eligible.map((point) => ({
      point,
      typeScore: typeScoreOf(point, plan.templateId),
      repeatScore: (pointUsage.get(point.id) ?? 0) * 2 + (themeUsage.get(themeKeyOf(point)) ?? 0),
      themeBonus: themeKeyOf(point) === mainTheme ? 1 : 0,
      roleScore: roleScoreOf(point),
      importance: point.importance,
      evidenceScore: evidenceScoreOf(point),
    })).sort(compareScored);

    // 先按无主主题加分排出头部确定主主题；feature_showcase 要保持跨主题，不做主题加分。
    const firstPass = score('');
    const mainThemeKey = firstPass[0] ? themeKeyOf(firstPass[0].point) : '';
    const ranked = plan.templateId === 'feature_showcase' ? firstPass : score(mainThemeKey);

    const required: ScoredPoint[] = [];
    const degradedSlots: string[] = [];
    if (plan.templateId === 'feature_showcase') {
      // 卖点直给：优先从 3 个不同主题各取 1 条强事实；主题不足时按序补齐。
      const seenThemes = new Set<string>();
      for (const item of ranked) {
        const key = themeKeyOf(item.point);
        if (seenThemes.has(key)) continue;
        seenThemes.add(key);
        required.push(item);
        if (required.length >= Math.max(3, requiredLimit)) break;
      }
      if (required.length < Math.min(3, requiredLimit)) degradedSlots.push('跨主题强事实');
    } else {
      // 其余方向：按方向组成规则逐槽填充，槽内类型不足时降级为全局排序补位。
      const slots = DIRECTION_RULES[plan.templateId]?.requiredSlots || [];
      for (const slot of slots) {
        let filled = 0;
        for (const item of ranked) {
          if (filled >= slot.count) break;
          if (required.includes(item)) continue;
          if (!slot.types.includes(item.point.pointType)) continue;
          required.push(item);
          filled += 1;
        }
        if (filled < slot.count) degradedSlots.push(slot.label);
      }
    }
    for (const item of ranked) {
      if (required.length >= requiredLimit) break;
      if (!required.includes(item)) required.push(item);
    }

    const requiredIds = new Set(required.map((item) => item.point.id));
    const optionalPool = ranked.filter((item) => !requiredIds.has(item.point.id));
    // 可选槽位先补给本轮尚未使用的方向内类型：类型分数是硬优先，
    // 仅靠排序时惩罚无法让未使用的次级类型上位，多方向会拿到完全相同的卖点包。
    // 方向类型池之外的卖点不参与这次提拔，保证方向匹配不被稀释。
    const freshTyped = optionalPool.filter((item) => item.typeScore > 0
      && (typeUsage.get(item.point.pointType) ?? 0) === 0
      && (pointUsage.get(item.point.id) ?? 0) === 0);
    const optional = [
      ...freshTyped,
      ...optionalPool.filter((item) => !freshTyped.includes(item)),
    ].slice(0, Math.max(0, candidateLimit - required.length));

    for (const item of [...required, ...optional]) {
      pointUsage.set(item.point.id, (pointUsage.get(item.point.id) ?? 0) + 1);
      const key = themeKeyOf(item.point);
      themeUsage.set(key, (themeUsage.get(key) ?? 0) + 1);
      typeUsage.set(item.point.pointType, (typeUsage.get(item.point.pointType) ?? 0) + 1);
    }

    const mainThemeTitle = required[0] ? themeTitleOf(required[0].point) : '';
    const candidateCount = required.length + optional.length;
    const degraded = degradedSlots.length > 0;
    return {
      planIndex: plan.index,
      templateId: plan.templateId,
      themeKey: mainThemeKey,
      themeTitle: mainThemeTitle,
      requiredPointIds: required.map((item) => item.point.id),
      optionalPointIds: optional.map((item) => item.point.id),
      candidateCount,
      degraded,
      rationale: `方向 ${plan.templateId}：主主题「${mainThemeTitle || mainThemeKey || '无'}」，必选 ${required.length} 条 / 候选 ${candidateCount} 条；`
        + '按方向类型匹配>本轮重复惩罚>主主题连贯>主题角色>提取重要度>证据状态排序'
        + (degraded ? `；组成不足已降级补位（${degradedSlots.join('、')}）` : ''),
    };
  });
}
