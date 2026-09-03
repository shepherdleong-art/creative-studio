import { normalizeAutomaticSubtitleText } from '../subtitle-display.ts';
import { buildScriptDurationBudget, countScriptContentCharacters, estimateNarrationDurationSec } from '../script-duration-policy.ts';
import type { DirectionSellingPointBrief } from './direction-briefs.ts';
import type { LibraryRevisionView } from './libraries.ts';
import type { PlannedScript } from './planner.ts';
import type { ScriptStudioCompleteJson } from './llm-contract.ts';
import { isSellingPointEvidenceUsable } from './selling-point-normalize.ts';
import { embeddingRequirementText, checkTitleEmbedding, matchedSearchTerms } from './title-embedding.ts';
import type { FrozenKnowledgeContext } from './knowledge-context.ts';
import type {
  ScriptStudioScriptContent,
  ScriptStudioSegmentContent,
  SellingPointRecord,
} from './types.ts';

export interface ScriptGeneratorInput {
  libraryRevision: LibraryRevisionView;
  plan: PlannedScript;
  /** 当前方向的本地编排卖点包；Script Studio 正式流程必须提供，模型只能看到包内候选。 */
  brief: DirectionSellingPointBrief;
  audience: string;
  tone: string;
  platform: string;
  creativeBrief: string;
  targetDurationSec: number;
  previousScripts: Array<Pick<ScriptStudioScriptContent, 'fullScript'>>;
  signal?: AbortSignal;
  validationFeedback?: string[];
  /** 任务创建时冻结的知识上下文；仅用于标题埋词与推荐说明，不扩大事实来源。 */
  knowledgeContext?: FrozenKnowledgeContext;
}

/**
 * 生成边界（fail closed）：只返回卖点包内且通过证据门槛的候选（必选在前、按编排顺序）。
 * 缺少 brief 时返回空而不是回退完整卖点库——方向编排不可绕过；
 * evidenceGate=failed 的卖点即使 usable 被重新打开也一律排除。
 */
export function briefCandidatePoints(input: ScriptGeneratorInput): SellingPointRecord[] {
  if (!input.brief) return [];
  const byId = new Map(
    input.libraryRevision.sellingPoints
      .filter(isSellingPointEvidenceUsable)
      .map((point) => [point.id, point]),
  );
  const ordered: SellingPointRecord[] = [];
  for (const id of [...input.brief.requiredPointIds, ...input.brief.optionalPointIds]) {
    const point = byId.get(id);
    if (point) ordered.push(point);
  }
  return ordered;
}

