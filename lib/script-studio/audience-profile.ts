/**
 * 受众画像（2026-09-15）：
 * - 受众不再是「关注${category}并正在做购买决策的人群」式字符串插值，而是基于商品与
 *   卖点事实由模型推理出的结构化画像（细分人群/场景/痛点/决策驱动/雷点）；
 * - 主画像 1 个 + 每个创意方向 1 个细分切口，方向之间不得雷同；
 * - 画像在 plan 阶段冻结进任务快照（fingerprint 匹配即复用，重跑不重复调用）；
 * - 模型调用/解析失败降级为本地推导画像（degraded=true），不阻塞脚本生成；
 * - relatedSellingPointIds 只作编排排序信号，不扩大事实来源（幻觉 ID 解析时剔除）。
 */
import { createHash } from 'node:crypto';
import type { LibraryRevisionView } from './libraries.ts';
import type { PlannedScript } from './planner.ts';

export const AUDIENCE_PROFILE_VERSION = 'audience-profile-v1';

export interface AudienceSegmentProfile {
  /** 细分人群（具体特征：年龄段/家庭结构/居住或消费场景，非空） */
  segment: string;
  /** 典型使用场景 */
  scenario: string;
  /** 核心痛点（1-3 条） */
  pains: string[];
  /** 决策驱动（1-3 条最在意的点） */
  decisionDrivers: string[];
  /** 雷点（会劝退该类人群的表述，1-2 条） */
  rejections: string[];
}

export interface PlanAudienceSegment extends AudienceSegmentProfile {
  planIndex: number;
  /** 模型从候选卖点中原样点选的最相关卖点 ID（编排排序信号，非事实来源）。 */
  relatedSellingPointIds: string[];
}

export interface AudienceProfileResult {
  version: typeof AUDIENCE_PROFILE_VERSION;
  /** 主画像一句话摘要（UI 展示）。 */
  summary: string;
  primary: AudienceSegmentProfile;
  perPlan: PlanAudienceSegment[];
  /** 本地降级推导为 true（模型不可用/失败时）。 */
  degraded: boolean;
  degradedReason?: string;
  /** 冻结指纹：卖点库修订 + 方向计划 + 创作简报 + 目标时长。 */
  fingerprint: string;
}

export function audienceProfileFingerprint(input: {
  libraryRevisionId: string;
  plans: PlannedScript[];
  creativeBrief: string;
  targetDurationSec: number;
}): string {
  const hash = createHash('sha256');
  hash.update(input.libraryRevisionId);
  hash.update('\n');
  hash.update(String(input.targetDurationSec));
  hash.update('\n');
  hash.update(input.creativeBrief.trim());
  for (const plan of input.plans) {
    hash.update('\n');
    hash.update(`${plan.index}:${plan.templateId}:${plan.angle}`);
  }
  return hash.digest('hex');
}

// ── 模型画像分析 ────────────────────────────────────────────────────

export interface AudienceAnalysisInput {
  libraryRevision: LibraryRevisionView;
  plans: PlannedScript[];
  creativeBrief: string;
  targetDurationSec: number;
  signal?: AbortSignal;
}

function clip(value: string, max: number): string {
  return Array.from(value.trim()).slice(0, max).join('');
}

function clipList(values: string[], maxItems: number, maxLen: number): string[] {
  return values.map((value) => clip(value, maxLen)).filter(Boolean).slice(0, maxItems);
}

