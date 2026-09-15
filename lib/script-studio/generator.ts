import { normalizeAutomaticSubtitleText } from '../subtitle-display.ts';
import { buildScriptDurationBudget, countScriptContentCharacters, estimateNarrationDurationSec } from '../script-duration-policy.ts';
import type { DirectionSellingPointBrief } from './direction-briefs.ts';
import type { LibraryRevisionView } from './libraries.ts';
import type { PlannedScript } from './planner.ts';
import type { ScriptStudioCompleteJson } from './llm-contract.ts';
import { isSellingPointEvidenceUsable } from './selling-point-normalize.ts';
import { embeddingRequirementText, checkTitleEmbedding } from './title-embedding.ts';
import { buildScriptTitleContext, scriptTitleRequirements, type ScriptTitleSummary, type ScriptTitleIssue } from './title-policy.ts';
import { SCRIPT_TITLE_REPAIR_MAX_TOKENS } from './limits.ts';
import type { ScriptRequestBudget, ScriptRequestPurpose } from './request-budget.ts';
import { ctaEndingSceneFromStructure, scriptCtaRequirements } from './cta-policy.ts';
import type { AudienceAnalysisInput, AudienceSegmentProfile } from './audience-profile.ts';
import { buildAudienceAnalysisPrompt } from './audience-profile.ts';
import type { FrozenKnowledgeContext } from './knowledge-context.ts';
import type { DistilledExpressionRef } from './distillation.ts';
import { SELLING_POINT_DISTILL_RULE_VERSION } from './distillation.ts';
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
    `口播围绕目标时长 ${input.targetDurationSec} 秒组织；字数预算 ${budget.minContentCharacters}-${budget.maxContentCharacters} 字仅作参考，完整表达与 CTA 优先，可为一句完整 CTA 适当超出；不得为凑字数重复卖点或追加无关内容`,
    '同一轮多条方案必须在开场、结构或卖点组合上明显不同',
    ...(input.audienceSegment ? [
      '口播必须说给 audienceProfile 里的人听：开场先落在画像的 scenario 或 pains 上再引出卖点；至少一个分段只讲场景或痛点、不引用任何卖点，禁止从头到尾逐条念卖点',
      '每个被引用的卖点都必须能对应到画像的某个痛点或决策驱动；与画像无关的卖点宁可不写',
      '不得使用 audienceProfile.rejections 中的表述',
    ] : []),
    ...scriptCtaRequirements(endingSceneForPlan(input.plan)),
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
      ...(input.brief?.themeTitle ? { theme: input.brief.themeTitle } : {}),
      template: templateBlock,
      ...(recommendationBlock ? { recommendation: recommendationBlock } : {}),
      sellingPoints: candidates.map((point) => {
        const expression = expressionForPoint(point.id);
        return {
          id: point.id,
          title: point.title,
          factText: point.factText,
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
          narration: 'string；带自然标点的口播；最后一段的最后一句必须是 CTA 行动引导',
          sellingPointIdRefs: ['string；只引用 sellingPoints.id；纯行动引导的 CTA 段可返回空数组'],
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
      requirements: scriptTitleRequirements(),
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
    ...scriptCtaRequirements(endingSceneForPlan(input.plan)),
    `口播围绕目标时长 ${input.targetDurationSec} 秒组织（字数参考 ${budget.minContentCharacters}-${budget.maxContentCharacters} 字）；完整表达与 CTA 优先，可为一句完整 CTA 适当超出，不得为凑字数重复卖点或追加无关内容`,
    '只返回 segments 数组；标题、封面、时长与知识来源由服务端保持冻结，不得返回',
  ];
  return {
    systemPrompt: '你是电商短视频口播编辑。只返回一个包含 segments 数组的 JSON 对象，不输出解释。不得修改标题与封面。',
    userPrompt: JSON.stringify({
      task: 'repair_project_script_body_v1',
      direction: input.plan.angle,
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
        evidenceQuote: point.evidenceQuote,
        priority: requiredIds.has(point.id) ? 'required' : 'optional',
      })),
      output: {
        segments: [{
          narration: 'string；带自然标点的口播；最后一段的最后一句必须是 CTA 行动引导',
          sellingPointIdRefs: ['string；只引用 sellingPoints.id；纯行动引导的 CTA 段可返回空数组'],
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