export interface ScriptGenerator {
  generate(input: ScriptGeneratorInput): Promise<{ content: ScriptStudioScriptContent; attempts: number }>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringArray(value: unknown): string[] {
  return asArray(value).map(asString).filter(Boolean);
}

export function buildScriptPrompt(
  input: ScriptGeneratorInput,
): { systemPrompt: string; userPrompt: string } {
  const library = input.libraryRevision;
  const candidates = briefCandidatePoints(input);
  const requiredIds = new Set(input.brief.requiredPointIds);
  const budget = buildScriptDurationBudget(input.targetDurationSec);
  const requirements = [
    '只能使用上面方向卖点包中的事实，priority=required 的卖点必须优先考虑；不得新增功效、数字、材质或认证',
    '完整返回主标题、副标题、分段口播、画面意图与关键词',
    `口播总字数必须落在目标时长预算内（${budget.minContentCharacters}-${budget.maxContentCharacters} 字）`,
    '同一轮多条方案必须在开场、结构或卖点组合上明显不同',
  ];
  const embeddingText = input.knowledgeContext
    ? embeddingRequirementText({
        matchStatus: input.knowledgeContext.strategy.matchStatus,
        canonicalName: input.knowledgeContext.strategy.canonicalName,
        searchTerms: input.knowledgeContext.strategy.searchTerms,
      })
    : null;
  if (embeddingText) requirements.push(embeddingText);
  if (input.validationFeedback?.length) {
    requirements.push(`上一轮未通过：${input.validationFeedback.slice(0, 5).join('；')}；请只修复这些问题，不要改变已合规内容`);
  }
  const recommendation = input.plan.recommendation;
  const templateBlock = {
    id: input.plan.templateId,
    name: input.plan.templateName,
    version: input.plan.templateVersion,
    rationale: input.plan.rationale,
  };
  const recommendationBlock = recommendation
    ? {
        framework: recommendation.framework ? {
          id: recommendation.framework.id,
          stableKey: recommendation.framework.stableKey,
          name: recommendation.framework.name,
          structure: recommendation.framework.structure,
          rationale: recommendation.framework.rationale,
        } : null,
        copyHook: recommendation.copyHook ? {
          type: recommendation.copyHook.type,
          subtype: recommendation.copyHook.subtype,
          formula: recommendation.copyHook.formula,
          example: recommendation.copyHook.example,
        } : null,
        visualHook: recommendation.visualHook ? {
          group: recommendation.visualHook.group,
          name: recommendation.visualHook.name,
          formula: recommendation.visualHook.formula,
          guidance: recommendation.visualHook.guidance,
        } : null,
      }
    : null;
  return {
    systemPrompt: '你是电商短视频口播编剧。只返回一个 JSON 对象，不输出解释。不得绑定具体视频、素材顺序或 shotId。',
    userPrompt: JSON.stringify({
      task: 'generate_project_script_v1',
      product: {
        name: library.productName || '',
        category: library.category || '',
        brand: library.brand || '',
      },
      audience: input.audience,
      tone: input.tone,
      platform: input.platform,
      creativeBrief: input.creativeBrief,
      direction: input.plan.angle,
      ...(input.brief?.themeTitle ? { theme: input.brief.themeTitle } : {}),
      template: templateBlock,
      ...(recommendationBlock ? { recommendation: recommendationBlock } : {}),
      sellingPoints: candidates.map((point) => ({
        id: point.id,
        title: point.title,
        factText: point.factText,
        pointType: point.pointType,
        evidenceQuote: point.evidenceQuote,
        priority: requiredIds.has(point.id) ? 'required' : 'optional',
      })),
      targetDurationSec: input.targetDurationSec,
      output: {
        title: 'string；4-16 字方案名',
        coverTitleParts: {
          primary: 'string；4-12 字，包含具体产品品类',
          secondary: 'string；4-10 字，场景向往或购买理由',
        },
        direction: 'string；20 字以内的切入角度摘要',
        segments: [{
          narration: 'string；带自然标点的口播',
          sellingPointIdRefs: ['string；只引用 sellingPoints.id'],
          visualIntent: 'string；抽象画面意图',
          visualKeywords: ['string；具体可见画面关键词'],
        }],
        sellingPointUsage: [{
          sellingPointId: 'string',
          status: 'used|omitted|omitted_no_visual_support',
          reason: 'string',
        }],
      },
      requirements,
    }),
  };
}

function parseCoverParts(raw: Record<string, unknown>): { primary: string; secondary: string } {
  const cover = asRecord(raw.coverTitleParts);
  const primary = asString(cover.primary);
  const secondary = asString(cover.secondary);
  if (!primary || !secondary) throw new Error('generated_script_cover_title_invalid');
  return { primary, secondary };
}

function parseSegments(
  raw: Record<string, unknown>,
  usableIds: Set<string>,
  fallback: LibraryRevisionView['sellingPoints'],
): ScriptStudioSegmentContent[] {
  const rawSegments = asArray(raw.segments).map(asRecord);
  if (rawSegments.length === 0) throw new Error('generated_script_segments_empty');
  const segments: ScriptStudioSegmentContent[] = [];
  rawSegments.forEach((segment, index) => {
    const narration = asString(segment.narration);
    if (!narration) throw new Error(`generated_script_segment_empty:${index + 1}`);
    const sellingPointIdRefs = stringArray(segment.sellingPointIdRefs || segment.sellingPointIds);
    const validRefs = sellingPointIdRefs.filter((id) => usableIds.has(id));
    segments.push({
      id: asString(segment.id) || `segment-${index + 1}`,
      narration,
      subtitle: normalizeAutomaticSubtitleText(narration),
      sellingPointIdRefs: validRefs,
      sellingPointRefs: validRefs.map((id) => fallback.find((point) => point.id === id)?.title || ''),
      visualIntent: asString(segment.visualIntent),
      visualKeywords: stringArray(segment.visualKeywords),
    });
  });
  return segments;
}

function parseUsage(
  raw: Record<string, unknown>,
  fallback: LibraryRevisionView['sellingPoints'],
  usedIds: Set<string>,
): ScriptStudioScriptContent['sellingPointUsage'] {
  const usage = asArray(raw.sellingPointUsage).map(asRecord);
  return fallback.map((point) => {
    const item = usage.find((value) => asString(value.sellingPointId) === point.id);
    const status = usedIds.has(point.id)
      ? 'used' as const
      : asString(item?.status) === 'omitted_no_visual_support'
        ? 'omitted_no_visual_support' as const
        : 'omitted' as const;
    return {
      sellingPointId: point.id,
      title: point.title,
      status,
      reason: asString(item?.reason) || (status === 'used' ? '正文已引用' : '未写入正文'),
    };
  });
}

export function normalizeGeneratedScript(
  raw: unknown,
  input: ScriptGeneratorInput,
): ScriptStudioScriptContent {
  const record = asRecord(raw);
  // 归一化只认当前卖点包内的 ID：模型返回包外 ID 一律不得进入脚本引用。
  const usable = briefCandidatePoints(input);
  const usableIds = new Set(usable.map((point) => point.id));
  const coverTitleParts = parseCoverParts(record);
  const segments = parseSegments(record, usableIds, usable);
  const usedIds = new Set(segments.flatMap((segment) => segment.sellingPointIdRefs));
  const fullScript = segments.map((segment) => segment.narration).join('\n');
  const contentCharacterCount = countScriptContentCharacters(fullScript);
  const budget = buildScriptDurationBudget(input.targetDurationSec);
  const estimatedNarrationDurationSec = estimateNarrationDurationSec(contentCharacterCount);
  const knowledgeContext = input.knowledgeContext;
  const strategy = knowledgeContext?.strategy;
  const embedding = knowledgeContext
    ? checkTitleEmbedding(
        {
          matchStatus: strategy!.matchStatus,
          canonicalName: strategy!.canonicalName,
          searchTerms: strategy!.searchTerms,
        },
        asString(record.title),
        `${coverTitleParts.primary}${coverTitleParts.secondary}`,
      )
    : null;
  const recommendation = input.plan.recommendation;
  return {
    version: 4,
    title: asString(record.title) || `${input.libraryRevision.productName || '产品'}口播方案`,
    coverTitleParts: {
      ...coverTitleParts,
      source: 'model',
    },
    platform: input.platform,
    tone: input.tone,
    templateId: input.plan.templateId,
    template: input.plan.templateName,
    templateVersion: input.plan.templateVersion,
    templateRationale: input.plan.rationale,
    shotSetId: '',
    targetDurationSec: input.targetDurationSec,
    targetNarrationDurationSec: budget.targetNarrationSec,
    contentCharacterCount,
    estimatedNarrationDurationSec,
    durationStatus: contentCharacterCount < budget.minContentCharacters
      ? 'too_short'
      : contentCharacterCount > budget.maxContentCharacters ? 'too_long' : 'qualified',
    direction: asString(record.direction) || input.plan.angle,
    creativeBrief: input.creativeBrief || '',
    libraryRevisionId: input.libraryRevision.id,
    sellingPointUsage: parseUsage(record, usable, usedIds),
    segments,
    fullScript,
    fullSubtitle: segments.map((segment) => segment.subtitle).join('\n'),
    knowledgeContext: knowledgeContext
      ? {
          matchStatus: strategy!.matchStatus,
          strategyRevisionId: strategy!.strategyCatalogRevisionId,
          normalizedModelKey: strategy!.normalizedModelKey,
          canonicalName: strategy!.canonicalName,
          searchTermsUsed: embedding?.searchTermsUsed ?? [],
          sourceRows: strategy!.sourceRows ?? [],
        }
      : undefined,
    recommendation: recommendation
      ? {
          framework: recommendation.framework ? {
            id: recommendation.framework.id,
            stableKey: recommendation.framework.stableKey,
            name: recommendation.framework.name,
            structure: recommendation.framework.structure,
            rationale: recommendation.framework.rationale,
          } : null,
          copyHook: recommendation.copyHook ? {
            id: recommendation.copyHook.id,
            stableKey: recommendation.copyHook.stableKey,
            type: recommendation.copyHook.type,
            subtype: recommendation.copyHook.subtype,
            formula: recommendation.copyHook.formula,
            example: recommendation.copyHook.example,
            rationale: recommendation.copyHook.rationale,
          } : null,
          visualHook: recommendation.visualHook ? {
            id: recommendation.visualHook.id,
            stableKey: recommendation.visualHook.stableKey,
            group: recommendation.visualHook.group,
            name: recommendation.visualHook.name,
            formula: recommendation.visualHook.formula,
            guidance: recommendation.visualHook.guidance,
            referenceAssetIds: recommendation.visualHook.referenceAssetIds,
            rationale: recommendation.visualHook.rationale,
          } : null,
        }
      : undefined,
  };
}

export function createScriptGenerator(
  completeJson: ScriptStudioCompleteJson,
  provider: { id: string; model: string },
  options: { maxTokens?: number } = {},
): ScriptGenerator {
  return {
    async generate(input) {
      // 方向编排不可绕过：缺少 brief 直接失败，不得回退完整卖点库。
      if (!input.brief) throw new Error('script_generation_direction_brief_required');
      const prompt = buildScriptPrompt(input);
      let attempts = 0;
      let raw: unknown;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        attempts += 1;
        raw = await completeJson({
          systemPrompt: prompt.systemPrompt,
          userPrompt: prompt.userPrompt,
          temperature: 1,
          maxTokens: options.maxTokens ?? 8000,
          signal: input.signal,
        });
        try {
          return { content: normalizeGeneratedScript(raw, input), attempts };
        } catch {
          if (input.signal?.aborted) throw new DOMException('脚本生成已取消', 'AbortError');
        }
      }
      throw new Error('script_generation_invalid_output');
    },
  };
}

