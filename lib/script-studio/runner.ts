import type Database from 'better-sqlite3';
import type { EvidenceReprobe } from './adapters/reprobe.ts';
import type { VisionExtractor } from './adapters/vision-extract.ts';
import { createScriptGenerator, extendScriptContentToDuration, type ScriptGenerator } from './generator.ts';
import {
  createLibraryRevision,
  getCurrentLibraryRevision,
  getLibraryRevision,
  type LibraryRevisionView,
} from './libraries.ts';
import { addProjectScriptRevision, createProjectScript } from './scripts.ts';
import { ScriptStudioError } from './errors.ts';
import {
  evidenceGateSummary,
  runEvidenceGate,
  usableSellingPoints,
  type EvidenceGateResult,
} from './evidence-gate.ts';
import { planDirectionBriefs, type DirectionSellingPointBrief } from './direction-briefs.ts';
import { normalizeEvidenceRefs } from './selling-point-normalize.ts';
import { applyKnowledgeRecommendations, planScriptDirections } from './planner.ts';
import { parseKnowledgeContext, type FrozenKnowledgeContext } from './knowledge-context.ts';
import { getScriptStudioLimits } from './limits.ts';
import { parseScriptStudioRequestedCount, parseScriptStudioTargetDuration } from './generation-contract.ts';
import { isScriptStudioTaskCancelRequested } from './scheduler.ts';
import { parseTileRefIndex, tileSourceImages, selectEvidenceTiles, type TileSetResult } from './tiling.ts';
import {
  finishStage,
  getTask,
  startStage,
  updateTask,
} from './tasks.ts';
import { validateScriptContent } from './validation.ts';
import type { ScriptStudioScriptContent } from './types.ts';
import { dedupeSellingPoints } from './dedupe.ts';

export interface ScriptStudioRunDeps {
  db: Database.Database;
  projectId: string;
  taskId: string;
  sourceSetId?: string | null;
  libraryRevisionId?: string | null;
  inputSnapshot: Record<string, unknown>;
  visionExtractor: VisionExtractor;
  reprobe: EvidenceReprobe;
  generator: ScriptGenerator;
  signal?: AbortSignal;
  now?: () => Date;
  fallbackOnInvalid?: boolean;
}

export interface ScriptStudioRunResult {
  status: 'succeeded' | 'partial' | 'failed';
  succeededCount: number;
  failedCount: number;
  scriptIds: string[];
  errorCode?: string;
  errorMessage?: string;
}

function parseTargetDuration(input: Record<string, unknown>): number {
  return parseScriptStudioTargetDuration(input.targetDurationSec);
}

function parseRequestedCount(input: Record<string, unknown>): number {
  return parseScriptStudioRequestedCount(input.requestedCount);
}

function parseCreativeBrief(input: Record<string, unknown>): string {
  return typeof input.creativeBrief === 'string' ? input.creativeBrief.trim().slice(0, 2000) : '';
}

/** 把冻结知识上下文压缩进 plan stage payload（不含完整推荐数组，避免重复冗余）。 */
function serializeKnowledgeForStage(context: FrozenKnowledgeContext): Record<string, unknown> {
  return {
    strategy: context.strategy,
    template: context.template,
    fingerprint: context.fingerprint,
  };
}

