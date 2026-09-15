import type Database from 'better-sqlite3';
import type { EvidenceReprobe } from './adapters/reprobe.ts';
import type { VisionExtractor } from './adapters/vision-extract.ts';
import {
  applyScriptBodyRepair,
  briefCandidatePoints,
  type ScriptGenerator,
  type ScriptGeneratorInput,
} from './generator.ts';
import {
  createLibraryRevision,
  getCurrentLibraryRevision,
  getLibraryRevision,
  type LibraryRevisionView,
} from './libraries.ts';
import { addProjectScriptRevision, createProjectScript, listRecentProjectScriptTitles } from './scripts.ts';
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
import { describeValidationIssues, validateScriptContent } from './validation.ts';
import { applyScriptTitleRepair, buildScriptTitleContext, checkScriptTitles, type ScriptTitleSummary } from './title-policy.ts';
import { checkTitleEmbedding } from './title-embedding.ts';
import { comparePageIdentityPairs, findCrossProductConflict } from './page-identity.ts';
import {
  checkScriptEndingQuality,
  parseScriptEndingReview,
  scriptReviewFingerprint,
  SCRIPT_CTA_POLICY_VERSION,
} from './cta-policy.ts';
import { adaptPlanRecommendation } from './framework-adaptation.ts';
import {
  countDistilledStatus,
  distillableFacts,
  distilledExpressionRefs,
  distillationFingerprint,
  findCachedDistilledPoints,
  parseAndValidateDistilledPoints,
  saveDistilledPoints,
  SELLING_POINT_DISTILL_RULE_VERSION,
  type DistilledExpressionRef,
  type SellingPointDistiller,
} from './distillation.ts';
import { reserveDistillRequest, reservePlanAnalysisRequest } from './request-budget.ts';
import {
  AUDIENCE_PROFILE_VERSION,
  audienceProfileFingerprint,
  audienceProfileSummary,
  deriveFallbackAudienceProfile,
  parseAudienceProfile,
  readAudienceProfileFromStagePayload,
  serializeAudienceProfile,
  type AudienceProfileResult,
  type AudienceSegmentProfile,
} from './audience-profile.ts';
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
  /** 卖点提炼器（方案 §3）：缺省时跳过提炼阶段，不阻断脚本生成。 */
  distiller?: SellingPointDistiller;
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

