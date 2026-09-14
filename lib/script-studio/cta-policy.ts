/**
 * CTA 结尾策略（方案 §2.3 / A4，用户补充要求）：
 * - 脚本生成器须理解 CTA（Call to Action，行动引导），新生成脚本默认以承接正文的 CTA 结尾；
 * - 完整表达与 CTA 优先于机械卡字数；
 * - 单纯的情绪收束、产品标签（如「浓郁栗棕配色。」）或品牌口号不算 CTA；
 * - 没有已确认渠道时用「了解这款 / 比较这些细节」等可执行引导，不得虚构私信、链接、到店或优惠。
 */
import type { SellingPointRecord, ScriptStudioScriptContent } from './types.ts';

export const SCRIPT_CTA_POLICY_VERSION = 'cta-ending-v1';

/** 行动引导指示词：最后一句口播命中其一才算疑似 CTA（不是关键词命中即合格，只做风险初筛）。 */
const CTA_ACTION_PATTERN = /(了解|看看|瞧瞧|试试|试一试|咨询|私信|点[一击]?[击开]|商品链接|链接|下单|购买|入手|逛[一逛]?|挑选|挑一挑|选[一选购]?|比较|对比|关注|收藏|留言|评论区|问[一问]?|去找|去选|去挑)/;

function normalizeForEndingCheck(value: string): string {
  return value.normalize('NFKC').replace(/[\s\p{P}]+/gu, '').toLowerCase();
}

export interface ScriptEndingQualityResult {
  /** 阻断性质量问题码（须修复后才能保存）：ending_bare_selling_point / cta_ending_missing。 */
  issues: string[];
  /** 末句 narration（去空白标点）正好等于某个候选卖点标题，或为其短截断。 */
  bareSellingPointId?: string;
}

/**
 * 本地结尾质量检查（确定性部分，方案 §4.2）：
 * 1. 末段与某个候选卖点标题完全一致（含句号差异）→ 孤立标签收尾，必须修复；
 * 2. 末句缺少任何行动引导迹象 → 疑似缺 CTA，进入受约束修复；
 *    纯情绪收束（如「把下班后的时间留给自己」）同样命中此项——这正是设计意图。
 * 注意：这只是风险信号与确定性拦截，不是语义审核；关键词命中也不等于合格 CTA。
 */
export function checkScriptEndingQuality(
  content: Pick<ScriptStudioScriptContent, 'segments'>,
  candidates: Array<Pick<SellingPointRecord, 'id' | 'title'>>,
): ScriptEndingQualityResult {
  const issues: string[] = [];
  const lastSegment = content.segments.at(-1);
  if (!lastSegment) return { issues };
  const lastNarration = lastSegment.narration.trim();
  const normalizedLast = normalizeForEndingCheck(lastNarration);
  // 「浓郁栗棕配色。」这类孤立标签：与候选卖点标题一致即拦截（风险信号，非禁止所有短结尾）。
  for (const candidate of candidates) {
    const normalizedTitle = normalizeForEndingCheck(candidate.title || '');
    if (!normalizedTitle || !normalizedLast) continue;
    if (normalizedLast === normalizedTitle) {
      issues.push('ending_bare_selling_point');
      return { issues, bareSellingPointId: candidate.id };
    }
  }
  if (!CTA_ACTION_PATTERN.test(lastNarration)) {
    issues.push('cta_ending_missing');
  }
  return { issues, ...(issues.length ? {} : {}) };
}

/**
 * 生成/修复提示词中的 CTA 要求（方案 §2.3）。
 * endingScene 来自任务冻结的知识库框架末段（如「理想生活 / CTA」→「理想生活」）；
 * 缺少框架或未匹配模板时使用通用 CTA 规则。
 */
export function scriptCtaRequirements(endingScene: string | null): string[] {
  const requirements = [
    '最后一句口播必须是简洁、具体的 CTA（行动引导）：承接本条脚本的场景或购买理由，明确告诉观众接下来可以做什么（如了解这款、比较这些细节、按需求挑选、私信咨询、点商品链接）',
    'CTA 反例（不合格）：「把下班后的时间留给自己」（纯情绪收束，没有行动引导）；「浓郁栗棕配色。」（孤立产品标签）；品牌口号或价格暗示',
    'CTA 之后不得再追加任何卖点、规格、材质或颜色标签',
    '没有已确认的渠道时，使用「了解这款 / 比较这些细节」等可执行的引导；不得虚构私信服务、商品链接、到店试坐、领取优惠、库存紧张或限时折扣',
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
