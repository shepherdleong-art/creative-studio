/**
 * CTA 结尾策略（方案 §2.3 / §4.2，审查 R2 返工 2026-09-14）：
 * - 本地末句检查只做确定性拦截（fail closed）：末句提取、孤立标签、行动邀请初筛、
 *   渠道默认未确认、CTA 后不得追加内容；关键词命中不等于合格 CTA；
 * - 本地初筛通过后必须再经有界语义审核（模型）确认行动邀请、主题承接、渠道、
 *   事实支持与 CTA 后无附加内容；审核结果绑定正文指纹与来源修订；
 * - 单纯的情绪收束、产品标签（如「浓郁栗棕配色。」）或品牌口号不算 CTA；
 * - 没有已确认渠道时只允许「了解这款 / 比较这些细节」等可执行引导，
 *   不得虚构私信、链接、下单、领取优惠、到店试坐或库存紧张。
 */
import { createHash } from 'node:crypto';
import type { SellingPointRecord, ScriptStudioScriptContent } from './types.ts';

export const SCRIPT_CTA_POLICY_VERSION = 'cta-ending-v2';

/**
 * 渠道/促销词（默认全部未确认）：任务输入没有渠道确认字段前，
 * 出现任一即拦截——「私信领取五折优惠」这类未确认渠道的 CTA 不能通过。
 */
const UNCONFIRMED_CHANNEL_PATTERN = /(私信|商品链接|链接|下单|购买|入手|拍下|加购|领取|优惠|折扣|秒杀|到店|试坐|直播间|库存|限时|客服电话|客服咨询)/;

/**
 * 行动邀请结构（比关键词命中严格）：必须构成「邀请观众做某事」的句式。
 * 「这款沙发是我了解过的。」含「了解」但是陈述句，不命中任何结构。
 */
const INVITATION_FRAMES: RegExp[] = [
  /(?:想|要)[^。！？!?，,;；]{0,10}(?:了解|看看|试试|比较|挑选|咨询|去挑|去选)/,
  /就[从在][^。！？!?，,;；]{0,12}(?:开始|了解|看看)/,
  /(?:了解|看看|瞧瞧|试试|比较|挑选|咨询)[^。！？!?，,;；]{0,8}[这那哪]/,
  /点开[^。！？!?]{0,8}(?:看看|了解)/,
  /告诉(?:我|我们)/,
  /一起(?:挑|选|看看)/,
];

function normalizeForEndingCheck(value: string): string {
  return value.normalize('NFKC').replace(/[\s\p{P}]+/gu, '').toLowerCase();
}

