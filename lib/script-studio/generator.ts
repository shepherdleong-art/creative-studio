import { buildPainPlanningPrompt, PAIN_PATHS, PAIN_REVIEW_CHECKS, painWritingRequirements, type PainPlanningInput } from './pain-solving.ts';
import { normalizeAutomaticSubtitleText } from '../subtitle-display.ts';
import { buildScriptDurationBudget, countScriptContentCharacters, estimateNarrationDurationSec } from '../script-duration-policy.ts';
import type { DirectionSellingPointBrief } from './direction-briefs.ts';
import { ScriptStudioError } from './errors.ts';
import type { LibraryRevisionView } from './libraries.ts';
import type { PlannedScript } from './planner.ts';
import type { ScriptStudioCompleteJson } from './llm-contract.ts';
import { isSellingPointEvidenceUsable } from './selling-point-normalize.ts';
import { embeddingRequirementText, checkTitleEmbedding } from './title-embedding.ts';
import { buildScriptTitleContext, scriptTitleRequirements, type ScriptTitleSummary, type ScriptTitleIssue } from './title-policy.ts';
import { PAIN_PLANNING_MAX_TOKENS, SCRIPT_TITLE_REPAIR_MAX_TOKENS } from './limits.ts';
import type { ScriptRequestBudget, ScriptRequestPurpose } from './request-budget.ts';
import { ctaEndingSceneFromStructure, scriptCtaRequirements } from './cta-policy.ts';
import type { AudienceAnalysisInput, AudienceSegmentProfile } from './audience-profile.ts';
import { buildAudienceAnalysisPrompt } from './audience-profile.ts';
import type { FrozenKnowledgeContext } from './knowledge-context.ts';
import type { DistilledExpressionRef } from './distillation.ts';
import { SELLING_POINT_DISTILL_RULE_VERSION } from './distillation.ts';
import {
  buildDraftRequest,
  buildEnsureNoteRequest,
  buildFilterRequest,
  buildHumanizeRequest,
  buildSmoothCheckRequest,
  buildStyleAnalysisRequest,
  charBoundsForTarget,
  detectTemplateStyle,
  extractScriptNote,
  findResidualRuns,
  parseDraftResponse,
  parseFilterKeep,
  parsePolishedText,
  parseSegmentedText,
  parseStyleAnalysis,
  refClosingExcerpt,
  sanitizeSellingPointText,
  scriptCnLen,
  styleGuideFromAnalysis,
  templateEndingMissing,
  TEMPLATE_REWRITE_VERSION,
  TPL_STYLE_PRESETS,
  targetCharsForDuration,
  type TemplateStyleAnalysis,
} from './template-rewrite.ts';
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
  /** 当前方向绑定的细分受众画像（audience-profile-v1）：有画像时 prompt 携带结构化人群/场景/痛点。 */
  audienceSegment?: AudienceSegmentProfile;
  tone: string;
  platform: string;
  creativeBrief: string;
  targetDurationSec: number;
  previousScripts: Array<Pick<ScriptStudioScriptContent, 'fullScript'> & ScriptTitleSummary>;
  previousTitles?: ScriptTitleSummary[];
  peerPainOpportunities?: import('./types.ts').PainSolvingOpportunity[];
  signal?: AbortSignal;
  validationFeedback?: string[];
  /** 任务创建时冻结的商品身份、搜索词与推荐说明，不扩大事实来源。 */
  knowledgeContext?: FrozenKnowledgeContext;
  /**
   * 已确认（approved）的提炼表达（方案 §3.4）：短句只是表达参考，不是新的事实来源；
   * 口播事实仍须挂在 sellingPoints 引用上，范围与限定条件不得扩大。
   */
  distilledExpressions?: DistilledExpressionRef[];
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

/**
 * 提炼表达的生成边界（审查 R4 / 方案 §3.4）：只有全部来源事实都在当前方向卖点包内的
 * 派生表达才允许进入提示词——「表达来自 f1+f2 而包内只有 f1」会把包外信息
 * （如另一条事实的材质）带进 prompt，且模型可以只引用 f1 复述整句，包外 ID 拒绝规则拦不住。
 * 生成提示词与内容快照（distilledContext）共用本函数，冻结的是实际使用的表达集合。
 */
export function eligibleDistilledExpressions(input: ScriptGeneratorInput): DistilledExpressionRef[] {
  const candidateIds = new Set(briefCandidatePoints(input).map((point) => point.id));
  if (candidateIds.size === 0) return [];
  return (input.distilledExpressions || []).filter(
    (ref) => ref.sourceFactIds.length > 0 && ref.sourceFactIds.every((id) => candidateIds.has(id)),
  );
}

export interface ScriptTitleRepairInput extends ScriptGeneratorInput {
  content: ScriptStudioScriptContent;
  titleIssues: ScriptTitleIssue[];
}

// ---------------------------------------------------------------------------
// 爆文模板改写（迁移方案 §4）：单模板完整链路的输入/中间态/结果。
// 中间态（筛选/风格/修改说明）由 runner 持久化到 generate 阶段 payload，
// 恢复后已完成子阶段不重新收费；风格缓存由 runner 读写（generator 不持有 db）。
// ---------------------------------------------------------------------------

export interface TemplateRewriteResumeState {
  /** 筛选后的冻结白名单（卖点 ID）；后续改写/修复只用这组。 */
  whitelistPointIds?: string[];
  filterDegraded?: string;
  stylePresetKey?: string;
  stylePresetName?: string;
  /** undefined=未分析；null=分析失败降级；对象=成功结果（可写缓存）。 */
  styleAnalysis?: TemplateStyleAnalysis | null;
  styleDegraded?: string;
  /** 修改说明（首稿 note 优先；缺失时有余额才补生成）。 */
  note?: string;
}