/** 读取任务某阶段的既有 payload（不存在或非法 JSON 时返回空对象）。 */
function readStagePayload(db: Database.Database, taskId: string, stage: string): Record<string, unknown> {
  const row = db.prepare(`SELECT payloadJson FROM script_studio_task_stages WHERE taskId = ? AND stage = ?`)
    .get(taskId, stage) as { payloadJson: string } | undefined;
  if (!row) return {};
  try {
    const parsed = JSON.parse(row.payloadJson) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
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

function bodyValidationIssues(validation: ReturnType<typeof validateScriptContent>): string[] {
  const titleCodes = new Set(validation.titleIssues.map((issue) => issue.code));
  return validation.issues.filter((issue) => !titleCodes.has(issue));
}

/**
 * 结尾语义审核结果（方案 §4.2 / 审查 R2）：passed 绑定正文指纹与来源修订；
 * unreviewed 表示当前生成器不支持审核（如测试替身），如实记录不补成合格。
 * 审核失败（failed）不进入保存路径——先修复重审，仍失败则该方案不保存。
 */
export type EndingReviewOutcome =
  | { status: 'passed'; fingerprint: string }
  | { status: 'unreviewed' };

interface GeneratedCandidate {
  content: ScriptStudioScriptContent;
  endingReview: EndingReviewOutcome;
}

/**
 * 保存时的校验快照（方案 §4.1 三类状态 / 审查 R2）：
 * - 时长状态如实计算（qualified/too_short/too_long），偏长候选允许保存；
 * - 文案检查分别记录本地结尾检查与语义审核结果；未审核如实标注 unreviewed；
 * - 审核指纹绑定正文与来源修订，保存前核对（正文变化则旧审核失效）。
 */
function buildValidationJson(content: ScriptStudioScriptContent, review: EndingReviewOutcome, libraryRevisionId: string): Record<string, unknown> {
  // 保存前核对（A10）：标题修复不改正文，指纹应一致；不一致（正文被改）则旧审核失效。
  const reviewPassed = review.status === 'passed'
    && review.fingerprint === scriptReviewFingerprint(content.fullScript, libraryRevisionId);
  return {
    durationStatus: content.durationStatus,
    contentCharacterCount: content.contentCharacterCount,
    copyCheck: {
      endingStatus: 'passed',
      semanticReview: reviewPassed ? 'passed' : 'unreviewed',
      ...(reviewPassed ? { reviewFingerprint: review.fingerprint } : {}),
      policyVersion: SCRIPT_CTA_POLICY_VERSION,
    },
  };
}

function bodyValidationPassed(validation: ReturnType<typeof validateScriptContent>): boolean {
  return bodyValidationIssues(validation).length === 0;
}

/** 每次修复都重新读取近期标题；最终检查和保存共用同步写事务，避免交错任务保存同名标题。 */
async function repairTitlesAndSave<T>(
  deps: ScriptStudioRunDeps,
  initial: ScriptStudioScriptContent,
  input: ScriptGeneratorInput,
  excludeScriptId: string,
  save: (content: ScriptStudioScriptContent) => T,
): Promise<{ saved: T; content: ScriptStudioScriptContent }> {
  let content = initial;
  const context = buildScriptTitleContext(input.libraryRevision, input.knowledgeContext);
  const maxAttempts = getScriptStudioLimits().titleRepairMaxAttempts;
  for (let attempt = 0; attempt <= maxAttempts; attempt += 1) {
    if (deps.signal?.aborted) throw new DOMException('标题修复已取消', 'AbortError');
    const checked = deps.db.transaction(() => {
      const previousTitles = listRecentProjectScriptTitles(deps.db, deps.projectId, { excludeScriptId, now: deps.now });
      const issues = checkScriptTitles(content, {
        libraryRevision: input.libraryRevision,
        context,
        previousTitles: [...input.previousScripts, ...previousTitles],
      });
      if (issues.length) return { issues, previousTitles };
      if (content.knowledgeContext && input.knowledgeContext) {
        content = { ...content, knowledgeContext: {
          ...content.knowledgeContext,
          displayName: context.displayName,
          searchTerms: context.searchTerms,
          searchTermsUsed: checkTitleEmbedding(input.knowledgeContext.strategy, content.title, `${content.coverTitleParts.primary}${content.coverTitleParts.secondary}`).searchTermsUsed,
        } };
      }
      return { saved: save(content) };
    }).immediate();
    if ('saved' in checked) return { saved: checked.saved!, content };
    if (attempt === maxAttempts || !deps.generator.repairTitles) {
      throw new ScriptStudioError('invalid_input', `标题未通过校验（最多修复 ${maxAttempts} 次，本方案未保存）：${checked.issues.slice(0, 3).map((issue) => issue.message).join('；')}`);
    }
    const raw = await deps.generator.repairTitles({
      ...input, content, previousTitles: checked.previousTitles, titleIssues: checked.issues,
    });
    content = applyScriptTitleRepair(content, raw, checked.issues);
  }
  throw new Error('unreachable_title_repair');
}

/**
 * 结尾质量不合格（孤立标签收尾 / 缺少 CTA）时的受约束修复（方案 §2.1）：
 * 围绕既有段落与已选卖点改写并以自然 CTA 收尾；响应只接收 segments 白名单，
 * 由服务端重新计算全文、字幕、引用、使用状态、字数与时长，随后重走完整正文校验。
 */
async function repairEndingAndRevalidate(
  deps: ScriptStudioRunDeps,
  input: ScriptGeneratorInput,
  content: ScriptStudioScriptContent,
  qualityIssues: string[],
  validateOnce: (candidate: ScriptStudioScriptContent) => ReturnType<typeof validateScriptContent>,
  candidates: ReturnType<typeof briefCandidatePoints>,
): Promise<ScriptStudioScriptContent> {
  if (!deps.generator.repairScriptContent) {
    throw new ScriptStudioError(
      'invalid_input',
      `结尾质量未修复（当前生成器不支持正文修复）：${describeValidationIssues(qualityIssues).join('；')}`,
    );
  }
  const raw = await deps.generator.repairScriptContent({ ...input, content, qualityIssues });
  const repaired = applyScriptBodyRepair(raw, content, input);
  const validation = validateOnce(repaired);
  if (!bodyValidationPassed(validation)) {
    throw new ScriptStudioError(
      'invalid_input',
      `正文修复后未通过校验：${describeValidationIssues(bodyValidationIssues(validation), { titleIssues: validation.titleIssues }).slice(0, 3).join('；')}`,
    );
  }
  const ending = checkScriptEndingQuality(validation.content, candidates);
  if (ending.issues.length > 0) {
    throw new ScriptStudioError('invalid_input', `正文修复后结尾仍不合格：${describeValidationIssues(ending.issues).join('；')}`);
  }
  return validation.content;
}

async function generateValidatedScript(
  deps: ScriptStudioRunDeps,
  library: LibraryRevisionView,
  plan: ReturnType<typeof planScriptDirections>['plans'][number],
  brief: DirectionSellingPointBrief,
  context: { audience: string; tone: string; platform: string; targetDurationSec: number; creativeBrief: string; audienceSegment?: AudienceSegmentProfile },
  previousScripts: ScriptStudioScriptContent[],
  knowledgeContext: FrozenKnowledgeContext | null,
  previousTitles: ScriptTitleSummary[] = [],
  distilledExpressions: DistilledExpressionRef[] = [],
): Promise<GeneratedCandidate> {
  let validation: ReturnType<typeof validateScriptContent> | undefined;
  let endingFeedback: string[] = [];
  const titleContext = buildScriptTitleContext(library, knowledgeContext);
  const titleEmbeddingContext = knowledgeContext
    ? {
        matchStatus: knowledgeContext.strategy.matchStatus,
        canonicalName: knowledgeContext.strategy.canonicalName,
        searchTerms: knowledgeContext.strategy.searchTerms,
      }
    : undefined;
  const baseInput: ScriptGeneratorInput = {
    libraryRevision: library,
    plan,
    brief,
    audience: context.audience,
    ...(context.audienceSegment ? { audienceSegment: context.audienceSegment } : {}),
    tone: context.tone,
    platform: context.platform,
    creativeBrief: context.creativeBrief,
    targetDurationSec: context.targetDurationSec,
    previousScripts,
    previousTitles,
    signal: deps.signal,
    ...(knowledgeContext ? { knowledgeContext } : {}),
    ...(distilledExpressions.length ? { distilledExpressions } : {}),
  };
  const candidates = briefCandidatePoints(baseInput);
  const validateOnce = (candidate: ScriptStudioScriptContent) => validateScriptContent(candidate, {
    libraryRevision: library,
    siblingScripts: previousScripts,
    previousTitles,
    titleContext,
    titleEmbeddingContext,
  });
  const fingerprintOf = (content: ScriptStudioScriptContent): string =>
    scriptReviewFingerprint(content.fullScript, library.id);
  type AttemptOutcome =
    | { status: 'passed'; content: ScriptStudioScriptContent; review: EndingReviewOutcome }
    | { status: 'body_failed' }
    | { status: 'ending_repair_failed'; feedback: string[] };
  const runAttempt = async (validationFeedback?: string[]): Promise<AttemptOutcome> => {
    // 生成/网络错误直接上抛（沿用既有语义）；只有正文校验失败、修复失败与审核失败走轮内处理。
    const generated = await deps.generator.generate({ ...baseInput, ...(validationFeedback ? { validationFeedback } : {}) });
    const attemptValidation = validateOnce(generated.content);
    if (!bodyValidationPassed(attemptValidation)) {
      validation = attemptValidation;
      return { status: 'body_failed' };
    }
    // 本地末句检查（孤立标签 / 渠道未确认 / 缺行动邀请）：不合格进入受约束修复。
    const ending = checkScriptEndingQuality(attemptValidation.content, candidates);
    if (ending.issues.length > 0) {
      try {
        const repaired = await repairEndingAndRevalidate(
          deps, baseInput, attemptValidation.content, ending.issues, validateOnce, candidates,
        );
        return await reviewCandidate(repaired, false);
      } catch (error) {
        if (deps.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
        if (error instanceof ScriptStudioError && error.code === 'request_budget_exhausted') throw error;
        return { status: 'ending_repair_failed', feedback: [error instanceof Error ? error.message : String(error)] };
      }
    }
    return await reviewCandidate(attemptValidation.content);
  };
  /** 有界语义审核：初筛通过后复核；失败先定向修复再复审一次，仍失败结束该方案。 */
  const reviewCandidate = async (candidate: ScriptStudioScriptContent, allowRepair = true): Promise<AttemptOutcome> => {
    if (!deps.generator.reviewScriptContent) {
      return { status: 'passed', content: candidate, review: { status: 'unreviewed' } };
    }
    let verdict;
    try {
      verdict = parseScriptEndingReview(await deps.generator.reviewScriptContent({ ...baseInput, content: candidate }));
    } catch (error) {
      if (deps.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
      if (error instanceof ScriptStudioError && error.code === 'request_budget_exhausted') throw error;
      // 审核调用失败 fail closed：不能默认通过，按修复失败进入下一轮。
      return { status: 'ending_repair_failed', feedback: [`语义审核调用失败：${error instanceof Error ? error.message : String(error)}`] };
    }
    if (verdict.pass) {
      return { status: 'passed', content: candidate, review: { status: 'passed', fingerprint: fingerprintOf(candidate) } };
    }
    if (!allowRepair) return { status: 'ending_repair_failed', feedback: verdict.issues };
    // 审核失败 → 携具体原因定向修复一次 → 复审一次。
    try {
      const repaired = await repairEndingAndRevalidate(
        deps, baseInput, candidate, verdict.issues, validateOnce, candidates,
      );
      const reVerdict = parseScriptEndingReview(await deps.generator.reviewScriptContent({ ...baseInput, content: repaired }));
      if (reVerdict.pass) {
        return { status: 'passed', content: repaired, review: { status: 'passed', fingerprint: fingerprintOf(repaired) } };
      }
      return { status: 'ending_repair_failed', feedback: reVerdict.issues };
    } catch (error) {
      if (deps.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
      if (error instanceof ScriptStudioError && error.code === 'request_budget_exhausted') throw error;
      return { status: 'ending_repair_failed', feedback: [error instanceof Error ? error.message : String(error)] };
    }
  };
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (deps.signal?.aborted) throw new DOMException('脚本生成已取消', 'AbortError');
    const feedback = [
      ...(attempt > 1 && validation ? describeValidationIssues(bodyValidationIssues(validation)) : []),
      ...(attempt > 1 ? endingFeedback : []),
    ].slice(0, 5);
    const outcome = await runAttempt(feedback.length > 0 ? feedback : undefined);
    if (outcome.status === 'passed') return { content: outcome.content, endingReview: outcome.review };
    if (outcome.status === 'ending_repair_failed') {
      endingFeedback = outcome.feedback;
      break; // 修复/复审失败保留原因，不能整篇重写后重复同一审核链。
    }
  }
  if (deps.fallbackOnInvalid && endingFeedback.length === 0) {
    const outcome = await runAttempt(undefined);
    if (outcome.status === 'passed') return { content: outcome.content, endingReview: outcome.review };
    if (outcome.status === 'ending_repair_failed') endingFeedback = outcome.feedback;
  }
  const issues = validation
    ? describeValidationIssues(validation.issues, { titleIssues: validation.titleIssues }).slice(0, 3)
    : [];
  throw new ScriptStudioError(
    'invalid_input',
    `脚本未通过校验：${[...issues, ...endingFeedback].slice(0, 3).join('；') || '多次生成与修复后仍不合格'}`,
  );
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

  // 已保存的首次提取结果属于本任务；恢复时继续使用同一修订，避免重读图与引用漂移。
  const savedLibraryStage = task.stages.find((stage) => stage.stage === 'save_library' && stage.status === 'succeeded');
  const savedLibraryId = savedLibraryStage
    ? stagePayload(JSON.parse(savedLibraryStage.payloadJson)).libraryRevisionId
    : undefined;
  const recoveredLibrary = typeof savedLibraryId === 'string' ? getLibraryRevision(db, projectId, savedLibraryId) : undefined;
  const firstExtraction = task.mode === 'first_extraction' && !recoveredLibrary;
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
    } else if (isReuse || recoveredLibrary) {
      startStage(db, projectId, taskId, 'load_library', now);
      await updateTask(db, projectId, taskId, { currentStage: 'load_library' }, now);
      libraryRevision = recoveredLibrary ?? (deps.libraryRevisionId
        ? getLibraryRevision(db, projectId, deps.libraryRevisionId)
        : undefined);
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
      // 本地来源集已把页与项目绑定；详情文件完整主干可辅助识别系列/组合，
      // 不用文件名推断项目归属，不同品牌/大类及无系列依据的不同型号仍拦截。
      const sourcePages = tileResult!.pages.map((page) => ({
        pageIndex: page.pageIndex,
        filename: page.filename,
      }));
      const identityContext = {
        brand: extraction.brand,
        category: extraction.category,
        sourcePages,
      };
      const pageIdentities = extraction.pageIdentities || [];
      const identityComparisons = comparePageIdentityPairs(pageIdentities, identityContext);
      const conflict = findCrossProductConflict(pageIdentities, identityContext);
      const extractStagePayload = {
        productName: extraction.productName,
        category: extraction.category,
        brand: extraction.brand,
        candidateCount: extracted.length,
        requestCount: extraction.batchMetrics?.length ?? null,
        batchMetrics: extraction.batchMetrics ?? [],
        pageIdentities,
        sourcePages,
        identityComparisons,
      };
      if (conflict) {
        const [first, second] = conflict;
        finishStage(db, projectId, taskId, 'extract', 'failed', {
          ...extractStagePayload,
          conflict: {
            pageIndexes: [first.pageIndex, second.pageIndex],
            productNames: [first.productName, second.productName],
          },
        }, 'invalid_input', now);
        throw new ScriptStudioError(
          'invalid_input',
          `检测到疑似多个不同商品（第 ${first.pageIndex + 1} 页识别为「${first.productName}」，`
          + `第 ${second.pageIndex + 1} 页识别为「${second.productName}」），请确认所有详情页属于同一商品后再生成`,
        );
      }
      finishStage(db, projectId, taskId, 'extract', 'succeeded', extractStagePayload, null, now);

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

    // 卖点提炼层（方案 §3）：把通过核验的事实全局归并为购买理由短句与标签。
    // 结果绑定来源修订/规则版本/模型身份；缓存命中不重复请求；提炼失败只降级跳过，
    // 不阻断脚本生成（正文继续使用原有可用事实）。
    let distilledExpressions: DistilledExpressionRef[] = [];
    // 默认链路直接使用可用事实。保留显式注入能力以读取/验证历史派生结果。
    if (deps.distiller) {
      startStage(db, projectId, taskId, 'distill', now);
      await updateTask(db, projectId, taskId, { currentStage: 'distill' }, now);
      const usableFacts = distillableFacts(libraryRevision!);
      if (!deps.distiller || usableFacts.length === 0) {
        finishStage(db, projectId, taskId, 'distill', 'skipped', {
          reason: deps.distiller ? 'no_usable_facts' : 'no_distiller',
        }, null, now);
      } else {
        const fingerprint = distillationFingerprint({
          projectId,
          sourceLibraryRevisionId: libraryRevision!.id,
          ruleVersion: SELLING_POINT_DISTILL_RULE_VERSION,
          providerId: deps.distiller.providerId,
          model: deps.distiller.model,
        });
        const cached = findCachedDistilledPoints(db, projectId, fingerprint);
        if (cached.length > 0) {
          distilledExpressions = distilledExpressionRefs(cached);
          finishStage(db, projectId, taskId, 'distill', 'succeeded', {
            cached: true,
            ...countDistilledStatus(cached),
          }, null, now);
        } else {
          try {
            if (deps.signal?.aborted) throw new DOMException('卖点提炼已取消', 'AbortError');
            reserveDistillRequest(db, taskId, now ?? (() => new Date()));
            const rawDistill = await deps.distiller.distill({
              facts: usableFacts,
              productName: libraryRevision!.productName,
              signal: deps.signal,
            });
            // 模型返回后、持久化前再检查取消：停机/手动停止期间返回的结果不再落库（R5）。
            if (deps.signal?.aborted) throw new DOMException('卖点提炼已取消', 'AbortError');
            const validatedDistill = parseAndValidateDistilledPoints(rawDistill, usableFacts);
            const savedDistill = saveDistilledPoints(db, {
              projectId,
              sourceLibraryRevisionId: libraryRevision!.id,
              providerId: deps.distiller.providerId,
              model: deps.distiller.model,
              fingerprint,
              points: validatedDistill.points,
            }, now ?? (() => new Date()));
            distilledExpressions = distilledExpressionRefs(savedDistill);
            finishStage(db, projectId, taskId, 'distill', 'succeeded', {
              cached: false,
              rejectedCount: validatedDistill.rejectedCount,
              ...countDistilledStatus(savedDistill),
            }, null, now);
          } catch (distillError) {
            if (deps.signal?.aborted || (distillError instanceof Error && distillError.name === 'AbortError')) throw distillError;
            finishStage(db, projectId, taskId, 'distill', 'skipped', {
              reason: distillError instanceof ScriptStudioError && distillError.code === 'request_budget_exhausted'
                ? 'budget_exhausted'
                : 'distill_failed',
              error: distillError instanceof Error ? distillError.message : String(distillError),
            }, null, now);
          }
        }
      }
    }

    startStage(db, projectId, taskId, 'plan', now);
    await updateTask(db, projectId, taskId, { currentStage: 'plan' }, now);
    const plans = planScriptDirections(libraryRevision!, requestedCount, creativeBrief);
    // 框架适配（方案 §4.3 / A7）：知识框架的固定秒数与目标时长冲突时转为相对节奏，保留 CTA 结尾意图。
    // prompt、plan 阶段快照与脚本内容快照共用同一有效结构；原目录结构保留在冻结知识上下文快照中供溯源。
    const plansWithRecommendations = (knowledgeContext
      ? applyKnowledgeRecommendations(plans.plans, knowledgeContext.recommendations)
      : plans.plans
    ).map((plan) => adaptPlanRecommendation(plan, targetDurationSec));
    // 受众画像（audience-profile-v1）：既有快照指纹匹配直接复用；否则模型分析一次；
    // 调用/解析/预算失败降级为本地推导画像，不阻塞脚本生成。
    const audienceFingerprint = audienceProfileFingerprint({
      libraryRevisionId: libraryRevision!.id,
      plans: plansWithRecommendations,
      creativeBrief,
      targetDurationSec,
    });
    const fallbackAudienceProfile = (reason: string) => deriveFallbackAudienceProfile({
      libraryRevision: libraryRevision!,
      plans: plansWithRecommendations,
      creativeBrief,
      targetDurationSec,
      audienceLabel: plans.audience,
      reason,
    });
    let audienceProfile: AudienceProfileResult | null =
      readAudienceProfileFromStagePayload(readStagePayload(db, taskId, 'plan'), audienceFingerprint);
    if (!audienceProfile) {
      if (!deps.generator.analyzeAudienceProfile) {
        audienceProfile = fallbackAudienceProfile('生成器不支持受众画像分析');
      } else {
        try {
          reservePlanAnalysisRequest(db, taskId, now);
          const rawProfile = await deps.generator.analyzeAudienceProfile({
            libraryRevision: libraryRevision!,
            plans: plansWithRecommendations,
            creativeBrief,
            targetDurationSec,
            signal: deps.signal,
          });
          if (deps.signal?.aborted) throw new DOMException('脚本生成已取消', 'AbortError');
          const parsed = parseAudienceProfile(rawProfile, {
            plans: plansWithRecommendations,
            sellingPointIds: libraryRevision!.sellingPoints.map((point) => point.id),
          });
          audienceProfile = parsed
            ? {
                version: AUDIENCE_PROFILE_VERSION,
                summary: audienceProfileSummary(parsed.primary),
                primary: parsed.primary,
                perPlan: parsed.perPlan,
                degraded: false,
                fingerprint: audienceFingerprint,
              }
            : fallbackAudienceProfile('画像响应缺少主画像或结构非法');
        } catch (profileError) {
          if (deps.signal?.aborted || (profileError instanceof Error && profileError.name === 'AbortError')) throw profileError;
          audienceProfile = fallbackAudienceProfile(profileError instanceof Error ? profileError.message : String(profileError));
        }
      }
    }
    // 画像只作排序信号与 prompt 上下文，不扩大事实来源。
    const audienceSignals = new Map(audienceProfile.perPlan.map((segment) => [segment.planIndex, {
      relatedSellingPointIds: segment.relatedSellingPointIds,
      keywords: [segment.segment, segment.scenario, ...segment.pains, ...segment.decisionDrivers],
    }]));
    const audienceSegmentByPlan = new Map(audienceProfile.perPlan.map((segment) => [segment.planIndex, segment]));
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
      audienceSignals,
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
        audienceProfile: serializeAudienceProfile(audienceProfile),
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
      audienceProfile: serializeAudienceProfile(audienceProfile),
      plans: plansWithRecommendations,
      briefs: briefSnapshots,
      knowledgeContext: knowledgeContext ? serializeKnowledgeForStage(knowledgeContext) : null,
    }, null, now);

    startStage(db, projectId, taskId, 'generate', now);
    await updateTask(db, projectId, taskId, { currentStage: 'generate' }, now);
    const recentTitles = listRecentProjectScriptTitles(db, projectId, { excludeScriptId: targetScriptId, now });
    const generationContext = {
      audience: plans.audience,
      tone: plans.tone,
      platform: plans.platform,
      targetDurationSec,
      creativeBrief,
    };
    // 保存的方案身份与版本同事务写入 validationJson；即使保存后立即停机也不会重复生成。
    const completedPlans = new Set<number>();
    const savedRevisions = db.prepare(`
      SELECT r.scriptId, r.contentJson, r.validationJson FROM project_script_revisions r
      JOIN project_scripts s ON s.id = r.scriptId
      WHERE s.projectId = ? AND r.generationTaskId = ? AND r.libraryRevisionId = ?
      ORDER BY r.rowid
    `).all(projectId, taskId, libraryRevision!.id) as Array<{ scriptId: string; contentJson: string; validationJson: string }>;
    for (const saved of savedRevisions) {
      const planIndex = (JSON.parse(saved.validationJson) as { generationPlanIndex?: number }).generationPlanIndex;
      if (!planIndex || completedPlans.has(planIndex) || !plansWithRecommendations.some((plan) => plan.index === planIndex)) continue;
      completedPlans.add(planIndex);
      scriptIds.push(saved.scriptId);
      createdScripts.push(JSON.parse(saved.contentJson) as ScriptStudioScriptContent);
    }
    await updateTask(db, projectId, taskId, { succeededCount: scriptIds.length, failedCount: 0 }, now);
    type InitialResult = { candidate?: GeneratedCandidate; error?: unknown };
    // 按完成顺序串行完成兄弟方案校验、标题修复与保存，异步修复期间不允许另一方案抢先保存。
    const finalizeProposal = async (index: number, initial: InitialResult): Promise<void> => {
      const plan = plansWithRecommendations[index]!;
      const brief = briefByPlanIndex.get(plan.index);
      if (!brief) throw new ScriptStudioError('invalid_input', `缺少方案 ${plan.index} 的方向卖点包`);
      try {
        if (signal?.aborted) throw new DOMException('脚本生成已取消', 'AbortError');
        if (initial.error) throw initial.error;
        let candidate: GeneratedCandidate = initial.candidate!;
        const titleEmbeddingContext = knowledgeContext
          ? {
              matchStatus: knowledgeContext.strategy.matchStatus,
              canonicalName: knowledgeContext.strategy.canonicalName,
              searchTerms: knowledgeContext.strategy.searchTerms,
            }
          : undefined;
        const siblingValidation = validateScriptContent(candidate.content, {
          libraryRevision: libraryRevision!,
          siblingScripts: createdScripts,
          titleContext: buildScriptTitleContext(libraryRevision!, knowledgeContext),
          titleEmbeddingContext,
        });
        if (!bodyValidationPassed(siblingValidation)) {
          candidate = await generateValidatedScript(
            deps,
            libraryRevision!,
            plan,
            brief,
            { ...generationContext, audienceSegment: audienceSegmentByPlan.get(plan.index) },
            createdScripts,
            knowledgeContext,
            recentTitles,
            distilledExpressions,
          );
        } else {
          candidate = { content: siblingValidation.content, endingReview: candidate.endingReview };
        }
        const content = candidate.content;
        const recommendationJson = recommendationForPlan(plan);
        const finalized = await repairTitlesAndSave(deps, content, {
          libraryRevision: libraryRevision!, plan, brief, ...generationContext,
          ...(audienceSegmentByPlan.has(plan.index) ? { audienceSegment: audienceSegmentByPlan.get(plan.index) } : {}),
          previousScripts: createdScripts, signal,
          ...(knowledgeContext ? { knowledgeContext } : {}),
        }, targetScriptId, (content) => targetScriptId
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
              validationJson: { ...buildValidationJson(content, candidate.endingReview, libraryRevision!.id), generationPlanIndex: plan.index },
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
              validationJson: { ...buildValidationJson(content, candidate.endingReview, libraryRevision!.id), generationPlanIndex: plan.index },
              strategyCatalogRevisionId: knowledgeContext?.strategy.strategyCatalogRevisionId ?? '',
              strategyEntryId: knowledgeContext?.strategy.strategyEntryId ?? '',
              templateCatalogRevisionId: knowledgeContext?.template.templateCatalogRevisionId ?? '',
              recommendationJson,
            }, now)
        );
        scriptIds.push(finalized.saved.id);
        createdScripts.push(finalized.content);
      } catch (generationError) {
        // 中断/取消不是单条失败：直接上抛走任务级取消语义（queued 恢复或 cancelled）。
        if (deps.signal?.aborted || (generationError instanceof Error && generationError.name === 'AbortError')) throw generationError;
        // 单条失败不阻断其余方案；部分成功由任务结束时的计数表达。
        generationErrors.push(generationError instanceof Error ? generationError.message : String(generationError));
      }
      await updateTask(db, projectId, taskId, {
        succeededCount: scriptIds.length, failedCount: generationErrors.length,
      }, now);
    };
    let finalization = Promise.resolve();
    let generationCursor = 0;
    const generateWorker = async (): Promise<void> => {
      while (generationCursor < plansWithRecommendations.length) {
        if (signal?.aborted) throw new DOMException('脚本生成已取消', 'AbortError');
        const index = generationCursor++;
        const plan = plansWithRecommendations[index]!;
        if (completedPlans.has(plan.index)) continue;
        const brief = briefByPlanIndex.get(plan.index);
        if (!brief) throw new ScriptStudioError('invalid_input', `缺少方案 ${plan.index} 的方向卖点包`);
        let initial: InitialResult;
        try {
          initial = { candidate: await generateValidatedScript(
            deps, libraryRevision!, plan, brief,
            { ...generationContext, audienceSegment: audienceSegmentByPlan.get(plan.index) },
            [...createdScripts], knowledgeContext, recentTitles, distilledExpressions,
          ) };
        } catch (error) {
          initial = { error };
        }
        const finished = finalization.then(() => finalizeProposal(index, initial));
        // 后续 worker 可继续排队；中断由各 worker 上报，并在全部排空后统一处理。
        finalization = finished.catch(() => {});
        await finished;
      }
    };
    const generationConcurrency = Math.max(1, Math.min(plansWithRecommendations.length, getScriptStudioLimits().generationConcurrency));
    const workers = await Promise.allSettled(Array.from({ length: generationConcurrency }, () => generateWorker()));
    const rejected = workers.find((result) => result.status === 'rejected');
    if (rejected?.status === 'rejected') throw rejected.reason;
    finishStage(db, projectId, taskId, 'generate', scriptIds.length > 0 ? 'succeeded' : 'failed', {
      generated: scriptIds.length,
      requested: requestedCount,
      initialConcurrency: generationConcurrency,
      errors: generationErrors.slice(0, 5),
    }, scriptIds.length === 0 ? generationErrors[0] || 'script_generation_failed' : null, now);

    finishStage(db, projectId, taskId, 'validate', scriptIds.length > 0 ? 'succeeded' : 'failed', {
      passed: scriptIds.length,
      failed: Math.max(0, requestedCount - scriptIds.length),
      errors: generationErrors.slice(0, 5),
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
    const failedTask = getTask(db, projectId, taskId);
    const runningStage = failedTask?.currentStage || '';
    const runningStageRow = failedTask?.stages.find((stage) => stage.stage === runningStage);
    if (runningStage && runningStageRow?.status === 'running') {
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
    distiller?: SellingPointDistiller;
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
    distiller: options.distiller,
    signal: options.signal,
    now: options.now,
    fallbackOnInvalid: options.fallbackOnInvalid,
  };
}