/** 单条脚本修订的来源推荐 JSON（框架/文案钩子/画面钩子）；未使用目录时为 {}。 */
function recommendationForPlan(plan: {
  recommendation?: {
    framework?: { id: string; stableKey: string; name: string; structure: string[]; rationale: string } | null;
    copyHook?: { id: string; type: string; subtype: string; formula: string; example: string; rationale: string } | null;
    visualHook?: { id: string; group: string; name: string; formula: string; guidance: string; referenceAssetIds: string[]; rationale: string } | null;
  };
}): Record<string, unknown> {
  const recommendation = plan.recommendation;
  if (!recommendation) return {};
  return {
    framework: recommendation.framework
      ? {
          id: recommendation.framework.id,
          stableKey: recommendation.framework.stableKey,
          name: recommendation.framework.name,
          structure: recommendation.framework.structure,
          rationale: recommendation.framework.rationale,
        }
      : null,
    copyHook: recommendation.copyHook
      ? {
          id: recommendation.copyHook.id,
          type: recommendation.copyHook.type,
          subtype: recommendation.copyHook.subtype,
          formula: recommendation.copyHook.formula,
          example: recommendation.copyHook.example,
          rationale: recommendation.copyHook.rationale,
        }
      : null,
    visualHook: recommendation.visualHook
      ? {
          id: recommendation.visualHook.id,
          group: recommendation.visualHook.group,
          name: recommendation.visualHook.name,
          formula: recommendation.visualHook.formula,
          guidance: recommendation.visualHook.guidance,
          referenceAssetIds: recommendation.visualHook.referenceAssetIds,
          rationale: recommendation.visualHook.rationale,
        }
      : null,
  };
}

// parseTileRefIndex 已上移到 tiling.ts（证据门禁共用）；这里再导出以兼容既有调用方。
export { parseTileRefIndex };

// 每条证据引用自带 pageIndex + tileRef 配对：跨页合并的卖点也能把每条约回到正确页面。
// 单条卖点的图片总数硬封顶 maxTiles（默认与二次核验单批预算一致）：先收全部精确切片，
// 再按引用顺序补相邻片——6 条引用带相邻片最多 18 图的溢出不允许发生。
export function evidenceTilesForPoint(
  point: {
    evidenceRefs?: Array<{ pageIndex: number | null; tileRef: string }>;
    sourcePageIndex?: number | null;
    tileRefs?: string[];
  },
  tileResult: TileSetResult,
  maxTiles = 6,
): Array<{ mimeType: string; imageBase64: string }> {
  const budget = Math.max(1, Math.floor(maxTiles));
  const tiles: Array<{ mimeType: string; imageBase64: string }> = [];
  const seen = new Set<string>();
  const push = (tile: { mimeType: string; imageBase64: string }): void => {
    if (tiles.length >= budget) return;
    const key = `${tile.mimeType} ${tile.imageBase64}`;
    if (seen.has(key)) return;
    seen.add(key);
    tiles.push({ mimeType: tile.mimeType, imageBase64: tile.imageBase64 });
  };
  const located: Array<{ page: TileSetResult['pages'][number]; tileIndex: number }> = [];
  for (const ref of normalizeEvidenceRefs(point).slice(0, budget)) {
    const page = tileResult.pages[ref.pageIndex ?? 0];
    if (!page) continue;
    located.push({ page, tileIndex: ref.tileRef ? parseTileRefIndex(ref.tileRef) ?? 0 : 0 });
  }
  for (const { page, tileIndex } of located) {
    const exact = page.tiles[tileIndex];
    if (exact) push(exact);
  }
  for (const { page, tileIndex } of located) {
    for (const tile of selectEvidenceTiles(page, tileIndex, 1)) {
      if (tile === page.tiles[tileIndex]) continue;
      push(tile);
    }
  }
  return tiles;
}

function stagePayload(data: unknown): Record<string, unknown> {
  return data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : {};
}

function sourceSetPageCount(
  db: Database.Database,
  projectId: string,
  sourceSetId: string,
): number | undefined {
  const row = db.prepare(`
    SELECT imageAssetIdsJson
    FROM script_studio_source_sets
    WHERE id = ? AND projectId = ?
  `).get(sourceSetId, projectId) as { imageAssetIdsJson: string } | undefined;
  if (!row) return undefined;
  try {
    const imageAssetIds = JSON.parse(row.imageAssetIdsJson) as unknown;
    return Array.isArray(imageAssetIds) && imageAssetIds.length > 0
      ? imageAssetIds.length
      : undefined;
  } catch {
    return undefined;
  }
}