export function buildDeterministicFallbackScript(
  input: ScriptGeneratorInput,
): ScriptStudioScriptContent {
  const usable = briefCandidatePoints(input);
  if (usable.length === 0) throw new Error('script_generation_no_candidate_points');
  const budget = buildScriptDurationBudget(input.targetDurationSec);
  const poolStart = input.plan.index > 1 && usable.length > 1 ? 1 : 0;
  const selectedPool = usable.slice(poolStart, Math.max(poolStart + 1, Math.min(poolStart + 5, usable.length)));
  const sentences: string[] = [];
  let contentCharacterCount = 0;
  let pointer = 0;
  while (contentCharacterCount < budget.minContentCharacters && pointer < 30) {
    const point = selectedPool[pointer % selectedPool.length]!;
    const variationPrefix = input.plan.index > 1 ? `${input.plan.angle}：` : '';
    let sentence = `${variationPrefix}${point.factText}。${point.title ? `${point.title}，` : ''}`;
    if (countScriptContentCharacters([...sentences, sentence].join('\n')) > budget.maxContentCharacters) {
      sentence = `${point.title || '值得信赖'}。`;
    }
    sentences.push(sentence);
    contentCharacterCount = countScriptContentCharacters(sentences.join('\n'));
    pointer += 1;
  }
  const selected = selectedPool;
  const segments: ScriptStudioSegmentContent[] = sentences.map((sentence, index) => ({
    id: `segment-${index + 1}`,
    narration: sentence,
    subtitle: normalizeAutomaticSubtitleText(sentence),
    sellingPointIdRefs: [selectedPool[index % selectedPool.length]!.id],
    sellingPointRefs: [selectedPool[index % selectedPool.length]!.title],
    visualIntent: selectedPool[index % selectedPool.length]!.factText,
    visualKeywords: selectedPool[index % selectedPool.length]!.title ? [selectedPool[index % selectedPool.length]!.title] : [],
  }));
  const fullScript = segments.map((segment) => segment.narration).join('\n');
  contentCharacterCount = countScriptContentCharacters(fullScript);
  const knowledgeContext = input.knowledgeContext;
  const strategy = knowledgeContext?.strategy;
  const matched = strategy?.matchStatus === 'matched';
  const canonicalName = matched ? (strategy!.canonicalName || '') : '';
  const searchTerms = matched ? (strategy!.searchTerms || []) : [];
  const usedSearchTerm = searchTerms[0] || '';
  // 内部标题必须同时含统一名称与至少一个搜索词；统一名称已含搜索词时直接使用。
  const titleIncludesTerm = matchedSearchTerms(canonicalName, searchTerms).length > 0;
  const title = canonicalName
    ? (titleIncludesTerm ? canonicalName : `${canonicalName}｜${usedSearchTerm}`)
    : `${input.libraryRevision.productName || '产品'}口播方案`;
  const coverPrimary = canonicalName ? `${canonicalName}优选` : `${input.libraryRevision.category || '产品'}优选`;
  const coverSecondary = usedSearchTerm || '真实细节更可信';
  const recommendation = input.plan.recommendation;
  return {
    version: 4,
    title,
    coverTitleParts: {
      primary: coverPrimary,
      secondary: coverSecondary,
      source: 'system_composed',
    },
    platform: input.platform,
    tone: input.tone,
    templateId: input.plan.templateId,
    template: input.plan.templateName,
    templateVersion: input.plan.templateVersion,
    templateRationale: input.plan.rationale,
    shotSetId: '',
    targetDurationSec: input.targetDurationSec,
    targetNarrationDurationSec: budget.targetNarrationSec,
    contentCharacterCount,
    estimatedNarrationDurationSec: estimateNarrationDurationSec(contentCharacterCount),
    durationStatus: 'qualified',
    direction: input.plan.angle,
    creativeBrief: input.creativeBrief,
    libraryRevisionId: input.libraryRevision.id,
    sellingPointUsage: usable.map((point) => ({
      sellingPointId: point.id,
      title: point.title,
      status: selected.some((item) => item.id === point.id) ? 'used' : 'omitted',
      reason: selected.some((item) => item.id === point.id) ? '正文已引用' : '未写入正文',
    })),
    segments,
    fullScript,
    fullSubtitle: segments.map((segment) => segment.subtitle).join('\n'),
    knowledgeContext: knowledgeContext
      ? {
          matchStatus: strategy!.matchStatus,
          strategyRevisionId: strategy!.strategyCatalogRevisionId,
          normalizedModelKey: strategy!.normalizedModelKey,
          canonicalName: strategy!.canonicalName,
          searchTermsUsed: matched ? (usedSearchTerm ? [usedSearchTerm] : []) : [],
          sourceRows: strategy!.sourceRows ?? [],
        }
      : undefined,
    recommendation: recommendation
      ? {
          framework: recommendation.framework ? {
            id: recommendation.framework.id,
            stableKey: recommendation.framework.stableKey,
            name: recommendation.framework.name,
            structure: recommendation.framework.structure,
            rationale: recommendation.framework.rationale,
          } : null,
          copyHook: recommendation.copyHook ? {
            id: recommendation.copyHook.id,
            stableKey: recommendation.copyHook.stableKey,
            type: recommendation.copyHook.type,
            subtype: recommendation.copyHook.subtype,
            formula: recommendation.copyHook.formula,
            example: recommendation.copyHook.example,
            rationale: recommendation.copyHook.rationale,
          } : null,
          visualHook: recommendation.visualHook ? {
            id: recommendation.visualHook.id,
            stableKey: recommendation.visualHook.stableKey,
            group: recommendation.visualHook.group,
            name: recommendation.visualHook.name,
            formula: recommendation.visualHook.formula,
            guidance: recommendation.visualHook.guidance,
            referenceAssetIds: recommendation.visualHook.referenceAssetIds,
            rationale: recommendation.visualHook.rationale,
          } : null,
        }
      : undefined,
  };
}

