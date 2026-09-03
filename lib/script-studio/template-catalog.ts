import type {
  CopyHookTemplateView,
  FrameworkTemplateView,
  VisualHookTemplateView,
} from './catalogs.ts';
import type { ScriptStudioPointType } from './types.ts';

/**
 * 模板目录推荐引擎（方案 §2.7 / §5.3 / Phase 5）。
 * - 从已启用且有效的模板条目中，按详情页证据卖点类型、品类心智与本轮多方案去重，
 *   确定性地为每个方案推荐核心框架、文案钩子与画面钩子；
 * - 同批多条方案在供给充足时使用不同框架或钩子组合；
 * - 「换一个」通过排除列表排除当前组合，返回的新推荐具有与再生成相同的幂等语义；
 * - 无模板修订或条目不足时安全回落（usedCatalog=false + 明确 warning），不改现有静态模板流程。
 *
 * 推荐只提供称呼、结构与表达方向，不自动成为可写入正文的产品事实。
 */

export interface RecommendedFramework {
  id: string;
  stableKey: string;
  name: string;
  structure: string[];
  rationale: string;
}

export interface RecommendedCopyHook {
  id: string;
  stableKey: string;
  type: string;
  subtype: string;
  formula: string;
  example: string;
  rationale: string;
}

export interface RecommendedVisualHook {
  id: string;
  stableKey: string;
  group: string;
  name: string;
  formula: string;
  guidance: string;
  referenceAssetIds: string[];
  rationale: string;
}

export interface KnowledgePlanRecommendation {
  planIndex: number;
  framework: RecommendedFramework | null;
  copyHook: RecommendedCopyHook | null;
  visualHook: RecommendedVisualHook | null;
}

export interface RecommendationExclusions {
  frameworkKeys?: string[];
  copyHookKeys?: string[];
  visualHookKeys?: string[];
}

export interface RecommendTemplateInput {
  /** 冻结的模板目录修订 ID；null 表示未启用/无目录。 */
  revisionId: string | null;
  count: number;
  pointTypes: ScriptStudioPointType[];
  categoryMindsets: string[];
  primarySellingPoints: string[];
  exclusions?: RecommendationExclusions;
}

export interface RecommendTemplateResult {
  plans: KnowledgePlanRecommendation[];
  /** 是否真正使用了目录条目（false 表示回落静态模板）。 */
  usedCatalog: boolean;
  warning: string | null;
}

export interface TemplateCatalogSource {
  frameworks: FrameworkTemplateView[];
  copyHooks: CopyHookTemplateView[];
  visualHooks: VisualHookTemplateView[];
}