export interface TemplateRewriteRunInput {
  plan: PlannedScript;
  libraryRevision: LibraryRevisionView;
  /** 合格卖点（证据有效 ∧ 用户保留 ∧ 详解 verified），由 runner 过滤。 */
  eligiblePoints: SellingPointRecord[];
  targetDurationSec: number;
  previousTitles: ScriptTitleSummary[];
  /** 同一模板已生成变体（标题+正文摘录）：生成同模板多条时由 runner 串行收集，用于差异化。 */
  siblingVariantTexts?: string[];
  resumeState?: TemplateRewriteResumeState;
  onStateChange?: (state: TemplateRewriteResumeState) => void;
  signal?: AbortSignal;
}

export interface TemplateRewriteRunResult {
  content: ScriptStudioScriptContent;
  state: TemplateRewriteResumeState;
}

/** 受约束正文修复输入（方案 §2.1）：只修正文质量问题，标题/时长/知识来源保持冻结。 */
export interface ScriptBodyRepairInput extends ScriptGeneratorInput {
  content: ScriptStudioScriptContent;
  /** 本地结尾质量检查或语义审核给出的具体问题（中文描述）。 */
  qualityIssues: string[];
}

/** 语义审核输入（方案 §4.2 / 审查 R2）：只读复核，不改写任何内容。 */
export interface ScriptEndingReviewInput extends ScriptGeneratorInput {
  content: ScriptStudioScriptContent;
}

