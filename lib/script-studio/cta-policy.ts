/**
 * CTA 结尾策略（方案 §2.3 / §4.2，审查 R2 返工 2026-09-14，v3 渠道调整 2026-09-15）：
 * - 本地末句检查只做确定性拦截（fail closed）：末句提取、孤立标签、行动邀请初筛、
 *   未确认促销/渠道词拦截、CTA 后不得追加内容；关键词命中不等于合格 CTA；
 * - 「点击下方链接」类引导语是默认确认渠道的标准落版（如「快点击下方链接订购吧」
 *   「点击下方链接，把它带回家」），不再视为未确认渠道；交易动词（下单/购买/订购等）
 *   必须与「链接」共现，单独出现仍按无渠道依托拦截；
 * - 私信/优惠/折扣/秒杀/到店/库存/限时/客服等促销或渠道承诺词默认未确认，一律拦截；
 * - 本地初筛通过后必须再经有界语义审核（模型）确认行动邀请、主题承接、
 *   事实支持与 CTA 后无附加内容；审核结果绑定正文指纹与来源修订；
 * - 渠道合规由本地确定性检查兜底，语义审核不再重复裁决（v3：避免审核模型
 *   把 channelAppropriate 反向解读成「必须点名渠道」而误杀合规落版）；
 * - 单纯的情绪收束、产品标签（如「浓郁栗棕配色。」）或品牌口号不算 CTA。
 */
import { createHash } from 'node:crypto';
import type { SellingPointRecord, ScriptStudioScriptContent } from './types.ts';

export const SCRIPT_CTA_POLICY_VERSION = 'cta-ending-v3';

/**
 * 未确认促销/渠道承诺词（默认全部未确认）：出现任一即拦截——
 * 「私信领取五折优惠」这类促销或渠道承诺不能通过。链接锚定的交易引导不在此列（见下）。
 */
const UNCONFIRMED_CHANNEL_PATTERN = /(私信|领取|优惠|折扣|秒杀|到店|试坐|直播间|库存|限时|客服电话|客服咨询)/;

/** 「链接」是默认确认渠道：末句含链接即视为有渠道依托。 */
const LINK_ANCHOR_PATTERN = /链接/;

/**
 * 交易动词仅在与「链接」共现时合法（如「点击下方链接订购吧」）；
 * 无链接锚定的交易承诺（如「快下单吧」）仍属虚构渠道行动，拦截。
 */
const LINK_ANCHORED_TRANSACTION_PATTERN = /(下单|购买|入手|拍下|加购|订购)/;

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
  // 链接落版：「快点击下方链接订购吧」「点击下方链接，把它带回家」「点击链接带它回家」。
  /点击(?:下方|下面)?[^。！？!?，,;；]{0,6}链接/,
  /把?它?带回家|带它回家/,
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
   * 额外显式确认的渠道/促销词（默认无）：「链接」已是默认确认渠道，无需在此列出；
   * 列出后可豁免对应的未确认促销/渠道承诺词（如平台大促期间确认「优惠」）。
   */
  confirmedChannels?: string[];
}

/**
 * 本地末句质量检查（确定性部分，方案 §4.2 / 审查 R2 / v3）：
 * 1. 末句与某个候选卖点标题一致 → 孤立标签收尾；
 * 2. 末句含未确认促销/渠道承诺词（私信/优惠/折扣/到店/库存等）→ cta_channel_unconfirmed；
 * 3. 末句含交易动词但无「链接」锚定 → cta_channel_unconfirmed；
 *    「点击下方链接」类落版是默认确认渠道，不拦截；
 * 4. 末句不构成行动邀请（含「CTA 后又追加标签」——此时末句是标签不是邀请）→ cta_ending_missing。
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
  // 促销/渠道承诺词默认未确认：私信/优惠/折扣/到店/库存等一律拦截，除非被显式确认。
  const confirmed = () =>
    (options.confirmedChannels || []).some((channel) => channel && lastSentence.includes(channel));
  const channelMatch = UNCONFIRMED_CHANNEL_PATTERN.exec(lastSentence);
  if (channelMatch && !confirmed()) {
    return { issues: ['cta_channel_unconfirmed'], unconfirmedChannelTerm: channelMatch[0] };
  }
  // 交易动词须有「链接」锚定：「点击下方链接订购吧」合法，「快下单吧」属虚构渠道行动。
  const transactionMatch = LINK_ANCHORED_TRANSACTION_PATTERN.exec(lastSentence);
  if (transactionMatch && !LINK_ANCHOR_PATTERN.test(lastSentence) && !confirmed()) {
    return { issues: ['cta_channel_unconfirmed'], unconfirmedChannelTerm: transactionMatch[0] };
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
    '最后一句口播必须是简洁、具体的 CTA（行动引导）：承接本条脚本的场景或购买理由，明确邀请观众接下来做什么',
    '结尾落版默认使用「点击下方链接」类行动引导，例如「快点击下方链接订购吧」「快点击下方链接看看吧」「点击下方链接，把它带回家」「还等什么，点击链接带它回家」；也可承接场景使用「了解这款 / 比较这些细节 / 按需求挑选」式引导',
    'CTA 必须是邀请句式（想了解这款…/就从这款开始了解/点击下方链接…），不能只是陈述（如「这款沙发是我了解过的」）或纯情绪收束（如「把下班后的时间留给自己」）',
    'CTA 反例（不合格）：「把下班后的时间留给自己」（纯情绪收束，没有行动引导）；「浓郁栗棕配色。」（孤立产品标签）；品牌口号或价格暗示',
    '「链接」是默认确认渠道，下单/订购/购买等交易动词必须与「链接」共现（如「点击下方链接订购吧」），不得出现无链接依托的「快下单吧」式行动承诺',
    '未确认促销/渠道表述一律不得出现：私信、领取、优惠、折扣、秒杀、到店试坐、直播间、库存紧张、限时、客服等',
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

/**
 * 语义审核的必需子检查（提示词与解析共用同一清单）。
 * v3：channelAppropriate 移出语义审核——渠道合规由本地确定性检查（促销词表 + 链接锚定）
 * 兜底，审核模型不再裁决，避免对合规链接落版的反向误杀。
 */
export const SCRIPT_ENDING_REQUIRED_CHECKS = [
  'actionInvitation',
  'followsContext',
  'factsSupported',
  'noContentAfterCta',
] as const;

/**
 * 解析语义审核响应（复审 S2 严格化）：fail closed——
 * - 四项必需子检查必须齐全且全部为布尔 true；
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
