import type Database from 'better-sqlite3';
import { PAIN_SOLVING_VERSION, painPlanningFingerprint, parsePainPlanning, painPlan, painBrief, parsePainReview } from './pain-solving.ts';
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
import { storedEvidenceIsStructurallyUsable, planDirectionBriefs, type DirectionSellingPointBrief } from './direction-briefs.ts';
import { isSellingPointEvidenceUsable, normalizeEvidenceRefs } from './selling-point-normalize.ts';
import { applyKnowledgeRecommendations, planScriptDirections } from './planner.ts';
import { parseKnowledgeContext, type FrozenKnowledgeContext } from './knowledge-context.ts';
import { getScriptStudioLimits } from './limits.ts';
import { parseScriptProductionMode, parseScriptStudioRequestedCount, parseScriptStudioTargetDuration } from './generation-contract.ts';
import { isScriptStudioTaskCancelRequested } from './scheduler.ts';
import { parseTileRefIndex, tileSourceImages, selectEvidenceTiles, type TileSetResult } from './tiling.ts';
import {
  finishStage,
  getTask,
  mergeStagePayload,
  startStage,
  updateTask,
} from './tasks.ts';
import { describeValidationIssues, validateScriptContent } from './validation.ts';
import { applyScriptTitleRepair, buildScriptTitleContext, checkScriptTitles, type ScriptTitleSummary } from './title-policy.ts';
import { checkTitleEmbedding } from './title-embedding.ts';
import { comparePageIdentityPairs, findCrossProductConflict } from './page-identity.ts';
import {
  parseFrozenTemplatePlan,
  TEMPLATE_REWRITE_VERSION,
  templatePlanFingerprint,
} from './template-rewrite.ts';
import {
  readViralTemplateStyleCache,
  writeViralTemplateStyleCache,
} from './viral-templates.ts';
import type { TemplateRewriteResumeState } from './generator.ts';
import type { FrozenViralTemplateSpec, SellingPointRecord } from './types.ts';
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
import { SELLING_POINT_ORGANIZATION_VERSION, type SellingPointOrganizer } from './selling-point-organizer.ts';

export interface ScriptStudioRunDeps {
  db: Database.Database;
  projectId: string;
  taskId: string;
  sourceSetId?: string | null;
  libraryRevisionId?: string | null;
  inputSnapshot: Record<string, unknown>;
  visionExtractor: VisionExtractor;
  directVision?: boolean;
  reprobe: EvidenceReprobe;
  generator: ScriptGenerator;
  /** 卖点提炼器（方案 §3）：缺省时跳过提炼阶段，不阻断脚本生成。 */
  distiller?: SellingPointDistiller;
  sellingPointOrganizer?: SellingPointOrganizer;
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
  // 模板改写模式无 CTA 强制与语义审核（源项目没有该阶段）：如实标注 not_required。
  if (content.templateRewrite) {
    return {
      durationStatus: content.durationStatus,
      contentCharacterCount: content.contentCharacterCount,
      copyCheck: {
        endingStatus: 'not_required',
        semanticReview: 'not_required',
        policyVersion: TEMPLATE_REWRITE_VERSION,
      },
    };
  }
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
      policyVersion: content.painSolving ? PAIN_SOLVING_VERSION : SCRIPT_CTA_POLICY_VERSION,
    },
  };
}

