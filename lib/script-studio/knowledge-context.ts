import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getCatalogCurrentRevisionId, getCatalogRevisionView, matchStrategyEntry, type StrategyEntryView } from './catalogs.ts';
import { normalizeModelKey } from './catalog-import/normalize.ts';
import {
  recommendFromCatalog,
  resolveTemplateCatalogSource,
  type KnowledgePlanRecommendation,
  type RecommendationExclusions,
} from './template-catalog.ts';
import type { ScriptStudioPointType } from './types.ts';

/**
 * 任务创建时的知识上下文冻结（方案 §2.6-§2.8 / Phase 5）：
 * - 创建任务时按锁定规则匹配型号，并把策略匹配结果、模板推荐与来源修订身份一起冻结；
 * - 冻结后的快照进入任务 canonical identity；已排队任务以快照执行，
 *   设置页切换当前目录版本不改变运行中任务；
 * - 未命中型号不阻断：matchStatus='unmatched'，仍按现有详情页流程生成。
 */

export interface FrozenStrategyContext {
  matchStatus: 'matched' | 'unmatched';
  strategyCatalogRevisionId: string | null;
  strategyEntryId: string | null;
  normalizedModelKey: string | null;
  canonicalName: string | null;
  searchTerms: string[];
  primarySellingPoints: string[];
  differentiators: string[];
  categoryMindsets: string[];
  sourceRows: Array<number | string>;
}

export interface FrozenTemplateContext {
  templateCatalogRevisionId: string | null;
  usedCatalog: boolean;
  fallbackWarning: string | null;
}

export interface FrozenKnowledgeContext {
  strategy: FrozenStrategyContext;
  template: FrozenTemplateContext;
  recommendations: KnowledgePlanRecommendation[];
  /** 「换一个」的排除列表原样冻结进快照，供追溯与稳定幂等（断线重试同动作不重复建任务）。 */
  exclusions?: RecommendationExclusions;
  /** 对知识上下文的规范序列化做 SHA-256，参与任务 requestKey 的派生身份。 */
  fingerprint: string;
}

export interface ResolveKnowledgeContextInput {
  modelKey: string;
  submodel?: string;
  requestedCount: number;
  pointTypes: ScriptStudioPointType[];
  exclusions?: RecommendationExclusions;
}

function toStrategyView(db: Database.Database, entryId: string): StrategyEntryView | null {
  const row = db.prepare(`SELECT revisionId FROM script_studio_strategy_entries WHERE id = ?`).get(entryId) as { revisionId: string } | undefined;
  if (!row) return null;
  const revision = getCatalogRevisionView(db, row.revisionId);
  if (!revision) return null;
  return revision.strategyEntries.find((entry) => entry.id === entryId) ?? null;
}

/** 与 matchStrategyEntry 的查询键同一条归一化口径（normalizeModelKey），用于未命中时记录「查过哪个型号键」。 */
function normalizeModelKeyForContext(modelKey: string, submodel?: string): string {
  return normalizeModelKey(submodel ? `${modelKey}-${submodel}` : modelKey);
}

function strategyContextFromEntry(entry: StrategyEntryView, revisionId: string): FrozenStrategyContext {
  return {
    matchStatus: 'matched',
    strategyCatalogRevisionId: revisionId,
    strategyEntryId: entry.id,
    normalizedModelKey: entry.normalizedModelKey,
    canonicalName: entry.canonicalName,
    searchTerms: entry.searchTerms ?? [],
    primarySellingPoints: entry.primarySellingPoints ?? [],
    differentiators: entry.differentiators ?? [],
    categoryMindsets: entry.categoryMindsets ?? [],
    sourceRows: entry.sourceRows ?? [],
  };
}