async function generateValidatedScript(
  deps: ScriptStudioRunDeps,
  library: LibraryRevisionView,
  plan: ReturnType<typeof planScriptDirections>['plans'][number],
  brief: DirectionSellingPointBrief,
  context: { audience: string; tone: string; platform: string; targetDurationSec: number; creativeBrief: string },
  previousScripts: ScriptStudioScriptContent[],
  knowledgeContext: FrozenKnowledgeContext | null,
): Promise<ScriptStudioScriptContent> {
  let content: ScriptStudioScriptContent | undefined;
  let validation: ReturnType<typeof validateScriptContent> | undefined;
  let generatedAttempts = 0;
  const titleEmbeddingContext = knowledgeContext
    ? {
        matchStatus: knowledgeContext.strategy.matchStatus,
        canonicalName: knowledgeContext.strategy.canonicalName,
        searchTerms: knowledgeContext.strategy.searchTerms,
      }
    : undefined;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (deps.signal?.aborted) throw new DOMException('脚本生成已取消', 'AbortError');
    const generated = await deps.generator.generate({
      libraryRevision: library,
      plan,
      brief,
      audience: context.audience,
      tone: context.tone,
      platform: context.platform,
      creativeBrief: context.creativeBrief,
      targetDurationSec: context.targetDurationSec,
      previousScripts: previousScripts.map((item) => ({ fullScript: item.fullScript })),
      signal: deps.signal,
      validationFeedback: attempt > 1 ? validation?.issues : undefined,
      ...(knowledgeContext ? { knowledgeContext } : {}),
    });
    generatedAttempts += generated.attempts;
    content = generated.content;
    validation = validateScriptContent(content, {
      libraryRevision: library,
      siblingScripts: previousScripts.map((item) => ({ fullScript: item.fullScript })),
      titleEmbeddingContext,
    });
    if (validation.ok) return validation.content;
    if (!validation.ok && validation.issues.includes('duration_too_short')) {
      content = extendScriptContentToDuration(content, library, brief);
      validation = validateScriptContent(content, {
        libraryRevision: library,
        siblingScripts: previousScripts.map((item) => ({ fullScript: item.fullScript })),
        titleEmbeddingContext,
      });
      if (validation.ok) return validation.content;
    }
    if (attempt < 3) {
      // 生成器在下一轮会看到当前内容，但不会重读详情页。
    }
  }
  if (deps.fallbackOnInvalid && content) {
    const fallback = await deps.generator.generate({
      libraryRevision: library,
      plan,
      brief,
      audience: context.audience,
      tone: context.tone,
      platform: context.platform,
      creativeBrief: context.creativeBrief,
      targetDurationSec: context.targetDurationSec,
      previousScripts: previousScripts.map((item) => ({ fullScript: item.fullScript })),
      signal: deps.signal,
      ...(knowledgeContext ? { knowledgeContext } : {}),
    });
    content = fallback.content;
    validation = validateScriptContent(content, {
      libraryRevision: library,
      siblingScripts: previousScripts.map((item) => ({ fullScript: item.fullScript })),
      titleEmbeddingContext,
    });
    if (validation.ok) return validation.content;
  }
  throw new ScriptStudioError('invalid_input', `脚本未通过校验：${validation?.issues.slice(0, 3).join('；') || '未知原因'}`);
}