export interface ScriptGenerator {
  planPainOpportunities?(input: PainPlanningInput): Promise<unknown>;
  repairTitles?(input: ScriptTitleRepairInput): Promise<unknown>;
  /** 围绕既有段落与已选卖点改写正文，并以自然 CTA 收尾；响应只接收 segments 白名单字段。 */
  repairScriptContent?(input: ScriptBodyRepairInput): Promise<unknown>;
  /**
   * 有界语义审核（方案 §4.2 / 审查 R2）：本地末句初筛通过后复核行动邀请、主题承接、
   * 渠道、事实支持与 CTA 后无附加内容；fail closed——未通过/不可解析不能默认合格。
   */
  reviewScriptContent?(input: ScriptEndingReviewInput): Promise<unknown>;
  /**
   * 受众画像分析（audience-profile-v1）：plan 阶段一次轻量调用，输出主画像 + 每方向细分切口。
   * 缺省时 runner 直接使用本地降级画像，不阻塞脚本生成。
   */
  analyzeAudienceProfile?(input: AudienceAnalysisInput): Promise<unknown>;
  /** 爆文模板改写：单模板完整链路（筛选→风格→首稿→修正→润色→终检→说明）。 */
  runTemplateRewrite?(input: TemplateRewriteRunInput): Promise<TemplateRewriteRunResult>;
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

/** 结尾场景来自（已适配的）框架结构；无框架时使用通用 CTA 规则。 */
function endingSceneForPlan(plan: PlannedScript): string | null {
  return ctaEndingSceneFromStructure(plan.recommendation?.framework?.structure);
}

export function buildScriptPrompt(
  input: ScriptGeneratorInput,
): { systemPrompt: string; userPrompt: string } {
  const library = input.libraryRevision;
  const candidates = briefCandidatePoints(input);
  const titleContext = buildScriptTitleContext(library, input.knowledgeContext);
  const requiredIds = new Set(input.brief.requiredPointIds);
  const budget = buildScriptDurationBudget(input.targetDurationSec);
  // 已确认提炼表达（R4）：只有全部来源事实都在当前方向包内的表达才进入提示词，
  // 且附带完整来源事实 ID——模型能看到该表达的全部支持事实与证据边界。
  const expressions = eligibleDistilledExpressions(input);
  const expressionForPoint = (pointId: string): DistilledExpressionRef | undefined =>
    expressions.find((ref) => ref.sourceFactIds.includes(pointId));
  const requirements = [
    '只能使用上面方向卖点包中的事实，priority=required 的卖点必须优先考虑；不得新增功效、数字、材质或认证',
    'sellingPoints 中的 distilled 字段是已确认的提炼表达参考（短句/用户价值/范围/限定条件），可参考其措辞，但它不是新的事实来源；口播中的事实仍须挂在对应的 sellingPoints 引用上，范围与限定条件不得扩大',
    '同系列卖点中的型号、颜色、配置及功能适用限定必须保留，不得把某款专属功能说成全系列标配，也不得把互斥配置拼成同一款商品',
    '完整返回主标题、副标题、分段口播、画面意图与关键词',
    // 软时长目标（方案 §2.3）：字数预算仅作参考，完整表达与 CTA 优先，不再机械卡字数。
    input.plan.painSolving ? '15秒口播目标55–70字，结果式结尾，不为补字添加卖点。' : `口播围绕目标时长 ${input.targetDurationSec} 秒组织；字数预算 ${budget.minContentCharacters}-${budget.maxContentCharacters} 字仅作参考，完整表达与 CTA 优先，可为一句完整 CTA 适当超出；不得为凑字数重复卖点或追加无关内容`,
    '同一轮多条方案必须在开场、结构或卖点组合上明显不同',
    ...(input.audienceSegment ? [
      '口播必须说给 audienceProfile 里的人听：开场先落在画像的 scenario 或 pains 上再引出卖点；至少一个分段只讲场景或痛点、不引用任何卖点，禁止从头到尾逐条念卖点',
      '每个被引用的卖点都必须能对应到画像的某个痛点或决策驱动；与画像无关的卖点宁可不写',
      '不得使用 audienceProfile.rejections 中的表述',
    ] : []),
    ...(input.plan.painSolving ? painWritingRequirements(input.plan.painSolving) : scriptCtaRequirements(endingSceneForPlan(input.plan))),
    ...scriptTitleRequirements(),
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
        displayName: titleContext.displayName,
        modelKeysForMatchingOnly: titleContext.modelKeys,
        category: library.category || '',
        brand: library.brand || '',
      },
      searchContext: { terms: titleContext.searchTerms, usage: '独立搜索话题，不作为标题或事实证据' },
      previousScripts: input.previousScripts,
      previousTitles: input.previousTitles || [],
      audience: input.audience,
      ...(input.audienceSegment ? {
        audienceProfile: {
          segment: input.audienceSegment.segment,
          scenario: input.audienceSegment.scenario,
          pains: input.audienceSegment.pains,
          decisionDrivers: input.audienceSegment.decisionDrivers,
          rejections: input.audienceSegment.rejections,
        },
      } : {}),
      tone: input.tone,
      platform: input.platform,
      creativeBrief: input.creativeBrief,
      direction: input.plan.angle,
      ...(input.plan.painSolving ? { painSolving: input.plan.painSolving, beats: PAIN_PATHS[input.plan.painSolving.path].beats } : {}),
      ...(input.brief?.themeTitle ? { theme: input.brief.themeTitle } : {}),
      template: templateBlock,
      ...(recommendationBlock ? { recommendation: recommendationBlock } : {}),
      sellingPoints: candidates.map((point) => {
        const expression = expressionForPoint(point.id);
        return {
          id: point.id,
          title: point.title,
          factText: point.factText,
          ...(point.detailStatus === 'verified' ? { detail: point.detailText } : {}),
          pointType: point.pointType,
          evidenceQuote: point.evidenceQuote,
          priority: requiredIds.has(point.id) ? 'required' : 'optional',
          ...(expression ? {
            distilled: {
              shortCopy: expression.shortCopy,
              benefitText: expression.benefitText,
              scope: expression.scope,
              limitations: expression.limitations,
              sourceFactIds: expression.sourceFactIds,
              usage: '表达参考，不是新的事实来源；sourceFactIds 是该表达的全部来源事实',
            },
          } : {}),
        };
      }),
      targetDurationSec: input.targetDurationSec,
      output: {
        title: 'string；4-16 字，具体卖点或场景',
        coverTitleParts: {
          primary: 'string；4-12 字，可用展示商品名称或本方案核心卖点',
          secondary: 'string；4-10 字，本方案具体卖点、场景或购买理由',
        },
        direction: 'string；20 字以内的切入角度摘要',
        segments: [{
          narration: input.plan.painSolving ? 'string；自然口播，以使用结果或购买判断收尾' : 'string；带自然标点的口播；最后一段的最后一句必须是 CTA 行动引导',
          sellingPointIdRefs: [input.plan.painSolving ? '只引用 sellingPoints.id；纯场景段可为空' : 'string；只引用 sellingPoints.id；纯行动引导的 CTA 段可返回空数组'],
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

/** 只请求不合格标题，正文与证据作为只读上下文；响应由服务端字段白名单应用。 */
export function buildScriptTitleRepairPrompt(input: ScriptTitleRepairInput): { systemPrompt: string; userPrompt: string } {
  const referenced = new Set(input.content.segments.flatMap((segment) => segment.sellingPointIdRefs));
  return {
    systemPrompt: '你是电商短视频标题编辑。只返回包含待修复标题字段的 JSON 对象。正文、字幕、卖点引用和时长已经确定，禁止修改。',
    userPrompt: JSON.stringify({
      task: 'repair_project_script_titles_v1',
      product: buildScriptTitleContext(input.libraryRevision, input.knowledgeContext),
      direction: input.plan.angle,
      ...(input.plan.painSolving ? { painSolving: input.plan.painSolving, beats: PAIN_PATHS[input.plan.painSolving.path].beats } : {}),
      audience: input.audience,
      platform: input.platform,
      tone: input.tone,
      currentTitles: { title: input.content.title, coverTitleParts: input.content.coverTitleParts },
      fieldsToRepair: [...new Set(input.titleIssues.map((issue) => issue.field))],
      issues: input.titleIssues,
      previousTitles: [...input.previousScripts.map(({ title, coverTitleParts }) => ({ title, coverTitleParts })), ...(input.previousTitles || [])],
      readonlyFullScript: input.content.fullScript,
      verifiedFacts: briefCandidatePoints(input).filter((point) => referenced.has(point.id))
        .map((point) => ({ id: point.id, factText: point.factText, evidenceQuote: point.evidenceQuote })),
      requirements: scriptTitleRequirements({ requireCoverHook: Boolean(input.content.templateRewrite) }),
      output: { title: '仅在需要修复时返回', coverTitleParts: { primary: '仅在需要修复时返回', secondary: '仅在需要修复时返回' } },
    }),
  };
}

/**
 * 语义审核提示词（方案 §4.2 / 审查 R2 / v3）：只读复核，不改写内容。
 * 覆盖本地初筛拦不住的问题：陈述式「了解」、无证据功效、CTA 后追加内容、主题断裂；
 * 渠道虚构由本地确定性检查拦截，不在审核范围（v3）。
 */
export function buildScriptEndingReviewPrompt(input: ScriptEndingReviewInput): { systemPrompt: string; userPrompt: string } {
  if (input.plan.painSolving) return {
    systemPrompt: '你是痛点解决型短视频审核员。只依据已核验事实审阅，不能把策划假设当事实。只返回 JSON，不改写。',
    userPrompt: JSON.stringify({
      task: 'review_pain_solving_v1',
      opportunity: input.plan.painSolving,
      peerOpportunities: input.peerPainOpportunities ?? [],
      content: { title: input.content.title, coverTitleParts: input.content.coverTitleParts, segments: input.content.segments },
      verifiedFacts: briefCandidatePoints(input).map((p) => ({ id: p.id, factText: p.factText, evidenceQuote: p.evidenceQuote })),
      requirements: [
        'factsSupported：所有正文、作用、利益与原因解释均有 verifiedFacts 支持；引用 ID 不等于功效已证明，不能从材料推导失眠改善等效果。',
        'singleProblem：全文只解决命题的一个核心问题。audienceFit：人群通过具体场景或需求影响内容，非硬塞标签。productAnchor：至少有一个来自本产品的具体特征，不要求竞品绝不具备。',
        'focusedSellingPoints：只讲一个主卖点和最多一个辅助卖点，不把多个独立功能打包伪装一个。closedLoop：按对应子路径推进，结尾以使用结果或购买判断回应开头，禁止强转化；两难必须真实、两种利益都有依据；原因诊断不能断言病因。',
        'naturalLanguage：自然分享购买判断，无主播腔、参数堆砌、万能话术或虚构亲测。',
        'batchDiversity：与每个 peerOpportunities 比较，核心痛点、主卖点、子路径至少两项实质不同；同义改写不算不同。',
        'titleAligned：有效标题与正文同一内容命题；缺失或长度不合规的标题由后续标题修复处理，不因格式拒绝正文。',
        '每项 checks 必须为布尔值。只有全部通过且 issues 为空数组才可 pass=true；失败给出具体语句和中文原因。',
      ],
      output: { pass: 'boolean', issues: ['具体中文原因'], checks: Object.fromEntries(PAIN_REVIEW_CHECKS.map((name) => [name, 'boolean'])) },
    }),
  };
  // 提供方向包内全部可用事实（不只被引用的）：审核要判断「正文表述是否受支持」，
  // 需要知道完整的事实边界，而不是只看已引用的。
  const verifiedFacts = briefCandidatePoints(input)
    .map((point) => ({ id: point.id, factText: point.factText, evidenceQuote: point.evidenceQuote }));
  return {
    systemPrompt: '你是电商短视频口播审核员。只返回一个 JSON 对象（pass + issues + checks），不输出解释，不改正文。',
    userPrompt: JSON.stringify({
      task: 'review_project_script_ending_v1',
      direction: input.plan.angle,
      ...(input.brief?.themeTitle ? { theme: input.brief.themeTitle } : {}),
      fullScript: input.content.fullScript,
      segments: input.content.segments.map((segment) => ({
        narration: segment.narration,
        sellingPointIdRefs: segment.sellingPointIdRefs,
      })),
      verifiedFacts,
      requirements: [
        '逐项检查并给出 checks：actionInvitation（最后一句是否为明确的行动邀请——「点击下方链接订购吧」「点击下方链接，把它带回家」「想了解这款，就比较这些细节」这类引导语即为合格邀请；陈述句或纯情绪收束不算）、followsContext（CTA 是否承接正文的使用场景或购买理由，主题是否突然变化）、factsSupported（正文中的参数、材质、功效、认证表述是否受 verifiedFacts 支持，无支持即不通过）、noContentAfterCta（CTA 之后是否又罗列卖点/规格/颜色）',
        '渠道合规由本地确定性检查负责（未确认促销/渠道词已在生成前拦截，链接落版是默认确认渠道），不属于审核范围；不要因为 CTA 点名或不点名某个渠道而拒绝',
        '任何一项不通过则 pass=false，并在 issues 中给出具体中文原因（指出哪个词/哪一句不受支持）',
        'pass 与 checks 必须一致：pass=true 时四项 checks 必须全部为 true 且 issues 为空数组；任何一项为 false 时 pass 必须为 false（自相矛盾的响应会被服务端整体拒绝）',
        '只依据 verifiedFacts 判断事实支持，不要凭常识脑补产品能力',
      ],
      output: {
        pass: 'boolean',
        issues: ['string；pass=false 时必填，具体原因'],
        checks: {
          actionInvitation: 'boolean',
          followsContext: 'boolean',
          factsSupported: 'boolean',
          noContentAfterCta: 'boolean',
        },
      },
    }),
  };
}

/**
 * 受约束正文修复提示词（方案 §2.1）：
 * 围绕既有段落与已选卖点改写，以自然 CTA 收尾；只为修复列出的质量问题，
 * 不为补字强塞新颜色、材质、参数或认证，不把证据解释文本直接念给观众听。
 */
export function buildScriptBodyRepairPrompt(input: ScriptBodyRepairInput): { systemPrompt: string; userPrompt: string } {
  const candidates = briefCandidatePoints(input);
  const requiredIds = new Set(input.brief.requiredPointIds);
  const budget = buildScriptDurationBudget(input.targetDurationSec);
  const requirements = [
    '只能围绕既有分段与方向卖点包内事实改写；不得新增未提供的功效、数字、材质或认证',
    '保留原有分段中已合格的表达与卖点引用，只修复列出的质量问题；不要整篇重写',
    ...(input.plan.painSolving ? painWritingRequirements(input.plan.painSolving) : scriptCtaRequirements(endingSceneForPlan(input.plan))),
    input.plan.painSolving ? '15秒口播目标55–70字，结果式结尾，不为补字添加卖点。' : `口播围绕目标时长 ${input.targetDurationSec} 秒组织（字数参考 ${budget.minContentCharacters}-${budget.maxContentCharacters} 字）；完整表达与 CTA 优先，可为一句完整 CTA 适当超出，不得为凑字数重复卖点或追加无关内容`,
    '只返回 segments 数组；标题、封面、时长与知识来源由服务端保持冻结，不得返回',
  ];
  return {
    systemPrompt: '你是电商短视频口播编辑。只返回一个包含 segments 数组的 JSON 对象，不输出解释。不得修改标题与封面。',
    userPrompt: JSON.stringify({
      task: 'repair_project_script_body_v1',
      direction: input.plan.angle,
      ...(input.plan.painSolving ? { painSolving: input.plan.painSolving, beats: PAIN_PATHS[input.plan.painSolving.path].beats } : {}),
      ...(input.brief?.themeTitle ? { theme: input.brief.themeTitle } : {}),
      audience: input.audience,
      tone: input.tone,
      platform: input.platform,
      targetDurationSec: input.targetDurationSec,
      qualityIssues: input.qualityIssues,
      currentSegments: input.content.segments.map((segment) => ({
        narration: segment.narration,
        sellingPointIdRefs: segment.sellingPointIdRefs,
        visualIntent: segment.visualIntent,
        visualKeywords: segment.visualKeywords,
      })),
      fullScript: input.content.fullScript,
      sellingPoints: candidates.map((point) => ({
        id: point.id,
        title: point.title,
        factText: point.factText,
        ...(point.detailStatus === 'verified' ? { detail: point.detailText } : {}),
        evidenceQuote: point.evidenceQuote,
        priority: requiredIds.has(point.id) ? 'required' : 'optional',
      })),
      output: {
        segments: [{
          narration: input.plan.painSolving ? 'string；自然口播，以使用结果或购买判断收尾' : 'string；带自然标点的口播；最后一段的最后一句必须是 CTA 行动引导',
          sellingPointIdRefs: [input.plan.painSolving ? '只引用 sellingPoints.id；纯场景段可为空' : 'string；只引用 sellingPoints.id；纯行动引导的 CTA 段可返回空数组'],
          visualIntent: 'string；抽象画面意图',
          visualKeywords: ['string；具体可见画面关键词'],
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
  // 标题缺失交给标题修复，不为此重新生成已合格的正文。
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
    // 越界引用（方向卖点包外 / 其他修订或项目的 ID）fail closed：不再静默过滤后保留口播文本，
    // 「删除坏 ID」不能伪装合格——检测到即本轮失败，交由上层重试或修复（方案 §1.3 / A9）。
    const outOfPackageRef = sellingPointIdRefs.find((id) => !usableIds.has(id));
    if (outOfPackageRef) throw new Error(`generated_script_out_of_package_ref:${outOfPackageRef}`);
    segments.push({
      id: asString(segment.id) || `segment-${index + 1}`,
      narration,
      subtitle: normalizeAutomaticSubtitleText(narration),
      sellingPointIdRefs,
      sellingPointRefs: sellingPointIdRefs.map((id) => fallback.find((point) => point.id === id)?.title || ''),
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
  // 归一化只认当前卖点包内的 ID：模型返回包外 ID 一律不得进入脚本引用（检测到即抛错重试）。
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
    ...(input.plan.painSolving ? { productionMode: 'pain_solving_15s' as const, painSolving: input.plan.painSolving } : {}),
    title: asString(record.title),
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
          displayName: buildScriptTitleContext(input.libraryRevision, knowledgeContext).displayName,
          searchTerms: buildScriptTitleContext(input.libraryRevision, knowledgeContext).searchTerms,
          searchTermsUsed: embedding?.searchTermsUsed ?? [],
          sourceRows: strategy!.sourceRows ?? [],
        }
      : undefined,
    // 冻结本次生成实际使用的已确认提炼表达（R4）：与提示词同一 eligible 过滤结果，
    // 来源库修订由 libraryRevisionId 冻结；部分来源在方向包外的表达不进入快照。
    ...(eligibleDistilledExpressions(input).length ? {
      distilledContext: {
        ruleVersion: SELLING_POINT_DISTILL_RULE_VERSION,
        pointIds: eligibleDistilledExpressions(input).map((ref) => ref.id),
      },
    } : {}),
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
 * 应用受约束正文修复（方案 §2.1 / A6）：
 * 响应只接收 segments 的正文相关白名单字段；标题、封面、目标时长、方向、模板、
 * 商品身份与知识来源快照保持冻结。全文、字幕、引用、卖点使用状态、字数与时长
 * 全部由服务端重新计算。
 */
export function applyScriptBodyRepair(
  raw: unknown,
  content: ScriptStudioScriptContent,
  input: ScriptGeneratorInput,
): ScriptStudioScriptContent {
  const record = asRecord(raw);
  const usable = briefCandidatePoints(input);
  const usableIds = new Set(usable.map((point) => point.id));
  const segments = parseSegments(record, usableIds, usable);
  const fullScript = segments.map((segment) => segment.narration).join('\n');
  const contentCharacterCount = countScriptContentCharacters(fullScript);
  const budget = buildScriptDurationBudget(input.targetDurationSec);
  const estimatedNarrationDurationSec = estimateNarrationDurationSec(contentCharacterCount);
  const usedIds = new Set(segments.flatMap((segment) => segment.sellingPointIdRefs));
  return {
    ...content,
    segments,
    fullScript,
    fullSubtitle: segments.map((segment) => segment.subtitle).join('\n'),
    contentCharacterCount,
    estimatedNarrationDurationSec,
    durationStatus: contentCharacterCount < budget.minContentCharacters
      ? 'too_short'
      : contentCharacterCount > budget.maxContentCharacters ? 'too_long' : 'qualified',
    sellingPointUsage: usable.map((point) => {
      const existing = content.sellingPointUsage.find((usage) => usage.sellingPointId === point.id);
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

export interface CreateScriptGeneratorOptions {
  maxTokens?: number;
  /** 调用前原子占用请求预算（方案 §2.2）；生产路径必传，测试替身可不传。 */
  budget?: ScriptRequestBudget;
}

export function createScriptGenerator(
  completeJson: ScriptStudioCompleteJson,
  provider: { id: string; model: string },
  options: CreateScriptGeneratorOptions = {},
): ScriptGenerator {
  const reserve = (input: { plan: { index: number } }, purpose: ScriptRequestPurpose): void => {
    options.budget?.reserve({ planIndex: input.plan.index, purpose });
  };
  return {
    async repairTitles(input) {
      reserve(input, 'title_repair');
      const prompt = buildScriptTitleRepairPrompt(input);
      return completeJson({ ...prompt, temperature: 1, maxTokens: SCRIPT_TITLE_REPAIR_MAX_TOKENS, signal: input.signal });
    },
    async repairScriptContent(input) {
      reserve(input, 'repair');
      const prompt = buildScriptBodyRepairPrompt(input);
      return completeJson({
        systemPrompt: prompt.systemPrompt,
        userPrompt: prompt.userPrompt,
        temperature: 1,
        maxTokens: options.maxTokens ?? 8000,
        signal: input.signal,
      });
    },
    async reviewScriptContent(input) {
      reserve(input, 'review');
      const prompt = buildScriptEndingReviewPrompt(input);
      return completeJson({
        systemPrompt: prompt.systemPrompt,
        userPrompt: prompt.userPrompt,
        temperature: 1,
        maxTokens: SCRIPT_TITLE_REPAIR_MAX_TOKENS,
        signal: input.signal,
      });
    },
    async planPainOpportunities(input) {
      return completeJson({ ...buildPainPlanningPrompt(input), temperature: 1,
        maxTokens: options.maxTokens ?? PAIN_PLANNING_MAX_TOKENS, signal: input.signal });
    },
    async analyzeAudienceProfile(input) {
      // 预算由 runner 在 plan 阶段统一占用（plan_analysis 独立阶段额度），这里只发请求。
      const prompt = buildAudienceAnalysisPrompt(input);
      return completeJson({
        systemPrompt: prompt.systemPrompt,
        userPrompt: prompt.userPrompt,
        temperature: 1,
        maxTokens: 2400,
        signal: input.signal,
      });
    },
    // ------------------------------------------------------------------
    // 爆文模板改写（迁移方案 §4.4）：筛选 → 风格 → 首稿 → 字数修正 → 去 AI 味 →
    // 朗读检查 → 终检 → 残留检查 → 修改说明。与源码的三处有意差异：
    // 字数修正带当前稿件、修正保留 TPL_GEN_HINT 原约束、终检修正用冻结白名单。
    // ------------------------------------------------------------------
    async runTemplateRewrite(input) {
      const template = input.plan.templateRewrite;
      if (!template) throw new Error('template_rewrite_plan_template_required');
      if (!input.eligiblePoints.length) throw new Error('template_rewrite_eligible_points_required');
      const signal = input.signal;
      const assertNotAborted = (error: unknown): void => {
        if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
      };
      const state: TemplateRewriteResumeState = { ...(input.resumeState ?? {}) };
      const emit = (): void => input.onStateChange?.({ ...state });
      const eligible = input.eligiblePoints;
      const reserve = (purpose: ScriptRequestPurpose): void => {
        options.budget?.reserve({ planIndex: input.plan.index, purpose });
      };
      const formatSellingPoint = (point: SellingPointRecord): string => {
        // 免责口径（仅供参考/以实际为准等）不是口播素材，进 prompt 前剥除（sanitizeSellingPointText）。
        const title = sanitizeSellingPointText(point.title);
        const detail = sanitizeSellingPointText(point.detailText || '');
        return detail && detail !== title ? `${title}（${detail}）` : title;
      };

      // 1. 按模板筛选卖点（迁移 filterTplSellingPoints；稳定组 ID；降级保留全部合格卖点）
      if (!state.whitelistPointIds?.length) {
        const allIds = eligible.map((point) => point.id);
        if (eligible.length < 2) {
          state.whitelistPointIds = allIds;
          state.filterDegraded = '';
        } else if (template.refText.trim().length < 20) {
          state.whitelistPointIds = allIds;
          state.filterDegraded = '参考文案过短，按源规则跳过筛选，使用全部合格卖点';
        } else {
          try {
            reserve('filter');
            const candidates = eligible.map((point, index) => ({ id: String(index + 1), text: formatSellingPoint(point) }));
            const raw = await completeJson({
              ...buildFilterRequest({ refSnippet: template.refText.slice(0, 600), candidates }),
              temperature: 1,
              signal,
            });
            const keep = parseFilterKeep(raw, candidates.map((candidate) => candidate.id));
            if (!keep || keep.length === 0) {
              state.whitelistPointIds = allIds;
              state.filterDegraded = '筛选无有效结果，保留全部合格卖点';
            } else {
              state.whitelistPointIds = keep.map((id) => eligible[Number(id) - 1]!.id);
              state.filterDegraded = '';
            }
          } catch (error) {
            assertNotAborted(error);
            state.whitelistPointIds = allIds;
            state.filterDegraded = `筛选失败，保留全部合格卖点：${error instanceof Error ? error.message : String(error)}`;
          }
        }
        emit();
      }
      const whitelist = state.whitelistPointIds!;
      const whitelistPoints = eligible.filter((point) => whitelist.includes(point.id));
      if (!whitelistPoints.length) throw new Error('template_rewrite_whitelist_empty');
      const spTexts = whitelistPoints.map(formatSellingPoint);

      // 2. 文风预设（本地检测）+ 参考全文风格分析（缓存/降级，迁移 analyzeStyle）
      const presetKey = detectTemplateStyle({
        title: template.title,
        name: template.name,
        refText: template.refText,
        structSummary: template.structure,
        subCategory: template.subCategory,
        category: template.category,
      });
      const preset = TPL_STYLE_PRESETS[presetKey];
      state.stylePresetKey = presetKey;
      state.stylePresetName = preset.name;
      if (state.styleAnalysis === undefined) {
        if (template.refText.trim().length < 20) {
          state.styleAnalysis = null;
          state.styleDegraded = '参考文案过短，按源规则跳过风格分析，使用文风预设';
        } else {
          try {
            reserve('style');
            const raw = await completeJson({ ...buildStyleAnalysisRequest(template.refText), temperature: 1, signal });
            const analysis = parseStyleAnalysis(raw);
            state.styleAnalysis = analysis;
            state.styleDegraded = analysis ? '' : '风格分析结果非法，使用文风预设继续';
          } catch (error) {
            assertNotAborted(error);
            state.styleAnalysis = null;
            state.styleDegraded = `风格分析失败，使用文风预设继续：${error instanceof Error ? error.message : String(error)}`;
          }
        }
        emit();
      }
      const styleGuide = styleGuideFromAnalysis(state.styleAnalysis ?? null, template.refText);

      // 3. 首稿（≤2 次尝试；refs 越界/结构非法本轮失败重试）
      const targetChars = targetCharsForDuration(input.targetDurationSec);
      const { min, max } = charBoundsForTarget(targetChars);
      const draftBase = {
        sellingPointTexts: spTexts,
        refText: template.refText,
        structure: template.structure,
        styleGuide,
        stylePresetGuide: preset.guide,
        stylePresetNeg: preset.neg,
        targetChars,
        previousTitles: input.previousTitles.map((item) => item.title || '').filter(Boolean),
        previousVariants: input.siblingVariantTexts ?? [],
      };
      type Draft = {
        title: string;
        coverTitleParts: { primary: string; secondary: string };
        segments: Array<{ label: string; text: string; pointIds: string[] }>;
        note: string;
      };
      const toDraft = (parsed: NonNullable<ReturnType<typeof parseDraftResponse>>): Draft => ({
        title: parsed.title,
        coverTitleParts: parsed.coverTitleParts,
        segments: parsed.segments.map((seg) => ({
          label: seg.label,
          text: seg.text,
          pointIds: seg.refs.map((ref) => {
            const point = whitelistPoints[Number(ref) - 1];
            if (!point) throw new Error(`generated_script_out_of_package_ref:${ref}`);
            return point.id;
          }),
        })),
        note: parsed.note,
      });
      const draftTextOf = (draft: Draft): string =>
        `标题：${draft.title}\n封面主标题：${draft.coverTitleParts.primary}\n封面副标题：${draft.coverTitleParts.secondary}\n` + draft.segments.map((seg) => `【${seg.label}】${seg.text}`).join('\n');
      const requestDraft = async (purpose: ScriptRequestPurpose, extra: { fixHint?: string; currentDraft?: string }): Promise<Draft> => {
        reserve(purpose);
        const raw = await completeJson({
          ...buildDraftRequest({ ...draftBase, ...extra }),
          temperature: 1,
          maxTokens: 3000,
          signal,
        });
        const parsed = parseDraftResponse(raw);
        if (!parsed) throw new Error('template_rewrite_draft_invalid_output');
        return toDraft(parsed);
      };
      let draft: Draft | undefined;
      let lastDraftError: unknown;
      for (let attempt = 1; attempt <= 2 && !draft; attempt += 1) {
        try {
          draft = await requestDraft('generate', {});
        } catch (error) {
          assertNotAborted(error);
          if (error instanceof ScriptStudioError && error.code === 'request_budget_exhausted') throw error;
          lastDraftError = error;
        }
      }
      if (!draft) throw lastDraftError instanceof Error ? lastDraftError : new Error('template_rewrite_draft_failed');

      const warnings: Array<{ code: string; message: string }> = [];
      const cnOf = (value: Draft): number => scriptCnLen(value.title, value.segments.map((seg) => ({ narration: seg.text })));
      const fixHintFor = (n: number): string =>
        '当前约' + n + '字，目标约' + targetChars + '字（范围 ' + min + '~' + max + ' 字），请' + (n > max ? '精简' : '扩写')
        + '到目标范围。只调整篇幅，保留全部卖点和【段名】结构，不要新增或删减卖点。';
      // 字数修正（首稿后 / 终检后各最多 1 次；带当前稿与原约束；预算不足跳过并如实记录）
      const fixLengthIfNeeded = async (current: Draft): Promise<Draft> => {
        const n = cnOf(current);
        if (n >= min && n <= max) return current;
        try {
          return await requestDraft('repair', { fixHint: fixHintFor(n), currentDraft: draftTextOf(current) });
        } catch (error) {
          assertNotAborted(error);
          warnings.push({
            code: 'template_length_fix_skipped',
            message: `字数 ${n} 超出目标 ${targetChars}（±15%），字数修正未生效：${error instanceof Error ? error.message : String(error)}`,
          });
          return current;
        }
      };
      draft = await fixLengthIfNeeded(draft);

      // 4. 去 AI 味（可选润色；失败/预算不足保留上一有效稿并记录降级；守卫：段结构不变才接受）
      let humanizeDegraded = '';
      try {
        reserve('polish');
        const raw = await completeJson({
          ...buildHumanizeRequest(draft.segments.map((seg) => `【${seg.label}】${seg.text}`).join('\n')),
          temperature: 1,
          signal,
        });
        const text = parsePolishedText(raw);
        if (text) {
          const reparsed = parseSegmentedText(text);
          const noted = extractScriptNote(reparsed.segments);
          if (noted.segments.length === draft.segments.length) {
            draft = {
              ...draft,
              segments: noted.segments.map((seg, index) => ({ label: seg.label, text: seg.text, pointIds: draft!.segments[index]!.pointIds })),
              note: [draft.note, noted.note].filter(Boolean).join('\n'),
            };
          } else {
            humanizeDegraded = '去 AI 味改变了段落结构，保留原稿';
          }
        } else {
          humanizeDegraded = '去 AI 味返回格式非法，保留原稿';
        }
      } catch (error) {
        assertNotAborted(error);
        humanizeDegraded = `去 AI 味未生效，保留原稿：${error instanceof Error ? error.message : String(error)}`;
      }

      // 5. 朗读流畅检查（可选润色；源码守卫：总长度变化 >300 字丢弃）
      let smoothDegraded = '';
      try {
        reserve('polish');
        const raw = await completeJson({
          ...buildSmoothCheckRequest(draft.segments.map((seg) => `【${seg.label}】${seg.text}`).join('\n')),
          temperature: 1,
          signal,
        });
        const text = parsePolishedText(raw);
        if (text) {
          const reparsed = parseSegmentedText(text);
          const noted = extractScriptNote(reparsed.segments);
          const oldLen = draft.segments.reduce((sum, seg) => sum + seg.text.length, 0);
          const newLen = noted.segments.reduce((sum, seg) => sum + seg.text.length, 0);
          if (noted.segments.length === draft.segments.length && Math.abs(newLen - oldLen) <= 300) {
            draft = {
              ...draft,
              segments: noted.segments.map((seg, index) => ({ label: seg.label, text: seg.text, pointIds: draft!.segments[index]!.pointIds })),
              note: [draft.note, noted.note].filter(Boolean).join('\n'),
            };
          } else {
            smoothDegraded = '朗读检查改动过大，保留原稿';
          }
        } else {
          smoothDegraded = '朗读检查返回格式非法，保留原稿';
        }
      } catch (error) {
        assertNotAborted(error);
        smoothDegraded = `朗读检查未生效，保留原稿：${error instanceof Error ? error.message : String(error)}`;
      }

      // 6. 终检字数（润色可能微调篇幅；超限再修一次，仍用冻结白名单与原约束）
      draft = await fixLengthIfNeeded(draft);

      // 6.5 结尾检查：爆文模板以逼单/CTA 收尾，缺失时定向修复一次（预算不足或仍缺失记降级，不阻断）。
      if (templateEndingMissing(draft.segments)) {
        const closing = refClosingExcerpt(template.refText);
        try {
          const fixed = await requestDraft('repair', {
            fixHint: '当前稿件缺少结尾段（没有行动引导收尾）。参考文案的结尾是："' + closing + '"——请补一个模仿它句式、语气和收束节奏的结尾（换成本家卖点说法，不得照抄原句），保留现有段落与【段名】结构，其他段落不要改动。',
            currentDraft: draftTextOf(draft),
          });
          if (!templateEndingMissing(fixed.segments)) {
            draft = fixed;
          } else {
            warnings.push({ code: 'template_ending_still_missing', message: '缺少行动引导结尾，结尾修复后仍缺失，保留当前稿件' });
          }
        } catch (error) {
          assertNotAborted(error);
          warnings.push({
            code: 'template_ending_fix_skipped',
            message: `缺少行动引导结尾，结尾修复未生效：${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }

      // 7. 参考产品信息残留检查（必需校验）：连续成句照抄 → 定向修复；仍残留/无余额则本模板失败
      const residualRuns = findResidualRuns(template.refText, draft.segments.map((seg) => seg.text).join('\n'));
      if (residualRuns.length > 0) {
        const fixed = await requestDraft('repair', {
          fixHint: `正文中「${residualRuns[0]!.slice(0, 30)}」等句子与参考文案逐字相同（参考产品信息残留），必须改写成本家产品说法，不得照抄参考成句。`,
          currentDraft: draftTextOf(draft),
        });
        const stillResidual = findResidualRuns(template.refText, fixed.segments.map((seg) => seg.text).join('\n'));
        if (stillResidual.length > 0) {
          throw new Error(`template_rewrite_residual_reference_text:${stillResidual[0]!.slice(0, 20)}`);
        }
        draft = fixed;
      }

      // 8. 修改说明：首稿/修复稿 note 优先；缺失且预算有余才补生成（迁移 ensureTplNote）
      let note = state.note ?? draft.note ?? '';
      let noteMissing = false;
      if (!note) {
        try {
          reserve('note');
          const raw = await completeJson({
            ...buildEnsureNoteRequest({
              refText: template.refText,
              body: draft.segments.map((seg) => `【${seg.label}】${seg.text}`).join('\n'),
              sellingPointText: spTexts.join('\n'),
            }),
            temperature: 1,
            signal,
          });
          const record = asRecord(raw);
          note = (typeof record.note === 'string' ? record.note : '').trim().replace(/^【?修改说明】?[：:]?\s*/, '').trim();
        } catch (error) {
          assertNotAborted(error);
        }
        if (note) {
          state.note = note;
          emit();
        } else {
          noteMissing = true;
        }
      } else if (state.note === undefined) {
        state.note = note;
        emit();
      }

      // 9. 组装脚本内容（下游 reader 契约：version 4 + segments 非空；修改说明不进 segments）
      const segments: ScriptStudioSegmentContent[] = draft.segments.map((seg, index) => ({
        id: `segment-${index + 1}`,
        narration: seg.text,
        subtitle: normalizeAutomaticSubtitleText(seg.text),
        sellingPointIdRefs: seg.pointIds,
        sellingPointRefs: seg.pointIds.map((id) => whitelistPoints.find((point) => point.id === id)?.title || ''),
        visualIntent: '',
        visualKeywords: [],
      }));
      const usedIds = new Set(segments.flatMap((segment) => segment.sellingPointIdRefs));
      const fullScript = segments.map((segment) => segment.narration).join('\n');
      const contentCharacterCount = countScriptContentCharacters(fullScript);
      const budget = buildScriptDurationBudget(input.targetDurationSec);
      const estimatedNarrationDurationSec = estimateNarrationDurationSec(contentCharacterCount);
      const content: ScriptStudioScriptContent = {
        version: 4,
        productionMode: 'template_rewrite',
        templateRewrite: {
          version: TEMPLATE_REWRITE_VERSION,
          entryId: template.entryId,
          revisionId: template.revisionId,
          sourceTemplateId: template.sourceTemplateId,
          templateName: template.name,
          templateTitle: template.title,
          category: template.category,
          subCategory: template.subCategory,
          refText: template.refText,
          structure: template.structure,
          structureOrigin: template.structureOrigin,
          contentHash: template.contentHash,
          stylePresetKey: state.stylePresetKey ?? presetKey,
          stylePresetName: state.stylePresetName ?? preset.name,
          styleAnalysis: (state.styleAnalysis ?? null) as Record<string, unknown> | null,
          styleDegraded: state.styleDegraded ?? '',
          whitelistPointIds: whitelist,
          filterDegraded: state.filterDegraded ?? '',
          targetChars,
          note,
          noteMissing,
          humanizeDegraded,
          smoothDegraded,
        },
        title: draft.title,
        coverTitleParts: {
          ...draft.coverTitleParts,
          source: 'model',
        },
        platform: '淘宝逛逛',
        tone: state.stylePresetName ?? preset.name,
        templateId: `viral:${template.sourceTemplateId}`,
        template: template.name || template.title || template.sourceTemplateId,
        templateVersion: 1,
        templateRationale: template.name || template.title,
        shotSetId: '',
        targetDurationSec: input.targetDurationSec,
        targetNarrationDurationSec: budget.targetNarrationSec,
        contentCharacterCount,
        estimatedNarrationDurationSec,
        durationStatus: contentCharacterCount < budget.minContentCharacters
          ? 'too_short'
          : contentCharacterCount > budget.maxContentCharacters ? 'too_long' : 'qualified',
        direction: '爆文模板改写',
        creativeBrief: '',
        libraryRevisionId: input.libraryRevision.id,
        sellingPointUsage: whitelistPoints.map((point) => ({
          sellingPointId: point.id,
          title: point.title,
          status: usedIds.has(point.id) ? 'used' as const : 'omitted' as const,
          reason: usedIds.has(point.id) ? '正文已引用' : '未写入正文',
        })),
        segments,
        fullScript,
        fullSubtitle: segments.map((segment) => segment.subtitle).join('\n'),
        ...(warnings.length ? { warnings } : {}),
      };
      return { content, state };
    },
    async generate(input) {
      // 方向编排不可绕过：缺少 brief 直接失败，不得回退完整卖点库。
      if (!input.brief) throw new Error('script_generation_direction_brief_required');
      const prompt = buildScriptPrompt(input);
      let attempts = 0;
      let raw: unknown;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        reserve(input, 'generate');
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