function unmatchedContext(strategyRevisionId: string | null, normalizedModelKey: string): FrozenStrategyContext {
  return {
    matchStatus: 'unmatched',
    // 未命中也要保留「查过哪一版策略」与匹配用的型号键：两个不同策略版本即使都未命中，
    // 也会因 revisionId/normalizedModelKey 不同而得到不同 fingerprint/requestKey。
    strategyCatalogRevisionId: strategyRevisionId,
    strategyEntryId: null,
    normalizedModelKey,
    canonicalName: null,
    searchTerms: [],
    primarySellingPoints: [],
    differentiators: [],
    categoryMindsets: [],
    sourceRows: [],
  };
}

/**
 * 解析并冻结知识上下文。只在任务创建时调用一次；结果写入 inputSnapshot，
 * 之后 runner 只读快照，不再查当前目录。
 */
export function resolveKnowledgeContext(
  db: Database.Database,
  input: ResolveKnowledgeContextInput,
): FrozenKnowledgeContext {
  const strategyLookup = matchStrategyEntry(db, 'strategy', input.modelKey, input.submodel);
  const strategy: FrozenStrategyContext = strategyLookup
    ? strategyContextFromEntry(strategyLookup.view, strategyLookup.revisionId)
    : unmatchedContext(
        getCatalogCurrentRevisionId(db, 'strategy'),
        normalizeModelKeyForContext(input.modelKey, input.submodel),
      );

  const templateRevisionId = (() => {
    const row = db.prepare(`SELECT currentRevisionId FROM script_studio_catalogs WHERE kind = 'template'`).get() as { currentRevisionId: string | null } | undefined;
    return row?.currentRevisionId ?? null;
  })();
  let template: FrozenTemplateContext = {
    templateCatalogRevisionId: templateRevisionId,
    usedCatalog: false,
    fallbackWarning: null,
  };
  let recommendations: KnowledgePlanRecommendation[] = [];
  if (templateRevisionId) {
    const view = getCatalogRevisionView(db, templateRevisionId);
    if (view) {
      const source = resolveTemplateCatalogSource({
        frameworks: view.frameworkTemplates,
        copyHooks: view.copyHookTemplates,
        visualHooks: view.visualHookTemplates,
      });
      const result = recommendFromCatalog(source, {
        revisionId: templateRevisionId,
        count: input.requestedCount,
        pointTypes: input.pointTypes,
        categoryMindsets: strategy.categoryMindsets,
        primarySellingPoints: strategy.primarySellingPoints,
        exclusions: input.exclusions,
      });
      template = {
        templateCatalogRevisionId: templateRevisionId,
        usedCatalog: result.usedCatalog,
        fallbackWarning: result.warning,
      };
      recommendations = result.plans;
    }
  }

  const fingerprint = createHash('sha256')
    .update(JSON.stringify({
      strategy,
      template,
      recommendations,
      exclusions: input.exclusions ?? null,
    }))
    .digest('hex');

  return { strategy, template, recommendations, exclusions: input.exclusions, fingerprint };
}

export function serializeKnowledgeContext(context: FrozenKnowledgeContext): Record<string, unknown> {
  return {
    strategy: context.strategy,
    template: context.template,
    recommendations: context.recommendations,
    exclusions: context.exclusions,
    fingerprint: context.fingerprint,
  };
}

export function parseKnowledgeContext(value: unknown): FrozenKnowledgeContext | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const strategy = record.strategy as FrozenStrategyContext | undefined;
  const template = record.template as FrozenTemplateContext | undefined;
  if (!strategy || typeof strategy.matchStatus !== 'string') return null;
  if (!template || typeof template.usedCatalog !== 'boolean') return null;
  const recommendations = Array.isArray(record.recommendations) ? record.recommendations as KnowledgePlanRecommendation[] : [];
  const fingerprint = typeof record.fingerprint === 'string' ? record.fingerprint : '';
  const exclusions = record.exclusions && typeof record.exclusions === 'object' && !Array.isArray(record.exclusions)
    ? record.exclusions as RecommendationExclusions
    : undefined;
  return {
    strategy,
    template,
    recommendations,
    exclusions,
    fingerprint,
  };
}