function normalize(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

function textOverlaps(text: string, keywords: string[]): boolean {
  const target = normalize(text);
  if (!target) return false;
  return keywords.some((keyword) => normalize(keyword) && target.includes(normalize(keyword)));
}

/** 证据卖点枚举类型 → 中文信号词，用于与框架名称/细分/适用品类做文本重叠打分。 */
const POINT_TYPE_LABELS: Record<ScriptStudioPointType, string[]> = {
  appearance: ['外观', '颜值', '设计', '造型'],
  structure: ['结构', '内部'],
  scenario: ['场景', '生活', '需求'],
  spec: ['参数', '规格', '尺寸', '配置'],
  material: ['材质', '面料', '木材', '皮革'],
  certification: ['认证', '检测', '环保'],
  efficacy: ['功效', '效果', '痛点', '解决', '性能'],
  other: [],
};

/**
 * 框架适用性打分（方案 §2.7：按证据卖点类型、品类心智、主卖点选择核心框架）：
 * 品类心智/主卖点/证据卖点类型文本命中优先，具体适用品类匹配高于全品类兜底。
 */
function frameworkScore(framework: FrameworkTemplateView, input: Pick<RecommendTemplateInput, 'categoryMindsets' | 'primarySellingPoints' | 'pointTypes'>): number {
  let score = 0;
  const applicable = framework.applicableProducts ?? [];
  if (textOverlaps(framework.name, input.categoryMindsets)) score += 3;
  if (textOverlaps(framework.name, input.primarySellingPoints)) score += 2;
  // 证据卖点类型：把枚举类型映射成中文信号，命中框架名称/细分/适用品类时给分。
  // 首次提取（任务创建时卖点尚未抽出）为空数组时不产生加分，属既定顺序限制。
  const pointHints = (input.pointTypes ?? []).flatMap((type) => POINT_TYPE_LABELS[type] ?? []);
  if (pointHints.length > 0) {
    const frameworkText = `${framework.name} ${framework.subtype ?? ''} ${applicable.join(' ')}`;
    if (textOverlaps(frameworkText, pointHints)) score += 3;
  }
  if (applicable.some((item) => input.categoryMindsets.some((mindset) => normalize(item) !== '全品类' && normalize(item).includes(normalize(mindset))))) score += 2;
  if (applicable.some((item) => normalize(item).includes('全品类'))) score += 1;
  return score;
}

/** 根据推荐框架的首选/次选钩子类型，从有效文案钩子里选具体公式。 */
function pickCopyHook(
  framework: FrameworkTemplateView,
  copyHooks: CopyHookTemplateView[],
  excludedKeys: Set<string>,
  seen: Set<string>,
): RecommendedCopyHook | null {
  const hookTypeOrder = [
    ...(framework.preferredHookTypes ?? []),
    ...(framework.secondaryHookTypes ?? []),
  ];
  const candidates = copyHooks.filter((hook) => hook.status === 'active' && !excludedKeys.has(hook.stableKey));
  // 与同批已选钩子保持差异：同一类型尽量换不同公式。
  const fresh = candidates.filter((hook) => !seen.has(`${hook.hookType}:${hook.subtype}`));
  const pool = fresh.length > 0 ? fresh : candidates;
  for (const preferredType of hookTypeOrder) {
    const typeMatch = pool.filter((hook) => normalize(hook.hookType).includes(normalize(preferredType)) || normalize(preferredType).includes(normalize(hook.hookType)));
    if (typeMatch.length > 0) {
      const chosen = typeMatch[0]!;
      seen.add(`${chosen.hookType}:${chosen.subtype}`);
      return {
        id: chosen.id,
        stableKey: chosen.stableKey,
        type: chosen.hookType,
        subtype: chosen.subtype,
        formula: chosen.formula,
        example: chosen.example,
        rationale: `框架「${framework.name}」首选钩子类型「${preferredType}」，取公式「${chosen.subtype}」`,
      };
    }
  }
  // 首选/次选类型都不足时，退回任意有效文案钩子（保持差异优先）。
  if (candidates.length > 0) {
    const chosen = candidates[0]!;
    seen.add(`${chosen.hookType}:${chosen.subtype}`);
    return {
      id: chosen.id,
      stableKey: chosen.stableKey,
      type: chosen.hookType,
      subtype: chosen.subtype,
      formula: chosen.formula,
      example: chosen.example,
      rationale: `框架「${framework.name}」无匹配首选/次选钩子，取通用有效文案钩子「${chosen.subtype}」`,
    };
  }
  return null;
}

/** 根据品类、框架与钩子标签，从有效画面钩子里选玩法；draft_invalid 不进入推荐池。 */
function pickVisualHook(
  framework: FrameworkTemplateView,
  copyHook: RecommendedCopyHook | null,
  visualHooks: VisualHookTemplateView[],
  categoryMindsets: string[],
  excludedKeys: Set<string>,
  seen: Set<string>,
): RecommendedVisualHook | null {
  const candidates = visualHooks.filter((hook) => hook.status === 'active' && !excludedKeys.has(hook.stableKey));
  if (candidates.length === 0) return null;
  const hookTags = copyHook ? [copyHook.type, ...(framework.preferredHookTypes ?? [])] : (framework.preferredHookTypes ?? []);
  const score = (hook: VisualHookTemplateView): number => {
    let s = 0;
    const tags = hook.hookTags ?? [];
    const products = hook.applicableProducts ?? [];
    if (tags.some((tag) => hookTags.some((ht) => normalize(tag).includes(normalize(ht)) || normalize(ht).includes(normalize(tag))))) s += 3;
    if (products.some((item) => categoryMindsets.some((mindset) => normalize(item).includes(normalize(mindset))))) s += 2;
    if (products.some((item) => normalize(item).includes('全品类'))) s += 1;
    return s;
  };
  const ranked = [...candidates].sort((a, b) => (score(b) - score(a)) || a.stableKey.localeCompare(b.stableKey));
  const fresh = ranked.filter((hook) => !seen.has(hook.stableKey));
  const chosen = (fresh.length > 0 ? fresh : ranked)[0]!;
  seen.add(chosen.stableKey);
  return {
    id: chosen.id,
    stableKey: chosen.stableKey,
    group: chosen.playGroup,
    name: chosen.playName,
    formula: chosen.visualFormula,
    guidance: chosen.implementationAdvice,
    referenceAssetIds: chosen.assetIds ?? [],
    rationale: `按品类/框架/钩子标签评分，取画面玩法「${chosen.playName}」`,
  };
}

/**
 * 从冻结修订解析目录条目（纯数据加载）。调用方先把修订视图读出来，
 * 再交给 recommendFromCatalog 生成推荐——保证任务冻结的是修订快照而非当前版本。
 */
export function resolveTemplateCatalogSource(input: {
  frameworks: FrameworkTemplateView[];
  copyHooks: CopyHookTemplateView[];
  visualHooks: VisualHookTemplateView[];
}): TemplateCatalogSource {
  return {
    frameworks: (input.frameworks ?? []).filter((item) => item.status === 'active'),
    copyHooks: (input.copyHooks ?? []).filter((item) => item.status === 'active'),
    visualHooks: (input.visualHooks ?? []).filter((item) => item.status === 'active'),
  };
}

export function recommendFromCatalog(
  source: TemplateCatalogSource,
  input: RecommendTemplateInput,
): RecommendTemplateResult {
  const count = Math.max(1, Math.floor(Number(input.count) || 1));
  const excludedFrameworkKeys = new Set(input.exclusions?.frameworkKeys ?? []);
  const excludedCopyHookKeys = new Set(input.exclusions?.copyHookKeys ?? []);
  const excludedVisualHookKeys = new Set(input.exclusions?.visualHookKeys ?? []);
  const mindsets = input.categoryMindsets ?? [];

  if (source.frameworks.length === 0) {
    return {
      plans: [],
      usedCatalog: false,
      warning: '脚本模板库没有可用核心框架，已按现有静态模板生成',
    };
  }

  // 框架排序：适用性得分降序，同分按稳定键升序，保证确定性。
  const rankedFrameworks = [...source.frameworks]
    .filter((framework) => !excludedFrameworkKeys.has(framework.stableKey))
    .sort((a, b) => (frameworkScore(b, { ...input, categoryMindsets: mindsets }) - frameworkScore(a, { ...input, categoryMindsets: mindsets })) || a.stableKey.localeCompare(b.stableKey));
  if (rankedFrameworks.length === 0) {
    return {
      plans: [],
      usedCatalog: false,
      warning: '排除当前组合后没有可用的核心框架，已按现有静态模板生成',
    };
  }

  const seenCopy = new Set<string>();
  const seenVisual = new Set<string>();
  const plans: KnowledgePlanRecommendation[] = [];
  for (let index = 0; index < count; index += 1) {
    // 多方案差异：供给充足时按序轮换不同框架，不足时才循环复用。
    const framework = rankedFrameworks[index % rankedFrameworks.length]!;
    const copyHook = pickCopyHook(framework, source.copyHooks, excludedCopyHookKeys, seenCopy);
    const visualHook = pickVisualHook(framework, copyHook, source.visualHooks, mindsets, excludedVisualHookKeys, seenVisual);
    plans.push({
      planIndex: index + 1,
      framework: {
        id: framework.id,
        stableKey: framework.stableKey,
        name: framework.name,
        structure: framework.structure ?? [],
        rationale: `按证据卖点类型/品类心智/主卖点评分，选核心框架「${framework.name}」`,
      },
      copyHook,
      visualHook,
    });
  }
  return { plans, usedCatalog: true, warning: null };
}