export async function executeScriptStudioTask(
  deps: ScriptStudioRunDeps,
): Promise<ScriptStudioRunResult> {
  const { db, projectId, taskId, signal, now } = deps;
  const task = getTask(db, projectId, taskId);
  if (!task) throw new ScriptStudioError('not_found', '任务不存在');
  const input = deps.inputSnapshot;
  let targetDurationSec: number;
  let requestedCount: number;
  let creativeBrief: string;
  // 知识/模板目录推荐在创建任务时冻结在 inputSnapshot；runner 只读快照，
  // 设置页切换当前目录版本不改变运行中任务。
  const knowledgeContext = parseKnowledgeContext(input.knowledgeContext);
  try {
    targetDurationSec = parseTargetDuration(input);
    requestedCount = parseRequestedCount(input);
    creativeBrief = parseCreativeBrief(input);
  } catch (error) {
    await updateTask(db, projectId, taskId, {
      status: 'failed',
      currentStage: 'input_check',
      errorCode: 'invalid_input',
      errorMessage: error instanceof Error ? error.message : String(error),
    }, now);
    throw error;
  }

  const firstExtraction = task.mode === 'first_extraction';
  const isReuse = task.mode === 'reuse';
  const scriptIds: string[] = [];
  const createdScripts: ScriptStudioScriptContent[] = [];
  const generationErrors: string[] = [];
  let libraryRevision: LibraryRevisionView | undefined;
  let tileResult: TileSetResult | undefined;
  let evidenceResult: EvidenceGateResult | undefined;
  const targetScriptId = typeof input.targetScriptId === 'string' ? input.targetScriptId.trim() : '';

  try {
    startStage(db, projectId, taskId, 'input_check', now);
    await updateTask(db, projectId, taskId, { currentStage: 'input_check' }, now);
    finishStage(db, projectId, taskId, 'input_check', 'succeeded', {
      targetDurationSec,
      requestedCount,
      mode: task.mode,
    }, null, now);

    if (firstExtraction) {
      startStage(db, projectId, taskId, 'read_pages', now);
      await updateTask(db, projectId, taskId, { currentStage: 'read_pages' }, now);
      if (!deps.sourceSetId) throw new ScriptStudioError('invalid_input', '首次生成必须提供详情页来源集');
      const imageAssetIds = (db.prepare(`
        SELECT imageAssetIdsJson FROM script_studio_source_sets WHERE id = ? AND projectId = ?
      `).get(deps.sourceSetId, projectId) as { imageAssetIdsJson: string } | undefined)?.imageAssetIdsJson;
      if (!imageAssetIds) throw new ScriptStudioError('not_found', '详情页来源集不存在');
      tileResult = await tileSourceImages(db, projectId, JSON.parse(imageAssetIds) as string[], { signal });
      finishStage(db, projectId, taskId, 'read_pages', 'succeeded', {
        imageCount: tileResult.pages.length,
        totalTiles: tileResult.totalTiles,
        degraded: tileResult.degraded,
        maxImagesPerRequest: tileResult.maxImagesPerRequest,
      }, null, now);
    } else if (isReuse) {
      startStage(db, projectId, taskId, 'load_library', now);
      await updateTask(db, projectId, taskId, { currentStage: 'load_library' }, now);
      libraryRevision = deps.libraryRevisionId
        ? getLibraryRevision(db, projectId, deps.libraryRevisionId)
        : undefined;
      if (!libraryRevision) libraryRevision = getCurrentLibraryRevision(db, projectId);
      if (!libraryRevision) throw new ScriptStudioError('not_found', '当前项目没有可复用的卖点库');
      finishStage(db, projectId, taskId, 'load_library', 'succeeded', {
        libraryRevisionId: libraryRevision.id,
        revisionNumber: libraryRevision.revisionNumber,
      }, null, now);
    }

    if (firstExtraction) {
      startStage(db, projectId, taskId, 'extract', now);
      await updateTask(db, projectId, taskId, { currentStage: 'extract' }, now);
      const extraction = await deps.visionExtractor.extract({
        productName: typeof input.productName === 'string' ? input.productName : undefined,
        category: typeof input.category === 'string' ? input.category : undefined,
        brand: typeof input.brand === 'string' ? input.brand : undefined,
        pages: tileResult!.pages.map((page) => ({
          pageIndex: page.pageIndex,
          imageAssetId: page.imageAssetId,
          filename: page.filename,
          sourceWidth: page.sourceWidth,
          sourceHeight: page.sourceHeight,
          tiles: page.tiles.map((tile) => ({ mimeType: tile.mimeType, imageBase64: tile.imageBase64 })),
        })),
      }, signal);
      const extracted = dedupeSellingPoints(extraction.sellingPoints);
      if (extracted.length === 0) throw new ScriptStudioError('invalid_input', '详情页中没有提取到可识别的卖点');
      const productIdentities = new Set(
        (extraction.pageIdentities || []).map((identity) => `${identity.productName}|${identity.category}|${identity.brand}`.trim()).filter(Boolean),
      );
      if (productIdentities.size > 1) {
        throw new ScriptStudioError('invalid_input', '检测到疑似多个不同商品，请拆分处理后再生成');
      }
      finishStage(db, projectId, taskId, 'extract', 'succeeded', {
        productName: extraction.productName,
        category: extraction.category,
        brand: extraction.brand,
        candidateCount: extracted.length,
        requestCount: extraction.batchMetrics?.length ?? null,
        batchMetrics: extraction.batchMetrics ?? [],
      }, null, now);

      startStage(db, projectId, taskId, 'evidence_gate', now);
      await updateTask(db, projectId, taskId, { currentStage: 'evidence_gate' }, now);
      const evidenceLimits = getScriptStudioLimits();
      evidenceResult = await runEvidenceGate(extracted, {
        reprobe: deps.reprobe,
        evidenceTiles: (point) => tileResult ? evidenceTilesForPoint(point, tileResult, evidenceLimits.reprobeMaxImagesPerBatch) : [],
        signal,
        concurrency: evidenceLimits.reprobeConcurrency,
        batchSize: evidenceLimits.reprobeBatchSize,
        maxImagesPerBatch: evidenceLimits.reprobeMaxImagesPerBatch,
        pageCount: tileResult!.pages.length,
        pageTileCounts: tileResult!.pages.map((page) => page.tiles.length),
      });
      if (usableSellingPoints(evidenceResult.points).length === 0) {
        finishStage(db, projectId, taskId, 'evidence_gate', 'failed', evidenceGateSummary(evidenceResult.points, evidenceResult), 'evidence_failed', now);
        throw new ScriptStudioError('evidence_failed', '没有通过结构/风险/证据门禁的可安全使用卖点，请补充更清晰的详情页或修改来源');
      }
      finishStage(db, projectId, taskId, 'evidence_gate', 'succeeded', evidenceGateSummary(evidenceResult.points, evidenceResult), null, now);

      startStage(db, projectId, taskId, 'save_library', now);
      await updateTask(db, projectId, taskId, { currentStage: 'save_library' }, now);
      libraryRevision = createLibraryRevision(db, {
        projectId,
        sourceSetId: deps.sourceSetId!,
        sourceFingerprint: (db.prepare(`
          SELECT contentFingerprint FROM script_studio_source_sets WHERE id = ? AND projectId = ?
        `).get(deps.sourceSetId, projectId) as { contentFingerprint: string }).contentFingerprint,
        productName: extraction.productName,
        category: extraction.category,
        brand: extraction.brand,
        extractProviderId: extraction.providerId,
        extractModel: extraction.model,
        promptContractVersion: extraction.promptContractVersion,
        origin: 'extraction',
        sellingPoints: evidenceResult.points,
      }, now);
      finishStage(db, projectId, taskId, 'save_library', 'succeeded', {
        libraryRevisionId: libraryRevision.id,
        revisionNumber: libraryRevision.revisionNumber,
      }, null, now);
    } else {
      // reuse 模式没有 extraction/evidence 阶段，阶段列表按复用定义展示。
    }

    startStage(db, projectId, taskId, 'plan', now);
    await updateTask(db, projectId, taskId, { currentStage: 'plan' }, now);
    const plans = planScriptDirections(libraryRevision!, requestedCount, creativeBrief);
    const plansWithRecommendations = knowledgeContext
      ? applyKnowledgeRecommendations(plans.plans, knowledgeContext.recommendations)
      : plans.plans;
    // 本地确定性编排：一次为本轮全部方向准备卖点包，首稿与相似度重试都复用这份包。
    // 首次提取可同时校验页码与切片范围；历史复用不重读图片，但仍从来源集恢复页数，
    // 对非法格式和页码越界做本地 fail-closed 重验。
    const evidenceBounds = tileResult
      ? {
          pageCount: tileResult.pages.length,
          pageTileCounts: tileResult.pages.map((page) => page.tiles.length),
        }
      : {
          pageCount: sourceSetPageCount(db, projectId, libraryRevision!.sourceSetId),
        };
    const briefs = planDirectionBriefs({
      sellingPoints: libraryRevision!.sellingPoints,
      plans: plansWithRecommendations,
      targetDurationSec,
      evidenceBounds,
      strategyRanking: knowledgeContext?.strategy.matchStatus === 'matched'
        ? {
            primarySellingPoints: knowledgeContext.strategy.primarySellingPoints,
            differentiators: knowledgeContext.strategy.differentiators,
          }
        : undefined,
    });
    const briefByPlanIndex = new Map(briefs.map((brief) => [brief.planIndex, brief]));
    const briefSnapshots = briefs.map((brief) => ({
      planIndex: brief.planIndex,
      templateId: brief.templateId,
      themeKey: brief.themeKey,
      themeTitle: brief.themeTitle,
      requiredPointIds: brief.requiredPointIds,
      optionalPointIds: brief.optionalPointIds,
      candidateCount: brief.candidateCount,
      degraded: brief.degraded,
      rationale: brief.rationale,
    }));
    // 证据边界 fail closed：全部方向都没有通过证据门槛的候选时，任务明确失败，
    // 不得产出零引用脚本。首次生成与复用生成共用这一收口。
    if (briefs.every((brief) => brief.candidateCount === 0)) {
      finishStage(db, projectId, taskId, 'plan', 'failed', {
        audience: plans.audience,
        tone: plans.tone,
        platform: plans.platform,
        plans: plansWithRecommendations,
        briefs: briefSnapshots,
        knowledgeContext: knowledgeContext ? serializeKnowledgeForStage(knowledgeContext) : null,
      }, 'evidence_insufficient', now);
      throw new ScriptStudioError('evidence_insufficient', '可用证据不足：卖点库中没有通过证据门禁且可用的卖点，请先在卖点库中补充或恢复可用卖点');
    }
    finishStage(db, projectId, taskId, 'plan', 'succeeded', {
      audience: plans.audience,
      tone: plans.tone,
      platform: plans.platform,
      plans: plansWithRecommendations,
      briefs: briefSnapshots,
      knowledgeContext: knowledgeContext ? serializeKnowledgeForStage(knowledgeContext) : null,
    }, null, now);

    startStage(db, projectId, taskId, 'generate', now);
    await updateTask(db, projectId, taskId, { currentStage: 'generate' }, now);
    const generationContext = {
      audience: plans.audience,
      tone: plans.tone,
      platform: plans.platform,
      targetDurationSec,
      creativeBrief,
    };
    // 各创意方向的首稿只读卖点库和自己的 plan，可以有界并行；
    // 按 plan 顺序落库前再做一次 sibling 校验，若相似才携已采用脚本定向重生成。
    // 这样不会为并行牺牲方案差异契约，同时避免正常情况下纯串行累加上游长尾。
    const initialResults: Array<{ content?: ScriptStudioScriptContent; error?: unknown }> = new Array(plansWithRecommendations.length);
    let generationCursor = 0;
    const generateWorker = async (): Promise<void> => {
      while (generationCursor < plansWithRecommendations.length) {
        if (deps.signal?.aborted) throw new DOMException('脚本生成已取消', 'AbortError');
        const index = generationCursor;
        generationCursor += 1;
        const plan = plansWithRecommendations[index]!;
        const brief = briefByPlanIndex.get(plan.index);
        if (!brief) throw new ScriptStudioError('invalid_input', `缺少方案 ${plan.index} 的方向卖点包`);
        try {
          initialResults[index] = {
            content: await generateValidatedScript(
              deps,
              libraryRevision!,
              plan,
              brief,
              generationContext,
              [],
              knowledgeContext,
            ),
          };
        } catch (error) {
          initialResults[index] = { error };
        }
      }
    };
    const generationConcurrency = Math.max(
      1,
      Math.min(plansWithRecommendations.length, getScriptStudioLimits().generationConcurrency),
    );
    await Promise.all(Array.from({ length: generationConcurrency }, () => generateWorker()));

    for (let index = 0; index < plansWithRecommendations.length; index += 1) {
      const plan = plansWithRecommendations[index]!;
      const brief = briefByPlanIndex.get(plan.index);
      if (!brief) throw new ScriptStudioError('invalid_input', `缺少方案 ${plan.index} 的方向卖点包`);
      try {
        const initial = initialResults[index]!;
        if (initial.error) throw initial.error;
        let content = initial.content!;
        const titleEmbeddingContext = knowledgeContext
          ? {
              matchStatus: knowledgeContext.strategy.matchStatus,
              canonicalName: knowledgeContext.strategy.canonicalName,
              searchTerms: knowledgeContext.strategy.searchTerms,
            }
          : undefined;
        const siblingValidation = validateScriptContent(content, {
          libraryRevision: libraryRevision!,
          siblingScripts: createdScripts.map((item) => ({ fullScript: item.fullScript })),
          titleEmbeddingContext,
        });
        if (!siblingValidation.ok) {
          content = await generateValidatedScript(
            deps,
            libraryRevision!,
            plan,
            brief,
            generationContext,
            createdScripts,
            knowledgeContext,
          );
        } else {
          content = siblingValidation.content;
        }
        const recommendationJson = recommendationForPlan(plan);
        const created = targetScriptId
          ? addProjectScriptRevision(db, projectId, targetScriptId, {
              origin: 'ai_regenerate',
              generationTaskId: taskId,
              libraryRevisionId: libraryRevision!.id,
              templateId: plan.templateId,
              templateVersion: plan.templateVersion,
              templateRationale: plan.rationale,
              contentJson: content as unknown as Record<string, unknown>,
              targetDurationSec,
              estimatedDurationSec: content.estimatedNarrationDurationSec,
              validationJson: { durationStatus: content.durationStatus, contentCharacterCount: content.contentCharacterCount },
              strategyCatalogRevisionId: knowledgeContext?.strategy.strategyCatalogRevisionId ?? '',
              strategyEntryId: knowledgeContext?.strategy.strategyEntryId ?? '',
              templateCatalogRevisionId: knowledgeContext?.template.templateCatalogRevisionId ?? '',
              recommendationJson,
            }, now)
          : createProjectScript(db, projectId, {
              shotSetId: null,
              generationTaskId: taskId,
              origin: 'ai_generate',
              libraryRevisionId: libraryRevision!.id,
              templateId: plan.templateId,
              templateVersion: plan.templateVersion,
              templateRationale: plan.rationale,
              contentJson: content as unknown as Record<string, unknown>,
              targetDurationSec,
              estimatedDurationSec: content.estimatedNarrationDurationSec,
              validationJson: { durationStatus: content.durationStatus, contentCharacterCount: content.contentCharacterCount },
              strategyCatalogRevisionId: knowledgeContext?.strategy.strategyCatalogRevisionId ?? '',
              strategyEntryId: knowledgeContext?.strategy.strategyEntryId ?? '',
              templateCatalogRevisionId: knowledgeContext?.template.templateCatalogRevisionId ?? '',
              recommendationJson,
            }, now);
        scriptIds.push(created.id);
        createdScripts.push(content);
      } catch (generationError) {
        // 中断/取消不是单条失败：直接上抛走任务级取消语义（queued 恢复或 cancelled）。
        if (deps.signal?.aborted || (generationError instanceof Error && generationError.name === 'AbortError')) throw generationError;
        // 单条失败不阻断其余方案；部分成功由任务结束时的计数表达。
        generationErrors.push(generationError instanceof Error ? generationError.message : String(generationError));
      }
    }
    finishStage(db, projectId, taskId, 'generate', scriptIds.length > 0 ? 'succeeded' : 'failed', {
      generated: scriptIds.length,
      requested: requestedCount,
      initialConcurrency: generationConcurrency,
      errors: generationErrors.slice(0, 5),
    }, scriptIds.length === 0 ? generationErrors[0] || 'script_generation_failed' : null, now);

    finishStage(db, projectId, taskId, 'validate', scriptIds.length > 0 ? 'succeeded' : 'failed', {
      passed: scriptIds.length,
      failed: Math.max(0, requestedCount - scriptIds.length),
    }, scriptIds.length === 0 ? 'script_generation_failed' : null, now);
    const status = scriptIds.length >= requestedCount ? 'succeeded' : scriptIds.length > 0 ? 'partial' : 'failed';
    await updateTask(db, projectId, taskId, {
      status,
      currentStage: status === 'failed' ? 'validate' : 'generate',
      errorCode: status === 'failed' ? 'script_generation_failed' : null,
      errorMessage: status === 'failed' ? (generationErrors[0] || '脚本生成失败') : null,
      succeededCount: scriptIds.length,
      failedCount: Math.max(0, requestedCount - scriptIds.length),
    }, now);
    return {
      status,
      succeededCount: scriptIds.length,
      failedCount: Math.max(0, requestedCount - scriptIds.length),
      scriptIds,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof ScriptStudioError ? error.code : 'script_studio_task_failed';
    if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
      // 手动停止落库为 cancelled（不再领取）；进程停机中断落库为 queued（下轮租约恢复）。
      const cancelled = isScriptStudioTaskCancelRequested(taskId);
      await updateTask(db, projectId, taskId, {
        status: cancelled ? 'cancelled' : 'queued',
        currentStage: '',
        errorCode: cancelled ? 'cancelled' : 'aborted',
        errorMessage: cancelled ? '已手动停止' : '任务被中断，将在下一轮恢复',
        leaseUntil: null,
      }, now);
      return {
        status: 'failed',
        succeededCount: scriptIds.length,
        failedCount: Math.max(0, requestedCount - scriptIds.length),
        scriptIds,
        errorCode: cancelled ? 'cancelled' : 'aborted',
        errorMessage: message,
      };
    }
    // 把中断时正在跑的阶段行补写成 failed，否则任务失败后过程页会一直显示「进行中」。
    const runningStage = getTask(db, projectId, taskId)?.currentStage || '';
    if (runningStage && runningStage !== 'failed') {
      finishStage(db, projectId, taskId, runningStage, 'failed', {}, code, now);
    }
    await updateTask(db, projectId, taskId, {
      status: 'failed',
      currentStage: 'failed',
      errorCode: code,
      errorMessage: message,
      succeededCount: scriptIds.length,
      failedCount: Math.max(0, requestedCount - scriptIds.length),
    }, now);
    return {
      status: 'failed',
      succeededCount: scriptIds.length,
      failedCount: Math.max(0, requestedCount - scriptIds.length),
      scriptIds,
      errorCode: code,
      errorMessage: message,
    };
  }
}

export function createScriptStudioRunDeps(
  db: Database.Database,
  options: {
    projectId: string;
    taskId: string;
    sourceSetId?: string | null;
    libraryRevisionId?: string | null;
    inputSnapshot: Record<string, unknown>;
    visionExtractor: VisionExtractor;
    reprobe: EvidenceReprobe;
    generator: ScriptGenerator;
    signal?: AbortSignal;
    now?: () => Date;
    fallbackOnInvalid?: boolean;
  },
): ScriptStudioRunDeps {
  return {
    db,
    projectId: options.projectId,
    taskId: options.taskId,
    sourceSetId: options.sourceSetId,
    libraryRevisionId: options.libraryRevisionId,
    inputSnapshot: options.inputSnapshot,
    visionExtractor: options.visionExtractor,
    reprobe: options.reprobe,
    generator: options.generator,
    signal: options.signal,
    now: options.now,
    fallbackOnInvalid: options.fallbackOnInvalid,
  };
}