/**
 * 真实模型偶尔返回时长不足的正文。这里只把卖点库中未使用的事实补成自然句，
 * 不新增任何虚构功效，随后仍会上交时长/结构/事实校验。
 */
export function extendScriptContentToDuration(
  input: ScriptStudioScriptContent,
  library: LibraryRevisionView,
  brief: DirectionSellingPointBrief,
): ScriptStudioScriptContent {
  const budget = buildScriptDurationBudget(input.targetDurationSec);
  const usedIds = new Set(input.segments.flatMap((segment) => segment.sellingPointIdRefs));
  // 时长补齐同样只能从当前卖点包取事实，不能从完整库偷拿卖点；证据失败卖点一律排除。
  const briefIds = new Set([...brief.requiredPointIds, ...brief.optionalPointIds]);
  const usable = library.sellingPoints.filter((point) => briefIds.has(point.id) && isSellingPointEvidenceUsable(point));
  const unused = usable.filter((point) => !usedIds.has(point.id));
  const segments = [...input.segments];
  let contentCharacterCount = countScriptContentCharacters(input.fullScript);
  const pool = unused.length > 0 ? unused : usable;
  if (pool.length === 0) return input;
  let pointer = 0;
  while (contentCharacterCount < budget.minContentCharacters && pointer < 30) {
    const point = pool[pointer % pool.length]!;
    const narrationCandidate = `${point.factText}。${point.title ? `${point.title}。` : ''}`;
    const candidateCount = countScriptContentCharacters([...segments, {
      id: `segment-${segments.length + 1}`,
      narration: narrationCandidate,
      subtitle: normalizeAutomaticSubtitleText(narrationCandidate),
      sellingPointIdRefs: [point.id],
      sellingPointRefs: [point.title],
      visualIntent: point.factText,
      visualKeywords: point.title ? [point.title] : [],
    } satisfies ScriptStudioSegmentContent].map((segment) => segment.narration).join('\n'));
    const narration = candidateCount > budget.maxContentCharacters ? `${point.title || '值得信赖'}。` : narrationCandidate;
    const nextSegments = [...segments, {
      id: `segment-${segments.length + 1}`,
      narration,
      subtitle: normalizeAutomaticSubtitleText(narration),
      sellingPointIdRefs: [point.id],
      sellingPointRefs: [point.title],
      visualIntent: point.factText,
      visualKeywords: point.title ? [point.title] : [],
    } satisfies ScriptStudioSegmentContent];
    const nextCount = countScriptContentCharacters(nextSegments.map((segment) => segment.narration).join('\n'));
    if (nextCount > budget.maxContentCharacters) break;
    segments.push(nextSegments[nextSegments.length - 1]!);
    contentCharacterCount = nextCount;
    usedIds.add(point.id);
    pointer += 1;
  }
  const fullScript = segments.map((segment) => segment.narration).join('\n');
  contentCharacterCount = countScriptContentCharacters(fullScript);
  const estimatedNarrationDurationSec = estimateNarrationDurationSec(contentCharacterCount);
  return {
    ...input,
    segments,
    fullScript,
    fullSubtitle: segments.map((segment) => segment.subtitle).join('\n'),
    contentCharacterCount,
    estimatedNarrationDurationSec,
    durationStatus: contentCharacterCount < budget.minContentCharacters
      ? 'too_short'
      : contentCharacterCount > budget.maxContentCharacters ? 'too_long' : 'qualified',
    sellingPointUsage: usable.map((point) => {
      const existing = input.sellingPointUsage.find((usage) => usage.sellingPointId === point.id);
      const used = usedIds.has(point.id);
      return {
        sellingPointId: point.id,
        title: point.title,
        status: used ? 'used' as const : (existing?.status || 'omitted') as 'used' | 'omitted' | 'omitted_no_visual_support',
        reason: used ? (existing?.reason || '正文已引用') : (existing?.reason || '未写入正文'),
      };
    }),
  };
}