export function buildAudienceAnalysisPrompt(input: AudienceAnalysisInput): { systemPrompt: string; userPrompt: string } {
  const library = input.libraryRevision;
  return {
    systemPrompt: '你是电商短视频受众分析师。只返回一个 JSON 对象，不输出解释。',
    userPrompt: JSON.stringify({
      task: 'analyze_audience_profile_v1',
      product: {
        displayName: library.productName || '',
        category: library.category || '',
        brand: library.brand || '',
      },
      creativeBrief: input.creativeBrief || '',
      targetDurationSec: input.targetDurationSec,
      plans: input.plans.map((plan) => ({
        planIndex: plan.index,
        templateName: plan.templateName,
        angle: plan.angle,
        rationale: plan.rationale,
      })),
      sellingPoints: library.sellingPoints.map((point) => ({
        id: point.id,
        title: point.title,
        factText: point.factText,
        pointType: point.pointType,
        themeTitle: point.themeTitle || '',
      })),
      requirements: [
        '基于商品、品类与卖点事实推断真实购买人群；禁止「关注X并正在做购买决策的人群」这类同义反复的空泛标签',
        'primary 给出最主要的 1 类购买人群：segment 必须具体（年龄段/家庭结构/居住状态/消费行为中的至少两个特征，24 字以内）；scenario 为典型使用场景；pains 1-3 条该人群在该场景下的核心痛点；decisionDrivers 1-3 条决策时最在意的点；rejections 1-2 条会劝退该人群的表述（如夸大功效、复杂安装）',
        'perPlan 为每个 planIndex 给出与该创意方向最契合的细分切口：可以是主画像人群的不同侧面，也可以是次要细分人群；方向之间的人群或痛点不得雷同',
        'perPlan.relatedSellingPointIds 从给定卖点 id 中原样点选与该细分最相关的 2-4 条，不得编造不存在的 id',
        '痛点与场景必须能从卖点事实或品类使用情境合理推导，不得虚构产品不具备的能力',
      ],
      output: {
        primary: { segment: 'string', scenario: 'string', pains: ['string'], decisionDrivers: ['string'], rejections: ['string'] },
        perPlan: [{
          planIndex: 'number',
          segment: 'string', scenario: 'string', pains: ['string'], decisionDrivers: ['string'], rejections: ['string'],
          relatedSellingPointIds: ['string'],
        }],
      },
    }),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function stringList(value: unknown, maxItems: number, maxLen: number): string[] {
  return clipList(
    (Array.isArray(value) ? value : []).map(asString).filter(Boolean),
    maxItems,
    maxLen,
  );
}

function parseSegment(value: unknown): AudienceSegmentProfile | null {
  const record = asRecord(value);
  const segment = clip(asString(record.segment), 40);
  const scenario = clip(asString(record.scenario), 60);
  if (!segment || !scenario) return null;
  return {
    segment,
    scenario,
    pains: stringList(record.pains, 3, 60),
    decisionDrivers: stringList(record.decisionDrivers, 3, 40),
    rejections: stringList(record.rejections, 2, 40),
  };
}

/**
 * 解析画像响应（fail closed 主画像 + 字段白名单）：
 * 主画像缺 segment/scenario 整体不可用（调用方走降级）；perPlan 单方向缺字段只跳过该方向；
 * relatedSellingPointIds 过滤幻觉 ID；planIndex 必须命中实际方向且去重。
 */
export function parseAudienceProfile(
  raw: unknown,
  options: { plans: PlannedScript[]; sellingPointIds: string[] },
): { primary: AudienceSegmentProfile; perPlan: PlanAudienceSegment[] } | null {
  const record = asRecord(raw);
  const primary = parseSegment(record.primary);
  if (!primary) return null;
  const knownIds = new Set(options.sellingPointIds);
  const planIndexes = new Set(options.plans.map((plan) => plan.index));
  const seen = new Set<number>();
  const perPlan: PlanAudienceSegment[] = [];
  for (const item of Array.isArray(record.perPlan) ? record.perPlan : []) {
    const entry = asRecord(item);
    const planIndex = typeof entry.planIndex === 'number' ? entry.planIndex : NaN;
    if (!planIndexes.has(planIndex) || seen.has(planIndex)) continue;
    const segment = parseSegment(entry);
    if (!segment) continue;
    seen.add(planIndex);
    perPlan.push({
      ...segment,
      planIndex,
      relatedSellingPointIds: stringList(entry.relatedSellingPointIds, 4, 80)
        .filter((id) => knownIds.has(id)),
    });
  }
  return { primary, perPlan };
}

/** 主画像摘要（UI 一行展示）。 */
export function audienceProfileSummary(primary: AudienceSegmentProfile): string {
  const pain = primary.pains[0] ? `，痛点：${primary.pains[0]}` : '';
  return `${primary.segment}（${primary.scenario}${pain}）`;
}

// ── 本地降级推导（C：模型不可用时不阻塞任务）─────────────────────────

/**
 * 本地推导画像：从卖点库的场景/功效类卖点与方向身份推导，诚实标注 degraded。
 * 痛点不脑补反义表述，统一用「在使用中需要『卖点』」的安全句式，避免虚构；
 * perPlan 不点选卖点 ID（编排尚未发生，避免循环依赖），受众相关性只靠关键词命中。
 */
export function deriveFallbackAudienceProfile(input: {
  libraryRevision: LibraryRevisionView;
  plans: PlannedScript[];
  creativeBrief: string;
  targetDurationSec: number;
  audienceLabel: string;
  reason: string;
}): AudienceProfileResult {
  const points = input.libraryRevision.sellingPoints;
  const scenarioTitles = points
    .filter((point) => point.pointType === 'scenario')
    .map((point) => point.title)
    .filter(Boolean);
  const driverTitles = points
    .filter((point) => point.hierarchyRole === 'primary')
    .map((point) => point.title)
    .filter(Boolean);
  const category = input.libraryRevision.category || '';
  const primary: AudienceSegmentProfile = {
    segment: input.audienceLabel || (category ? `关注${category}并正在做购买决策的人群` : '正在了解具体产品的人群'),
    scenario: scenarioTitles.slice(0, 2).join('、') || '日常使用场景',
    pains: driverTitles.slice(0, 2).map((title) => `在使用中需要「${title}」`),
    decisionDrivers: driverTitles.slice(0, 3),
    rejections: ['夸大功效承诺', '与事实不符的参数表述'],
  };
  const perPlan: PlanAudienceSegment[] = input.plans.map((plan) => ({
    planIndex: plan.index,
    segment: primary.segment,
    scenario: primary.scenario,
    pains: [`经「${plan.angle}」切入时${primary.pains[0] || '需要明确的产品支撑'}`],
    decisionDrivers: primary.decisionDrivers,
    rejections: primary.rejections,
    relatedSellingPointIds: [],
  }));
  return {
    version: AUDIENCE_PROFILE_VERSION,
    summary: audienceProfileSummary(primary),
    primary,
    perPlan,
    degraded: true,
    degradedReason: input.reason,
    fingerprint: audienceProfileFingerprint({
      libraryRevisionId: input.libraryRevision.id,
      plans: input.plans,
      creativeBrief: input.creativeBrief,
      targetDurationSec: input.targetDurationSec,
    }),
  };
}

// ── plan 阶段快照读写 ────────────────────────────────────────────────

/** 冻结进 plan stage payload 的快照形态（含 UI 展示所需的最小字段）。 */
export function serializeAudienceProfile(profile: AudienceProfileResult): Record<string, unknown> {
  return {
    version: profile.version,
    summary: profile.summary,
    primary: profile.primary,
    perPlan: profile.perPlan,
    degraded: profile.degraded,
    ...(profile.degradedReason ? { degradedReason: profile.degradedReason } : {}),
    fingerprint: profile.fingerprint,
  };
}

/** 从既有 plan stage payload 恢复画像（fingerprint 不匹配视为无缓存）。 */
export function readAudienceProfileFromStagePayload(
  payload: Record<string, unknown>,
  fingerprint: string,
): AudienceProfileResult | null {
  const raw = payload.audienceProfile;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (record.fingerprint !== fingerprint || record.version !== AUDIENCE_PROFILE_VERSION) return null;
  const primary = parseSegment(record.primary);
  if (!primary) return null;
  const perPlan: PlanAudienceSegment[] = [];
  for (const item of Array.isArray(record.perPlan) ? record.perPlan : []) {
    const entry = asRecord(item);
    if (typeof entry.planIndex !== 'number') continue;
    const segment = parseSegment(entry);
    if (!segment) continue;
    perPlan.push({
      ...segment,
      planIndex: entry.planIndex,
      relatedSellingPointIds: stringList(entry.relatedSellingPointIds, 4, 80),
    });
  }
  return {
    version: AUDIENCE_PROFILE_VERSION,
    summary: asString(record.summary) || audienceProfileSummary(primary),
    primary,
    perPlan,
    degraded: record.degraded === true,
    ...(typeof record.degradedReason === 'string' ? { degradedReason: record.degradedReason } : {}),
    fingerprint,
  };
}