function checkProductionEnding(content: ScriptStudioScriptContent, candidates: ReturnType<typeof briefCandidatePoints>) {
  const result = checkScriptEndingQuality(content, candidates);
  return content.painSolving ? { ...result, issues: result.issues.filter((issue) => issue !== 'cta_ending_missing') } : result;
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
    if (input.plan.painSolving) {
      if (!deps.generator.reviewScriptContent) throw new ScriptStudioError('invalid_input', '痛点脚本标题修复后需要语义审核');
      const verdict = parsePainReview(await deps.generator.reviewScriptContent({ ...input, content }));
      if (!verdict.pass) throw new ScriptStudioError('invalid_input', `标题修复后未通过内容命题审核：${verdict.issues.join('；')}`);
    }
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
  const ending = checkProductionEnding(validation.content, candidates);
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
  peerPainOpportunities: NonNullable<ScriptStudioScriptContent['painSolving']>[] = [],
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
    peerPainOpportunities,
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
  const parseReview = plan.painSolving ? parsePainReview : parseScriptEndingReview;
  const fingerprintOf = (content: ScriptStudioScriptContent): string =>
    scriptReviewFingerprint(content.fullScript, library.id);
  type AttemptOutcome =
    | { status: 'passed'; content: ScriptStudioScriptContent; review: EndingReviewOutcome }
    | { status: 'body_failed' }
    | { status: 'ending_repair_failed'; feedback: string[] };
  const runAttempt = async (validationFeedback?: string[]): Promise<AttemptOutcome> => {
    // 生成/网络错误直接上抛（沿用既有语义）；只有正文校验失败、修复失败与审核失败走轮内处理。
    const generated = await deps.generator.generate({ ...baseInput, ...(validationFeedback ? { validationFeedback } : {}) });
    const attemptValidation = validateOnce(plan.painSolving ? { ...generated.content, productionMode: 'pain_solving_15s', painSolving: plan.painSolving } : generated.content);
    if (!bodyValidationPassed(attemptValidation)) {
      validation = attemptValidation;
      return { status: 'body_failed' };
    }
    // 本地末句检查（孤立标签 / 渠道未确认 / 缺行动邀请）：不合格进入受约束修复。
    const ending = checkProductionEnding(attemptValidation.content, candidates);
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
      if (plan.painSolving) throw new ScriptStudioError('invalid_input', '痛点解决型需要语义审核，当前生成器不支持');
      return { status: 'passed', content: candidate, review: { status: 'unreviewed' } };
    }
    let verdict;
    try {
      verdict = parseReview(await deps.generator.reviewScriptContent({ ...baseInput, content: candidate }));
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
      const reVerdict = parseReview(await deps.generator.reviewScriptContent({ ...baseInput, content: repaired }));
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
  let productionMode: 'standard' | 'pain_solving_15s' | 'template_rewrite';
  let targetDurationSec: number;
  let requestedCount: number;
  let creativeBrief: string;
  // 爆文模板改写：任务创建时冻结的模板全文快照（含选择顺序）。
  let frozenTemplates: FrozenViralTemplateSpec[] = [];
  // 知识/模板目录推荐在创建任务时冻结在 inputSnapshot；runner 只读快照，
  // 设置页切换当前目录版本不改变运行中任务。
  const knowledgeContext = parseKnowledgeContext(input.knowledgeContext);
  try {
    targetDurationSec = parseTargetDuration(input);
    productionMode = parseScriptProductionMode(input.productionMode, targetDurationSec);
    requestedCount = parseRequestedCount(input);
    creativeBrief = parseCreativeBrief(input);
    if (productionMode === 'template_rewrite') {
      frozenTemplates = parseFrozenTemplatePlan(input.templatePlan);
      if (frozenTemplates.length === 0) {
        throw new ScriptStudioError('invalid_input', '爆文模板改写需要至少 1 个可用模板');
      }
      if (frozenTemplates.length !== requestedCount) {
        throw new ScriptStudioError('invalid_input', '生成数量必须与选中模板数一致（每个模板生成一条）');
      }
    }
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
  // 仅提取卖点库（爆文模板改写前置）：保存卖点库后即成功，不进入提炼/规划/生成。
  const extractOnly = input.extractOnly === true;
  let plannedCount = productionMode === 'pain_solving_15s' ? 0 : requestedCount;
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
      ...(extractOnly ? { extractOnly: true } : {}),
    }, null, now);

    if (firstExtraction) {
      startStage(db, projectId, taskId, 'read_pages', now);
      await updateTask(db, projectId, taskId, { currentStage: 'read_pages' }, now);
      if (!deps.sourceSetId) throw new ScriptStudioError('invalid_input', '首次生成必须提供详情页来源集');
      const imageAssetIds = (db.prepare(`
        SELECT imageAssetIdsJson FROM script_studio_source_sets WHERE id = ? AND projectId = ?
      `).get(deps.sourceSetId, projectId) as { imageAssetIdsJson: string } | undefined)?.imageAssetIdsJson;
      if (!imageAssetIds) throw new ScriptStudioError('not_found', '详情页来源集不存在');
      tileResult = await tileSourceImages(db, projectId, JSON.parse(imageAssetIds) as string[], { signal, directVision: deps.directVision });
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
        manualReview: deps.directVision,
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

      // 事实核验后全局组织「核心卖点＋详解」，避免切片批次把参数拆成平级卖点。
      // 不静默回退碎片库；整理失败保留具体错误，用户可以重试。
      let organizedPoints = evidenceResult.points;
      const needsOrganization = !deps.directVision || (extraction.batchMetrics?.length ?? 1) > 1;
      if (deps.sellingPointOrganizer && needsOrganization) {
        startStage(db, projectId, taskId, 'organize', now);
        await updateTask(db, projectId, taskId, { currentStage: 'organize' }, now);
        organizedPoints = await deps.sellingPointOrganizer.organize(evidenceResult.points, signal);
        finishStage(db, projectId, taskId, 'organize', 'succeeded', {
          factCount: usableSellingPoints(evidenceResult.points).length,
          sellingPointCount: usableSellingPoints(organizedPoints).length,
        }, null, now);
      } else if (deps.directVision) {
        startStage(db, projectId, taskId, 'organize', now);
        finishStage(db, projectId, taskId, 'organize', 'skipped', {
          factCount: usableSellingPoints(evidenceResult.points).length,
          sellingPointCount: usableSellingPoints(organizedPoints).length,
          reason: '已在同一次识图中整理卖点与详解',
        }, null, now);
      }
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
        promptContractVersion: Math.max(extraction.promptContractVersion, deps.sellingPointOrganizer ? SELLING_POINT_ORGANIZATION_VERSION : 0),
        origin: 'extraction',
        sellingPoints: organizedPoints,
      }, now);
      finishStage(db, projectId, taskId, 'save_library', 'succeeded', {
        libraryRevisionId: libraryRevision.id,
        revisionNumber: libraryRevision.revisionNumber,
      }, null, now);
    } else {
      // reuse 模式没有 extraction/evidence 阶段，阶段列表按复用定义展示。
    }

    // 仅提取卖点库（爆文模板改写前置）：卖点库落库即任务完成，不产出脚本。
    if (extractOnly && libraryRevision) {
      await updateTask(db, projectId, taskId, {
        status: 'succeeded',
        currentStage: 'save_library',
        succeededCount: 0,
        failedCount: 0,
      }, now);
      return {
        status: 'succeeded',
        succeededCount: 0,
        failedCount: 0,
        scriptIds,
      };
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
    const evidenceBounds = tileResult
      ? { pageCount: tileResult.pages.length, pageTileCounts: tileResult.pages.map((page) => page.tiles.length) }
      : { pageCount: sourceSetPageCount(db, projectId, libraryRevision!.sourceSetId) };
    let plans: ReturnType<typeof planScriptDirections>;
    let plansWithRecommendations: ReturnType<typeof planScriptDirections>['plans'];
    let audienceProfile: AudienceProfileResult | null = null;
    let audienceSegmentByPlan = new Map<number, AudienceSegmentProfile>();
    let briefs: DirectionSellingPointBrief[];
    let priorPainOpportunities: NonNullable<ScriptStudioScriptContent['painSolving']>[] = [];
    let painPlanning: (ReturnType<typeof parsePainPlanning> & { fingerprint: string }) | null = null;
    // 爆文模板改写：合格卖点 = 证据有效 ∧ 用户保留 ∧ 结构重验通过 ∧ 详解 verified。
    let templateEligiblePoints: SellingPointRecord[] = [];
    if (productionMode === 'template_rewrite') {
      templateEligiblePoints = libraryRevision!.sellingPoints.filter((point) =>
        isSellingPointEvidenceUsable(point)
        && storedEvidenceIsStructurallyUsable(point, evidenceBounds)
        && point.detailStatus === 'verified');
      if (!templateEligiblePoints.length) {
        throw new ScriptStudioError(
          'evidence_insufficient',
          '没有带有效详解的合格卖点：爆文模板改写需要含详解且通过证据校验的卖点。旧卖点库缺少详解时，请重新从详情页提取，或在卖点库中编辑补充详解',
        );
      }
      plansWithRecommendations = frozenTemplates.map((spec, index) => ({
        index: index + 1,
        templateId: `viral:${spec.sourceTemplateId}`,
        templateName: spec.name || spec.title || spec.sourceTemplateId,
        templateVersion: 1,
        rationale: spec.name || spec.title ? `爆文模板「${spec.name || spec.title}」` : '爆文模板改写',
        direction: 'template_rewrite',
        angle: '',
        templateRewrite: spec,
      }));
      plans = { plans: plansWithRecommendations, audience: '', tone: '自然口语', platform: '淘宝逛逛' };
      // 合成卖点包：初始为全部合格卖点；模板筛选完成后由 worker 更新为本模板白名单。
      // 包装语义与方向卖点包一致（模型只能看到包内候选），但不走方向轮换/配额编排。
      briefs = plansWithRecommendations.map((plan) => ({
        planIndex: plan.index,
        templateId: plan.templateId,
        themeKey: '',
        themeTitle: plan.templateName,
        requiredPointIds: templateEligiblePoints.map((point) => point.id),
        optionalPointIds: [],
        candidateCount: templateEligiblePoints.length,
        degraded: false,
        rationale: '爆文模板筛选白名单（初始为全部合格卖点）',
      }));
      audienceSegmentByPlan = new Map();
    } else if (productionMode === 'pain_solving_15s') {
      const eligibleLibrary = { ...libraryRevision!, sellingPoints: libraryRevision!.sellingPoints.filter((point) =>
        isSellingPointEvidenceUsable(point) && storedEvidenceIsStructurallyUsable(point, evidenceBounds)) };
      if (!eligibleLibrary.sellingPoints.length) throw new ScriptStudioError('evidence_insufficient', '没有可用于内容机会分析的已核验事实');
      const planningInput = { libraryRevision: eligibleLibrary, requestedCount, creativeBrief, signal };
      const fingerprint = painPlanningFingerprint(planningInput);
      if (Array.isArray(input.painPriorOpportunities)) {
        priorPainOpportunities = input.painPriorOpportunities.flatMap((opportunity) =>
          parsePainPlanning({ opportunities: [opportunity] }, { ...planningInput, requestedCount: 1 }).opportunities);
      }
      const frozen = stagePayload(readStagePayload(db, taskId, 'plan').painPlanning);
      if (Array.isArray(input.painRetryOpportunities)) {
        painPlanning = { ...parsePainPlanning({ opportunities: input.painRetryOpportunities }, planningInput), fingerprint };
      } else if (frozen.fingerprint === fingerprint) {
        painPlanning = { ...parsePainPlanning(frozen, planningInput), fingerprint };
      } else {
        if (!deps.generator.planPainOpportunities) throw new ScriptStudioError('invalid_input', '当前生成器不支持痛点内容机会分析');
        reservePlanAnalysisRequest(db, taskId, now);
        const raw = await deps.generator.planPainOpportunities(planningInput);
        if (signal?.aborted) throw new DOMException('脚本生成已取消', 'AbortError');
        painPlanning = { ...parsePainPlanning(raw, planningInput), fingerprint };
      }
      plansWithRecommendations = painPlanning.opportunities.map((opportunity, index) => painPlan(opportunity, index + 1));
      plans = { plans: plansWithRecommendations, audience: painPlanning.opportunities[0]?.audience ?? '', tone: '自然可信', platform: '淘宝逛逛' };
      briefs = painPlanning.opportunities.map((opportunity, index) => painBrief(opportunity, index + 1));
      audienceSegmentByPlan = new Map(painPlanning.opportunities.map((o, index) => [index + 1, {
        segment: o.audience, scenario: o.scenario, pains: [o.problem], decisionDrivers: [o.benefit], rejections: ['夸大功效', '虚构亲测'],
      }]));
    } else {
      plans = planScriptDirections(libraryRevision!, requestedCount, creativeBrief);
      // 框架适配（方案 §4.3 / A7）：知识框架的固定秒数与目标时长冲突时转为相对节奏，保留 CTA 结尾意图。
      // prompt、plan 阶段快照与脚本内容快照共用同一有效结构；原目录结构保留在冻结知识上下文快照中供溯源。
      plansWithRecommendations = (knowledgeContext
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
      audienceProfile =
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
      audienceSegmentByPlan = new Map(audienceProfile.perPlan.map((segment) => [segment.planIndex, segment]));
      // 本地确定性编排：一次为本轮全部方向准备卖点包，首稿与相似度重试都复用这份包。
      // 首次提取可同时校验页码与切片范围；历史复用不重读图片，但仍从来源集恢复页数，
      // 对非法格式和页码越界做本地 fail-closed 重验。
      briefs = planDirectionBriefs({
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
    }
    plannedCount = plansWithRecommendations.length;
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
    if (!painPlanning && briefs.every((brief) => brief.candidateCount === 0)) {
      finishStage(db, projectId, taskId, 'plan', 'failed', {
        audience: plans.audience,
        tone: plans.tone,
        platform: plans.platform,
        audienceProfile: audienceProfile ? serializeAudienceProfile(audienceProfile) : null,
        plans: plansWithRecommendations,
        briefs: briefSnapshots,
        knowledgeContext: knowledgeContext ? serializeKnowledgeForStage(knowledgeContext) : null,
      }, 'evidence_insufficient', now);
      throw new ScriptStudioError('evidence_insufficient', '可用证据不足：卖点库中没有通过证据门禁且可用的卖点，请先在卖点库中补充或恢复可用卖点');
    }
    // 模板改写的 plan 阶段快照只记模板摘要：完整参考文案已冻结在任务 inputSnapshot，
    // 阶段 payload 不重复存全文；模板身份（内容哈希+结构来源）保留供追溯。
    const planStagePlans: unknown = productionMode === 'template_rewrite'
      ? plansWithRecommendations.map((plan) => ({
          index: plan.index,
          templateId: plan.templateId,
          templateName: plan.templateName,
          rationale: plan.rationale,
          direction: plan.direction,
          templateRewrite: {
            entryId: plan.templateRewrite!.entryId,
            revisionId: plan.templateRewrite!.revisionId,
            sourceTemplateId: plan.templateRewrite!.sourceTemplateId,
            name: plan.templateRewrite!.name,
            title: plan.templateRewrite!.title,
            category: plan.templateRewrite!.category,
            subCategory: plan.templateRewrite!.subCategory,
            structure: plan.templateRewrite!.structure,
            structureOrigin: plan.templateRewrite!.structureOrigin,
            contentHash: plan.templateRewrite!.contentHash,
            refTextLength: plan.templateRewrite!.refText.length,
          },
        }))
      : plansWithRecommendations;
    finishStage(db, projectId, taskId, 'plan', 'succeeded', {
      audience: plans.audience,
      tone: plans.tone,
      platform: plans.platform,
      audienceProfile: audienceProfile ? serializeAudienceProfile(audienceProfile) : null,
      plans: planStagePlans,
      briefs: briefSnapshots,
      ...(productionMode === 'template_rewrite' ? {
        templateEligiblePointIds: templateEligiblePoints.map((point) => point.id),
        templatePlanFingerprint: templatePlanFingerprint(frozenTemplates),
      } : {}),
      ...(painPlanning ? { painPlanning, opportunityCount: plansWithRecommendations.length, shortageCount: requestedCount - plansWithRecommendations.length } : {}),
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
    // ------------------------------------------------------------------
    // 爆文模板改写：恢复每模板中间态（筛选/风格/修改说明），指纹不匹配的旧状态作废；
    // 风格分析缓存命中直接复用（键=模板内容哈希+实际模型+提示词版本），不重新收费。
    // ------------------------------------------------------------------
    const templateStates: Record<number, TemplateRewriteResumeState> = {};
    if (productionMode === 'template_rewrite') {
      const generatePayload = readStagePayload(db, taskId, 'generate');
      const planFingerprintValue = templatePlanFingerprint(frozenTemplates);
      const storedStates = generatePayload.templatePlanFingerprint === planFingerprintValue
        ? stagePayload(generatePayload.templateStates)
        : {};
      const providerModel = typeof input.providerModel === 'string' ? input.providerModel : '';
      for (const plan of plansWithRecommendations) {
        const spec = plan.templateRewrite!;
        const stored = stagePayload(storedStates[String(plan.index)]) as TemplateRewriteResumeState;
        const state: TemplateRewriteResumeState = { ...stored };
        if (state.styleAnalysis === undefined && providerModel) {
          const cached = readViralTemplateStyleCache(db, spec.contentHash, providerModel, TEMPLATE_REWRITE_VERSION);
          if (cached) {
            try {
              state.styleAnalysis = JSON.parse(cached.analysisJson) as TemplateRewriteResumeState['styleAnalysis'];
              state.styleDegraded = '';
            } catch {
              // 缓存损坏按未命中处理，正常走分析（不会额外收费于已完成的筛选阶段）。
            }
          }
        }
        templateStates[plan.index] = state;
        // 恢复时同步把筛选白名单回灌进卖点包（标题修复与校验边界使用同一白名单）。
        if (state.whitelistPointIds?.length) {
          const brief = briefByPlanIndex.get(plan.index);
          if (brief) {
            brief.requiredPointIds = state.whitelistPointIds;
            brief.candidateCount = state.whitelistPointIds.length;
          }
        }
      }
    }
    const runTemplateInitial = async (plan: (typeof plansWithRecommendations)[number]): Promise<InitialResult> => {
      const spec = plan.templateRewrite!;
      if (!deps.generator.runTemplateRewrite) {
        return { error: new ScriptStudioError('invalid_input', '当前生成器不支持爆文模板改写') };
      }
      try {
        if (signal?.aborted) throw new DOMException('脚本生成已取消', 'AbortError');
        const result = await deps.generator.runTemplateRewrite({
          plan,
          libraryRevision: libraryRevision!,
          eligiblePoints: templateEligiblePoints,
          targetDurationSec,
          previousTitles: [...createdScripts, ...recentTitles],
          resumeState: templateStates[plan.index],
          onStateChange: (next) => {
            templateStates[plan.index] = next;
            mergeStagePayload(deps.db, projectId, taskId, 'generate', {
              templatePlanFingerprint: templatePlanFingerprint(frozenTemplates),
              templateStates: Object.fromEntries(Object.entries(templateStates).map(([key, value]) => [String(key), value])),
            }, now);
            if (next.whitelistPointIds?.length) {
              const brief = briefByPlanIndex.get(plan.index);
              if (brief) {
                brief.requiredPointIds = next.whitelistPointIds;
                brief.candidateCount = next.whitelistPointIds.length;
              }
            }
            // 风格缓存只写完整成功结果（降级/null 不写），键含模板内容哈希+模型+提示词版本。
            if (next.styleAnalysis) {
              const providerModel = typeof input.providerModel === 'string' ? input.providerModel : '';
              if (providerModel) {
                writeViralTemplateStyleCache(deps.db, {
                  contentHash: spec.contentHash,
                  model: providerModel,
                  promptVersion: TEMPLATE_REWRITE_VERSION,
                  analysisJson: JSON.stringify(next.styleAnalysis),
                }, now);
              }
            }
          },
          signal,
        });
        return { candidate: { content: result.content, endingReview: { status: 'unreviewed' } } };
      } catch (error) {
        return { error };
      }
    };
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
          // 模板改写没有方向重试链（源项目无 validationFeedback 循环）：
          // 白名单/零引用/相似度等校验失败即该模板失败，记录具体原因，其他模板继续。
          if (productionMode === 'template_rewrite') {
            throw new ScriptStudioError(
              'invalid_input',
              `脚本未通过校验：${describeValidationIssues(bodyValidationIssues(siblingValidation), { titleIssues: siblingValidation.titleIssues }).slice(0, 3).join('；')}`,
            );
          }
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
            [...priorPainOpportunities, ...(painPlanning?.opportunities.filter((_, index) => index + 1 !== plan.index) ?? [])],
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
          peerPainOpportunities: [...priorPainOpportunities, ...(painPlanning?.opportunities.filter((_, index) => index + 1 !== plan.index) ?? [])],
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
          initial = productionMode === 'template_rewrite'
            ? await runTemplateInitial(plan)
            : { candidate: await generateValidatedScript(
                deps, libraryRevision!, plan, brief,
                { ...generationContext, audienceSegment: audienceSegmentByPlan.get(plan.index) },
                [...createdScripts], knowledgeContext, recentTitles, distilledExpressions,
                [...priorPainOpportunities, ...(painPlanning?.opportunities.filter((_, index) => index + 1 !== plan.index) ?? [])],
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
    finishStage(db, projectId, taskId, 'generate', scriptIds.length > 0 || plansWithRecommendations.length === 0 ? 'succeeded' : 'failed', {
      generated: scriptIds.length,
      requested: requestedCount,
      initialConcurrency: generationConcurrency,
      errors: generationErrors.slice(0, 5),
    }, scriptIds.length === 0 && plansWithRecommendations.length > 0 ? generationErrors[0] || 'script_generation_failed' : null, now);

    finishStage(db, projectId, taskId, 'validate', scriptIds.length > 0 || plansWithRecommendations.length === 0 ? 'succeeded' : 'failed', {
      passed: scriptIds.length,
      failed: Math.max(0, plansWithRecommendations.length - scriptIds.length),
      errors: generationErrors.slice(0, 5),
    }, scriptIds.length === 0 && plansWithRecommendations.length > 0 ? 'script_generation_failed' : null, now);
    const status = scriptIds.length >= plansWithRecommendations.length ? 'succeeded' : scriptIds.length > 0 ? 'partial' : 'failed';
    await updateTask(db, projectId, taskId, {
      status,
      currentStage: status === 'failed' ? 'validate' : 'generate',
      errorCode: status === 'failed' ? 'script_generation_failed' : null,
      errorMessage: status === 'failed' ? (generationErrors[0] || '脚本生成失败') : null,
      succeededCount: scriptIds.length,
      failedCount: Math.max(0, plansWithRecommendations.length - scriptIds.length),
    }, now);
    return {
      status,
      succeededCount: scriptIds.length,
      failedCount: Math.max(0, plansWithRecommendations.length - scriptIds.length),
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
        failedCount: Math.max(0, plannedCount - scriptIds.length),
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
      failedCount: Math.max(0, plannedCount - scriptIds.length),
    }, now);
    return {
      status: 'failed',
      succeededCount: scriptIds.length,
      failedCount: Math.max(0, plannedCount - scriptIds.length),
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
    directVision?: boolean;
    reprobe: EvidenceReprobe;
    generator: ScriptGenerator;
    distiller?: SellingPointDistiller;
    sellingPointOrganizer?: SellingPointOrganizer;
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
    directVision: options.directVision,
    reprobe: options.reprobe,
    generator: options.generator,
    distiller: options.distiller,
    sellingPointOrganizer: options.sellingPointOrganizer,
    signal: options.signal,
    now: options.now,
    fallbackOnInvalid: options.fallbackOnInvalid,
  };
}