/** 提取真正的最后一句：按句末标点切分，取最后一个非空句；无标点时整段为一句。 */
export function lastSentenceOf(narration: string): string {
  const sentences = narration
    .split(/[。！？!?]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  return sentences.at(-1) || narration.trim();
}

function isActionInvitation(sentence: string): boolean {
  return INVITATION_FRAMES.some((frame) => frame.test(sentence));
}

export interface ScriptEndingQualityResult {
  /** 阻断性质量问题码：ending_bare_selling_point / cta_ending_missing / cta_channel_unconfirmed。 */
  issues: string[];
  /** 末句（去空白标点）正好等于某个候选卖点标题。 */
  bareSellingPointId?: string;
  /** 命中的未确认渠道词（诊断用）。 */
  unconfirmedChannelTerm?: string;
}

export interface EndingCheckOptions {
  /**
   * 已确认的渠道（默认无）：在任务输入提供渠道确认前，私信/链接/下单/优惠等
   * 一律视为未确认（方案 §2.3 表格的使用条件）。
   */
  confirmedChannels?: string[];
}

/**
 * 本地末句质量检查（确定性部分，方案 §4.2 / 审查 R2）：
 * 1. 末句与某个候选卖点标题一致 → 孤立标签收尾；
 * 2. 末句含未确认渠道/促销词 → cta_channel_unconfirmed；
 * 3. 末句不构成行动邀请（含「CTA 后又追加标签」——此时末句是标签不是邀请）→ cta_ending_missing。
 * 通过本地检查不等于文案合格：仍须经语义审核（runner 中组合）。
 */
export function checkScriptEndingQuality(
  content: Pick<ScriptStudioScriptContent, 'segments'>,
  candidates: Array<Pick<SellingPointRecord, 'id' | 'title'>>,
  options: EndingCheckOptions = {},
): ScriptEndingQualityResult {
  const lastSegment = content.segments.at(-1);
  if (!lastSegment) return { issues: [] };
  const lastNarration = lastSegment.narration.trim();
  const lastSentence = lastSentenceOf(lastNarration);
  if (!lastSentence) return { issues: [] };
  const normalizedLast = normalizeForEndingCheck(lastSentence);
  // 「浓郁栗棕配色。」式孤立标签：末句与候选卖点标题一致即拦截。
  for (const candidate of candidates) {
    const normalizedTitle = normalizeForEndingCheck(candidate.title || '');
    if (normalizedTitle && normalizedLast === normalizedTitle) {
      return { issues: ['ending_bare_selling_point'], bareSellingPointId: candidate.id };
    }
  }
  // 渠道默认未确认：私信/链接/下单/领取优惠/到店等一律拦截，除非渠道被显式确认。
  const channelMatch = UNCONFIRMED_CHANNEL_PATTERN.exec(lastSentence);
  if (channelMatch && !(options.confirmedChannels || []).some((channel) => channel && lastSentence.includes(channel))) {
    return { issues: ['cta_channel_unconfirmed'], unconfirmedChannelTerm: channelMatch[0] };
  }
  // 末句必须构成行动邀请：「先了解这款沙发。浓郁栗棕配色。」的末句是标签，同样在此拦截。
  if (!isActionInvitation(lastSentence)) {
    return { issues: ['cta_ending_missing'] };
  }
  return { issues: [] };
}

/**
 * 生成/修复提示词中的 CTA 要求（方案 §2.3 / R2）。
 * endingScene 来自任务冻结的知识库框架末段（如「理想生活 / CTA」→「理想生活」）；
 * 缺少框架或未匹配模板时使用通用 CTA 规则。
 */
export function scriptCtaRequirements(endingScene: string | null): string[] {
  const requirements = [
    '最后一句口播必须是简洁、具体的 CTA（行动引导）：承接本条脚本的场景或购买理由，明确邀请观众接下来做什么（如了解这款、比较这些细节、按需求挑选）',
    'CTA 必须是邀请句式（想了解这款…/就从这款开始了解/点开看看这些…），不能只是陈述（如「这款沙发是我了解过的」）或纯情绪收束（如「把下班后的时间留给自己」）',
    'CTA 反例（不合格）：「把下班后的时间留给自己」（纯情绪收束，没有行动引导）；「浓郁栗棕配色。」（孤立产品标签）；品牌口号或价格暗示',
    '当前没有已确认的咨询/购买渠道：不得出现私信、商品链接、下单、领取优惠、折扣、到店试坐、库存紧张等渠道或促销表述；只使用「了解这款 / 比较这些细节」等可执行引导',
    'CTA 必须是全文最后一句，其后不得再追加任何卖点、规格、材质或颜色标签',
  ];
  if (endingScene) {
    requirements.push(`本方案知识库框架的结尾意图为「${endingScene}」：最后一句须承接该场景并邀请行动，不得丢掉结尾意图或替换成无关口号`);
  }
  return requirements;
}

/** 从适配后的框架结构中提取结尾场景（供 CTA 要求与修复提示引用）。 */
export function ctaEndingSceneFromStructure(structure: string[] | undefined | null): string | null {
  if (!structure || structure.length === 0) return null;
  const last = structure.at(-1)!;
  if (!/cta/i.test(last)) return null;
  const scene = last.replace(/[（(].*[）)]/g, '').replace(/\/?\s*cta\s*$/i, '').trim();
  return scene || null;
}

// ── 语义审核（有界，方案 §4.2 / 审查 R2）─────────────────────────────

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean)
    : [];
}

export interface ScriptEndingReviewVerdict {
  pass: boolean;
  issues: string[];
}

/** 语义审核的必需子检查（提示词与解析共用同一清单）。 */
export const SCRIPT_ENDING_REQUIRED_CHECKS = [
  'actionInvitation',
  'followsContext',
  'channelAppropriate',
  'factsSupported',
  'noContentAfterCta',
] as const;

/**
 * 解析语义审核响应（复审 S2 严格化）：fail closed——
 * - 五项必需子检查必须齐全且全部为布尔 true；
 * - 顶层 pass=true 与子检查/失败原因必须一致：任何子检查缺失或 false、或响应自带
 *   失败原因（issues 非空）时，一律拒绝通过（模型结构化输出自相矛盾不能变成通过状态）；
 * - 非对象、缺字段同样不通过；审核出错/超时不能默认通过（方案 §4.2 / A10）。
 */
export function parseScriptEndingReview(raw: unknown): ScriptEndingReviewVerdict {
  const record = asRecord(raw);
  const checks = asRecord(record.checks);
  const issues = asStringArray(record.issues);
  const failedChecks = SCRIPT_ENDING_REQUIRED_CHECKS.filter((key) => checks[key] !== true);
  if (record.pass === true && failedChecks.length === 0 && issues.length === 0) {
    return { pass: true, issues: [] };
  }
  const reasons = [
    ...issues,
    ...failedChecks.map((key) => `子检查未通过：${key}`),
  ];
  if (!reasons.length) reasons.push('语义审核未通过（模型未给出具体原因）');
  return { pass: false, issues: reasons.slice(0, 5) };
}

/** 审核绑定指纹：正文全文 + 来源库修订；正文变化（标题修复除外）后旧审核失效。 */
export function scriptReviewFingerprint(fullScript: string, libraryRevisionId: string): string {
  return createHash('sha256').update(fullScript).update('\n').update(libraryRevisionId).digest('hex');
}
