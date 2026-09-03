import { getScriptTemplate, type ScriptTemplateDefinition } from '../script-templates.ts';
import type { LibraryRevisionView } from './libraries.ts';
import type { KnowledgePlanRecommendation } from './template-catalog.ts';
import { parseScriptStudioRequestedCount } from './generation-contract.ts';

export interface PlannedScript {
  index: number;
  templateId: string;
  templateName: string;
  templateVersion: number;
  rationale: string;
  direction: string;
  angle: string;
  /** 知识/模板目录的推荐组合（框架/文案钩子/画面钩子）；未启用目录时为 undefined。 */
  recommendation?: KnowledgePlanRecommendation;
}

const DIVERSITY_ORDER = [
  'pain_point',
  'scene_seeding',
  'feature_showcase',
  'emotional',
  'comparison',
  'unboxing',
  'problem_solving',
] as const;

const ANGLES = [
  '先讲痛点再给证据',
  '用生活场景建立代入感',
  '逐项讲清机制与收益',
  '以真实情绪变化带动选择',
  '用明确对照凸显差异',
  '沿开箱到使用顺序走一遍',
  '从问题到解决方案闭环',
] as const;

function inferAudienceTone(
  revision: LibraryRevisionView,
  creativeBrief: string,
): { audience: string; tone: string; platform: string } {
  const category = revision.category || '';
  const brief = creativeBrief.trim();
  const audience = brief.match(/(?:针对|面向|给)[^，。；\n]{1,12}/)?.[0]
    ?.replace(/^(?:针对|面向|给)/, '').trim()
    || (category ? `关注${category}并正在做购买决策的人群` : '正在了解具体产品并准备做购买决策的人群');
  const tone = brief.includes('专业') || brief.includes('冷静') ? '专业克制'
    : brief.includes('活泼') || brief.includes('种草') ? '轻松种草'
      : '自然可信';
  const platform = brief.includes('小红书') ? '小红书'
    : brief.includes('抖音') ? '抖音'
      : brief.includes('视频号') ? '视频号'
        : '通用';
  return { audience, tone, platform };
}

export function planScriptDirections(
  revision: LibraryRevisionView,
  count: number,
  creativeBrief: string,
): { plans: PlannedScript[]; audience: string; tone: string; platform: string } {
  // 数量走共享契约:非法值直接拒绝,不再 Math.min/Math.floor 静默钳制。
  const requested = parseScriptStudioRequestedCount(count);
  const selectedIds: string[] = [];
  const pointTypes = new Set(revision.sellingPoints.map((point) => point.pointType));
  const preferred = DIVERSITY_ORDER.filter((id) => {
    const template = getScriptTemplate(id)!;
    const suitable = template.suitable;
    return pointTypes.size === 0
      || ['颜值/氛围型', '功能型卖点', '硬核参数型', '生活方式型', '有明确对比点', '安装简单/包装精致', '实用功能型']
        .some((type) => suitable.includes(type) || spread(type, suitable) > 0.2);
  });
  const ordered = [...new Set([...preferred, ...DIVERSITY_ORDER])];
  const plans = Array.from({ length: requested }, (_, index) => {
    const id = ordered[index % ordered.length]!;
    const template = getScriptTemplate(id)!;
    return {
      index: index + 1,
      templateId: template.id,
      templateName: template.name,
      templateVersion: template.version,
      rationale: template.objective,
      direction: template.name,
      angle: ANGLES[index % ANGLES.length]!,
    };
  });
  // 保证重复度门禁可测：多方案至少换切入角度，回落到不同模板。
  if (requested > 1 && new Set(plans.map((plan) => plan.templateId)).size !== requested) {
    DIVERSITY_ORDER.slice(0, requested).forEach((id, index) => {
      const template = getScriptTemplate(id)!;
      plans[index] = {
        ...plans[index]!,
        templateId: template.id,
        templateName: template.name,
        templateVersion: template.version,
        rationale: template.objective,
        direction: template.name,
        angle: ANGLES[index % ANGLES.length]!,
      };
    });
  }
  return {
    plans,
    ...inferAudienceTone(revision, creativeBrief),
  };
}

function spread(left: string, right: string): number {
  const a = new Set(left);
  const b = new Set(right);
  let overlap = 0;
  for (const item of a) if (b.has(item)) overlap += 1;
  return overlap / Math.max(1, Math.min(a.size, b.size));
}

export function plannedTemplate(id: string): ScriptTemplateDefinition | undefined {
  return getScriptTemplate(id);
}

/**
 * 把冻结的知识/模板目录推荐按 planIndex 合并进方案（方案 §2.7）。
 * 只在创建时冻结一次；runner 直接使用，不再查当前目录版本。
 * 推荐缺失的 plan 保持静态模板身份，方向卖点编排不受影响。
 */
export function applyKnowledgeRecommendations(
  plans: PlannedScript[],
  recommendations: KnowledgePlanRecommendation[],
): PlannedScript[] {
  if (!recommendations || recommendations.length === 0) return plans;
  const byIndex = new Map(recommendations.map((item) => [item.planIndex, item]));
  return plans.map((plan) => {
    const recommendation = byIndex.get(plan.index);
    if (!recommendation) return plan;
    return { ...plan, recommendation };
  });
}
