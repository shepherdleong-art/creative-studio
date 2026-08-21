import { createHash } from 'node:crypto';
import {
  buildScriptDurationBudget,
  countScriptContentCharacters,
  estimateNarrationDurationSec,
} from './script-duration-policy.ts';
import {
  getScriptTemplate,
  SCRIPT_TEMPLATES,
} from './script-templates.ts';
import { normalizeAutomaticSubtitleText } from './subtitle-display.ts';
import { splitCoverTitle } from './media-core/cover-domain.ts';
import { getScriptStrategyAnalysisV3ValidationIssues } from './script-strategy.ts';
import type {
  AnalysisInput,
  ScriptOutputV3,
  ScriptSegmentV3,
  ScriptStrategyAnalysisV3,
  ScriptWarningV3,
  SelectedSellingPoint,
} from './script-providers/types.ts';
import type { MixcutTaskScriptSnapshot } from './final-edit/mixcut-script.ts';

type JsonObject = Record<string, unknown>;

export interface CompleteJsonRequest {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  images?: Array<{ mimeType: string; imageBase64: string }>;
  signal?: AbortSignal;
}

export interface ScriptGenerationProgress {
  phase: 'preparing' | 'generating' | 'validating' | 'saving' | 'completed';
  percent: number;
  message: string;
  attempt?: number;
}

export interface ScriptGenerationV3Dependencies {
  completeJson(input: CompleteJsonRequest): Promise<unknown>;
  signal?: AbortSignal;
  onProgress?(progress: ScriptGenerationProgress): void;
}

export interface ScriptVisualContext {
  shotId: string;
  shotIndex: number;
  imageAssetId: string;
  sourceFilename: string;
  mimeType: string;
  imageBase64: string;
}

export interface ScriptGenerationInputV3 {
  projectName: string;
  productName: string;
  productCode: string;
  productCategory: string;
  targetAudience: string;
  tone: string;
  platform: string;
  selectedSellingPoints: SelectedSellingPoint[];
  templateId: string;
  templateName: string;
  targetDurationSec: number;
  shotSetId: string;
  visuals: ScriptVisualContext[];
}

interface ScriptDurationErrorDetails {
  kind: 'duration';
  targetNarrationSec: number;
  estimatedNarrationSec: number;
  contentCharacterCount: number;
  targetCharacterRange: [number, number];
  attempts: number;
}

interface ScriptContractErrorDetails extends Omit<ScriptDurationErrorDetails, 'kind'> {
  kind: 'contract';
  /** 最后一次校验失败的逐条可操作原因（已随修正提示词反馈给模型，也供服务端日志排查）。 */
  validationIssues?: string[];
}

interface ScriptMaterialMismatchErrorDetails {
  kind: 'material_mismatch';
  attempts: number;
  unsupportedNarrativeBeats: string[];
  materialReason: string;
  suggestedTemplateId?: string;
  suggestedTemplateName?: string;
}

interface ScriptAnalysisContractErrorDetails {
  kind: 'analysis_contract';
  attempts: number;
  validationIssues: string[];
}

interface ScriptGenerationV3ErrorDetailsByCode {
  script_duration_unresolved: ScriptDurationErrorDetails;
  script_contract_invalid: ScriptContractErrorDetails;
  script_material_mismatch: ScriptMaterialMismatchErrorDetails;
  script_analysis_contract_invalid: ScriptAnalysisContractErrorDetails;
}

export type ScriptGenerationV3ErrorCode = keyof ScriptGenerationV3ErrorDetailsByCode;
export type ScriptGenerationV3ErrorDetails = ScriptGenerationV3ErrorDetailsByCode[ScriptGenerationV3ErrorCode];

export class ScriptGenerationV3Error<Code extends ScriptGenerationV3ErrorCode = ScriptGenerationV3ErrorCode> extends Error {
  readonly code: Code;
  readonly details: ScriptGenerationV3ErrorDetailsByCode[Code];

  constructor(
    code: Code,
    message: string,
    details: ScriptGenerationV3ErrorDetailsByCode[Code],
  ) {
    super(message);
    this.name = 'ScriptGenerationV3Error';
    this.code = code;
    this.details = details;
  }
}

type VisualRef = `visual-${number}`;

function visualRefForIndex(index: number): VisualRef {
  return `visual-${index + 1}`;
}

class ScriptMaterialMismatchError extends Error {
  readonly unsupportedNarrativeBeats: string[];
  readonly materialReason: string;
  readonly suggestedTemplateId?: string;
  readonly suggestedTemplateName?: string;

  constructor(
    unsupportedNarrativeBeats: string[],
    materialReason: string,
    suggestedTemplateId?: string,
    suggestedTemplateName?: string,
  ) {
    super('script_material_mismatch');
    this.name = 'ScriptMaterialMismatchError';
    this.unsupportedNarrativeBeats = unsupportedNarrativeBeats;
    this.materialReason = materialReason;
    this.suggestedTemplateId = suggestedTemplateId;
    this.suggestedTemplateName = suggestedTemplateName;
  }
}

/**
 * 模型输出未通过结构校验。issues 是面向模型的具体可操作中文描述，
 * 会原样进入下一次修正提示词（rewritePrompt 的 validationIssues），
 * 否则修正循环只能盲目重试，同类失配会反复踩同一条规则。
 */
class ScriptOutputValidationError extends Error {
  readonly issues: string[];
  readonly severity: 'blocking' | 'advisory';

  constructor(issues: string[], severity: 'blocking' | 'advisory' = 'blocking') {
    super(issues.join('；'));
    this.name = 'ScriptOutputValidationError';
    this.issues = issues;
    this.severity = severity;
  }
}

export interface ScriptCandidate {
  script: ScriptOutputV3;
  qualification: 'qualified' | 'too_short' | 'too_long';
  /** 未阻断但已降级的原因，逐条可读；卡 3/4 开始填充。 */
  advisories: string[];
}

/**
 * 候选比较必须稳定且确定：qualified 优先 → advisories 少优先 → 保留先出现；
 * 两个都非 qualified 时也保留先出现，不比较 too_short/too_long 的先后。
 */
export function betterCandidate(best: ScriptCandidate | null, candidate: ScriptCandidate): ScriptCandidate {
  if (!best) return candidate;
  const bestQualified = best.qualification === 'qualified';
  const candidateQualified = candidate.qualification === 'qualified';
  if (candidateQualified !== bestQualified) return candidateQualified ? candidate : best;
  if (candidate.advisories.length < best.advisories.length) return candidate;
  return best;
}

function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

function string(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\r?\n/gu, ' ').replace(/\s+/gu, ' ').trim() : '';
}

function stringArray(value: unknown, limit = 8): string[] {
  return Array.isArray(value)
    ? value.map(string).filter(Boolean).filter((item, index, values) => values.indexOf(item) === index).slice(0, limit)
    : [];
}

function titleContentLength(value: string): number {
  return Array.from(value.replace(/[^\p{L}\p{N}]/gu, '')).length;
}

function titleFits(value: string, range: [number, number]): boolean {
  const length = titleContentLength(value);
  return length >= range[0] && length <= range[1];
}

function titleKey(value: string): string {
  return value.normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '').toLocaleLowerCase();
}

function titlesAreComplementary(primary: string, secondary: string): boolean {
  const primaryKey = titleKey(primary);
  const secondaryKey = titleKey(secondary);
  return Boolean(primaryKey && secondaryKey)
    && primaryKey !== secondaryKey
    && !primaryKey.includes(secondaryKey)
    && !secondaryKey.includes(primaryKey);
}

const COVER_TITLE_SECONDARY_ROLE_VALUES = [
  'scene_aspiration',
  'lifestyle_state',
  'purchase_reason',
] as const;
const COVER_TITLE_SECONDARY_ROLES = new Set<string>(COVER_TITLE_SECONDARY_ROLE_VALUES);

const COVER_TITLE_STYLE_MODIFIERS = new Set([
  '', '温润', '轻盈', '松弛感', '柔和', '雅致', '简约', '厚实', '柔软', '利落', '治愈系', '原木感',
]);
const COVER_TITLE_SECONDARY_QUALIFIERS = new Set([
  '', '理想', '松弛', '舒适', '雅致', '安心', '治愈', '精致',
]);
const COVER_TITLE_SECONDARY_VALUE_PHRASES = new Set([
  '必备', '氛围担当', '优雅之选', '舒适之选', '安心之选', '质感之选', '空间亮点', '日常搭档', '松弛搭档',
]);
const GENERIC_PRODUCT_CATEGORY_TERM_VALUES = ['产品', '好物', '单品', '家具', '家居', '用品'] as const;
const GENERIC_PRODUCT_CATEGORY_TERMS = new Set<string>(GENERIC_PRODUCT_CATEGORY_TERM_VALUES);
const GENERIC_SECONDARY_SCENE_TERMS = new Set(['生活', '美好生活', '日常', '居家', '家里', '空间']);
const GENERIC_COVER_TITLE_PHRASES = [
  '产品推荐',
  '好物推荐',
  '值得认真看看',
  '品质生活之选',
  '提升生活品质',
  '理想生活必备',
] as const;
const GENERIC_COVER_TITLE_KEYS = new Set(GENERIC_COVER_TITLE_PHRASES.map(titleKey));

function hasNoSentencePunctuation(value: string): boolean {
  return Boolean(value) && !/[，。！？；：,.!?;:]/u.test(value);
}

function titlePartsDoNotOverlap(values: string[]): boolean {
  const keys = values.map(titleKey).filter(Boolean);
  return keys.every((key, index) => keys.every((other, otherIndex) => (
    index === otherIndex || (!key.includes(other) && !other.includes(key))
  )));
}

interface GroundedScriptSegment {
  segment: ScriptSegmentV3;
  visualRefs: string[];
  sellingPointIds: string[];
}

interface GenerationSellingPoint extends SelectedSellingPoint {
  sellingPointId: string;
}

function generationSellingPoints(input: ScriptGenerationInputV3): GenerationSellingPoint[] {
  const seenIds = new Set<string>();
  return input.selectedSellingPoints.map((point) => {
    const sellingPointId = string(point.sellingPointId) || stableSellingPointId(point.title);
    if (seenIds.has(sellingPointId)) throw new Error('selected_selling_point_ids_invalid');
    seenIds.add(sellingPointId);
    return { ...point, sellingPointId };
  });
}

const FALLBACK_SECONDARY_TITLE = '理想生活之选';

/** 封面标题第 2 级安全底线：长度、标点、万能词、互补性。 */
function titleSafetyPasses(primary: string, secondary: string): boolean {
  return titleFits(primary, [2, 16])
    && titleFits(secondary, [2, 16])
    && hasNoSentencePunctuation(primary)
    && hasNoSentencePunctuation(secondary)
    && !GENERIC_COVER_TITLE_KEYS.has(titleKey(primary))
    && !GENERIC_COVER_TITLE_KEYS.has(titleKey(secondary))
    && titlesAreComplementary(primary, secondary);
}

function pickTitleProductCategoryTerm(
  rawParts: JsonObject,
  input: ScriptGenerationInputV3,
  groundedSegments: GroundedScriptSegment[],
): string {
  for (const candidate of [string(rawParts.productCategoryTerm), string(input.productCategory)]) {
    if (candidate
      && /^[\p{L}\p{N}]{1,6}$/u.test(candidate)
      && !GENERIC_PRODUCT_CATEGORY_TERMS.has(titleKey(candidate))) {
      return candidate;
    }
  }
  return groundedSegments
    .flatMap(({ segment }) => segment.visualKeywords)
    .find((keyword) => keyword
      && /^[\p{L}\p{N}]{1,6}$/u.test(keyword)
      && !GENERIC_PRODUCT_CATEGORY_TERMS.has(titleKey(keyword)))
    || '';
}

/** 从排名第 1 的卖点标题截取 2-6 个内容字符作证据词。 */
function pickTitleEvidenceTerm(sellingPoints: GenerationSellingPoint[]): string {
  const content = Array.from(sellingPoints[0]?.title || '')
    .filter((character) => /[\p{L}\p{N}]/u.test(character))
    .slice(0, 6);
  return content.length >= 2 ? content.join('') : '';
}

/** 第 3 级：服务端合成标题；任何输入下都返回非空主副标题。 */
function composeFallbackTitle(
  rawParts: JsonObject,
  input: ScriptGenerationInputV3,
  groundedSegments: GroundedScriptSegment[],
  sellingPoints: GenerationSellingPoint[],
  scriptTitle: string,
): { primary: string; secondary: string } {
  const category = pickTitleProductCategoryTerm(rawParts, input, groundedSegments);
  const evidence = pickTitleEvidenceTerm(sellingPoints);
  const primary = evidence && titlePartsDoNotOverlap([evidence, category].filter(Boolean))
    ? `${evidence}${category}`
    : category;
  const secondary = splitCoverTitle(scriptTitle).secondary || FALLBACK_SECONDARY_TITLE;
  if (titleSafetyPasses(primary, secondary)) return { primary, secondary };
  const split = splitCoverTitle(scriptTitle);
  if (split.primary && split.secondary) return split;
  return {
    primary: category || input.productName || '产品',
    secondary: FALLBACK_SECONDARY_TITLE,
  };
}

interface ResolvedTitleParts {
  coverTitleParts: ScriptOutputV3['coverTitleParts'];
  advisories: string[];
}

function resolveTitleParts(
  raw: JsonObject,
  input: ScriptGenerationInputV3,
  groundedSegments: GroundedScriptSegment[],
  sellingPoints: GenerationSellingPoint[],
  scriptTitle: string,
): ResolvedTitleParts {
  const rawParts = object(raw.coverTitleParts);
  const primary = string(rawParts.primary);
  const secondary = string(rawParts.secondary);
  const productCategoryTerm = string(rawParts.productCategoryTerm);
  const primaryStyleModifier = string(rawParts.primaryStyleModifier);
  const primaryEvidenceTerm = string(rawParts.primaryEvidenceTerm);
  const secondaryRole = string(rawParts.secondaryRole);
  const secondaryQualifier = string(rawParts.secondaryQualifier);
  const secondarySceneTerm = string(rawParts.secondarySceneTerm);
  const secondaryValuePhrase = string(rawParts.secondaryValuePhrase);
  const visualRefs = stringArray(rawParts.visualRefs);
  const sellingPointIds = stringArray(rawParts.sellingPointIds);
  const allowedVisualRefs = new Set<string>(input.visuals.map((_, index) => visualRefForIndex(index)));
  const sellingPointById = new Map(sellingPoints.map((point) => [point.sellingPointId, point]));
  const sellingPointRefs = sellingPointIds
    .map((sellingPointId) => sellingPointById.get(sellingPointId)?.title || '')
    .filter(Boolean);
  const categoryKey = titleKey(productCategoryTerm);
  const primaryEvidenceKey = titleKey(primaryEvidenceTerm);
  const secondarySceneKey = titleKey(secondarySceneTerm);
  const titleVisualRefSet = new Set(visualRefs);
  const titleSceneIsGrounded = groundedSegments.some(({ segment, visualRefs: segmentVisualRefs }) => (
    segment.visualKeywords.some((keyword) => titleKey(keyword) === secondarySceneKey)
    && segmentVisualRefs.some((visualRef) => titleVisualRefSet.has(visualRef))
  ));
  const titleCategoryIsGrounded = groundedSegments.some(({ segment, visualRefs: segmentVisualRefs }) => (
    segment.visualKeywords.some((keyword) => titleKey(keyword).includes(categoryKey))
    && segmentVisualRefs.some((visualRef) => titleVisualRefSet.has(visualRef))
  ));

  const valid = titleFits(primary, [4, 12])
    && titleFits(secondary, [4, 10])
    && hasNoSentencePunctuation(primary)
    && hasNoSentencePunctuation(secondary)
    && /^[\p{L}\p{N}]{1,6}$/u.test(productCategoryTerm)
    && !GENERIC_PRODUCT_CATEGORY_TERMS.has(categoryKey)
    && COVER_TITLE_STYLE_MODIFIERS.has(primaryStyleModifier)
    && titleContentLength(primaryEvidenceTerm) >= 2
    && titleContentLength(primaryEvidenceTerm) <= 6
    && primary === `${primaryStyleModifier}${primaryEvidenceTerm}${productCategoryTerm}`
    && titlePartsDoNotOverlap([primaryStyleModifier, primaryEvidenceTerm, productCategoryTerm])
    && titleCategoryIsGrounded
    && sellingPointRefs.some((reference) => titleKey(reference).includes(primaryEvidenceKey))
    && titlesAreComplementary(primary, secondary)
    && !titleKey(secondary).includes(categoryKey)
    && !GENERIC_COVER_TITLE_KEYS.has(titleKey(primary))
    && !GENERIC_COVER_TITLE_KEYS.has(titleKey(secondary))
    && COVER_TITLE_SECONDARY_ROLES.has(secondaryRole)
    && COVER_TITLE_SECONDARY_QUALIFIERS.has(secondaryQualifier)
    && titleContentLength(secondarySceneTerm) >= 2
    && titleContentLength(secondarySceneTerm) <= 5
    && !GENERIC_SECONDARY_SCENE_TERMS.has(secondarySceneKey)
    && titleSceneIsGrounded
    && COVER_TITLE_SECONDARY_VALUE_PHRASES.has(secondaryValuePhrase)
    && secondary === `${secondaryQualifier}${secondarySceneTerm}${secondaryValuePhrase}`
    && titlePartsDoNotOverlap([secondaryQualifier, secondarySceneTerm, secondaryValuePhrase])
    && visualRefs.length > 0
    && visualRefs.every((visualRef) => allowedVisualRefs.has(visualRef))
    && (sellingPoints.length === 0 || (
      sellingPointIds.length > 0
      && sellingPointIds.every((sellingPointId) => sellingPointById.has(sellingPointId))
    ));
  if (valid) return { coverTitleParts: { primary, secondary, source: 'model' }, advisories: [] };

  // 与上面的 valid 链逐条对应；失配原因必须具体可操作，随修正提示词反馈给模型。
  const issues: string[] = [];
  if (!titleFits(primary, [4, 12])) issues.push(`主标题「${primary}」有效字数需在 4-12 字`);
  if (!titleFits(secondary, [4, 10])) issues.push(`副标题「${secondary}」有效字数需在 4-10 字`);
  if (!hasNoSentencePunctuation(primary)) issues.push(`主标题「${primary}」不能包含句读标点`);
  if (!hasNoSentencePunctuation(secondary)) issues.push(`副标题「${secondary}」不能包含句读标点`);
  if (!/^[\p{L}\p{N}]{1,6}$/u.test(productCategoryTerm) || GENERIC_PRODUCT_CATEGORY_TERMS.has(categoryKey)) {
    issues.push(`productCategoryTerm「${productCategoryTerm}」必须是 1-6 字的具体品类词，不能用泛称`);
  }
  if (!COVER_TITLE_STYLE_MODIFIERS.has(primaryStyleModifier)) {
    issues.push(`primaryStyleModifier「${primaryStyleModifier}」不在允许列表内，可留空`);
  }
  if (titleContentLength(primaryEvidenceTerm) < 2 || titleContentLength(primaryEvidenceTerm) > 6) {
    issues.push(`primaryEvidenceTerm「${primaryEvidenceTerm}」有效字数需在 2-6 字`);
  }
  if (primary !== `${primaryStyleModifier}${primaryEvidenceTerm}${productCategoryTerm}`) {
    issues.push(`主标题「${primary}」必须严格等于 primaryStyleModifier + primaryEvidenceTerm + productCategoryTerm 的拼接`);
  }
  if (!titlePartsDoNotOverlap([primaryStyleModifier, primaryEvidenceTerm, productCategoryTerm])) {
    issues.push('主标题的 styleModifier / evidenceTerm / categoryTerm 不得互相包含');
  }
  if (!titleCategoryIsGrounded) {
    issues.push(`封面标题的品类词「${productCategoryTerm}」缺少正文承接：请把「${productCategoryTerm}」原样加入某一段的 visualKeywords，且该段的 visualRefs 要与封面标题 visualRefs（${visualRefs.join('、')}）至少命中同一张图`);
  }
  if (!sellingPointRefs.some((reference) => titleKey(reference).includes(primaryEvidenceKey))) {
    issues.push(`primaryEvidenceTerm「${primaryEvidenceTerm}」必须原样出现在封面标题所引用卖点的 title 中`);
  }
  if (!titlesAreComplementary(primary, secondary)) issues.push('主标题与副标题不得相同或互相包含');
  if (titleKey(secondary).includes(categoryKey)) issues.push(`副标题「${secondary}」不能包含品类词「${productCategoryTerm}」`);
  if (GENERIC_COVER_TITLE_KEYS.has(titleKey(primary)) || GENERIC_COVER_TITLE_KEYS.has(titleKey(secondary))) {
    issues.push('禁止使用无具体信息的万能标题');
  }
  if (!COVER_TITLE_SECONDARY_ROLES.has(secondaryRole)) issues.push(`secondaryRole「${secondaryRole}」不在允许列表内`);
  if (!COVER_TITLE_SECONDARY_QUALIFIERS.has(secondaryQualifier)) {
    issues.push(`secondaryQualifier「${secondaryQualifier}」不在允许列表内，可留空`);
  }
  if (titleContentLength(secondarySceneTerm) < 2 || titleContentLength(secondarySceneTerm) > 5 || GENERIC_SECONDARY_SCENE_TERMS.has(secondarySceneKey)) {
    issues.push(`secondarySceneTerm「${secondarySceneTerm}」必须是 2-5 字的具体场景词，不能用泛称`);
  }
  if (!titleSceneIsGrounded) {
    issues.push(`封面标题的场景词「${secondarySceneTerm}」缺少正文承接：请把「${secondarySceneTerm}」原样加入某一段的 visualKeywords，且该段的 visualRefs 要与封面标题 visualRefs（${visualRefs.join('、')}）至少命中同一张图`);
  }
  if (!COVER_TITLE_SECONDARY_VALUE_PHRASES.has(secondaryValuePhrase)) {
    issues.push(`secondaryValuePhrase「${secondaryValuePhrase}」不在允许列表内`);
  }
  if (secondary !== `${secondaryQualifier}${secondarySceneTerm}${secondaryValuePhrase}`) {
    issues.push(`副标题「${secondary}」必须严格等于 secondaryQualifier + secondarySceneTerm + secondaryValuePhrase 的拼接`);
  }
  if (!titlePartsDoNotOverlap([secondaryQualifier, secondarySceneTerm, secondaryValuePhrase])) {
    issues.push('副标题的 qualifier / sceneTerm / valuePhrase 不得互相包含');
  }
  const refsValid = visualRefs.length > 0
    && visualRefs.every((visualRef) => allowedVisualRefs.has(visualRef));
  const sellingPointRefsValid = sellingPoints.length === 0 || (
    sellingPointIds.length > 0
    && sellingPointIds.every((sellingPointId) => sellingPointById.has(sellingPointId))
  );
  if (!refsValid) {
    issues.push(`coverTitleParts.visualRefs 只能引用 ${Array.from(allowedVisualRefs).join('、')} 中真实存在的 visualRef`);
  }
  if (!sellingPointRefsValid) {
    issues.push('coverTitleParts.sellingPointIds 必须原样引用 selectedSellingPoints 中的 sellingPointId');
  }
  if (!refsValid || !sellingPointRefsValid) {
    // 「不许编造」红线：标题必须引用真实存在的图片与已选卖点，这条保持 blocking。
    throw new ScriptOutputValidationError(issues);
  }
  if (titleSafetyPasses(primary, secondary)) {
    return {
      coverTitleParts: { primary, secondary, source: 'system_composed' },
      advisories: ['封面标题未满足结构规则，已沿用模型措辞', ...issues],
    };
  }
  const composed = composeFallbackTitle(rawParts, input, groundedSegments, sellingPoints, scriptTitle);
  return {
    coverTitleParts: { primary: composed.primary, secondary: composed.secondary, source: 'system_composed' },
    advisories: ['封面标题未满足结构规则，已使用服务端合成标题', ...issues],
  };
}

function normalizeSegments(
  raw: JsonObject,
  input: ScriptGenerationInputV3,
  sellingPoints: GenerationSellingPoint[],
): GroundedScriptSegment[] {
  const sellingPointById = new Map(sellingPoints.map((point) => [point.sellingPointId, point]));
  const allowedVisualRefs = new Set<string>(input.visuals.map((_, index) => visualRefForIndex(index)));
  const rawSegments = Array.isArray(raw.segments) ? raw.segments : [];
  const usedIds = new Set<string>();
  const segments: GroundedScriptSegment[] = [];
  rawSegments.forEach((value, index) => {
    const source = object(value);
    const narration = string(source.narration);
    if (!narration) return;
    let id = string(source.id) || `segment-${index + 1}`;
    if (usedIds.has(id)) id = `segment-${index + 1}`;
    usedIds.add(id);
    const sellingPointIds = stringArray(source.sellingPointIds);
    if (sellingPointIds.some((sellingPointId) => !sellingPointById.has(sellingPointId))) {
      throw new ScriptOutputValidationError([
        `第 ${index + 1} 段引用了不存在的卖点 ID：只能原样引用 selectedSellingPoints 中的 sellingPointId（${sellingPoints.map((point) => point.sellingPointId).join('、')}），未使用卖点时返回空数组`,
      ]);
    }
    const sellingPointRefs = sellingPointIds.map((sellingPointId) => sellingPointById.get(sellingPointId)!.title);
    const visualKeywords = stringArray(source.visualKeywords)
      .map((keyword) => Array.from(keyword).slice(0, 20).join(''));
    const visualIntent = string(source.visualIntent);
    const visualRefs = Array.isArray(source.visualRefs)
      ? source.visualRefs.map(string).filter(Boolean).filter((item, itemIndex, values) => values.indexOf(item) === itemIndex)
      : [];
    if (!visualIntent || visualKeywords.length === 0) {
      throw new ScriptOutputValidationError([`第 ${index + 1} 段缺少 visualIntent 或 visualKeywords，两者都必须非空`]);
    }
    if (visualRefs.length === 0 || visualRefs.some((visualRef) => !allowedVisualRefs.has(visualRef))) {
      throw new ScriptOutputValidationError([
        `第 ${index + 1} 段的 visualRefs 为空或含非法引用：只能引用 ${Array.from(allowedVisualRefs).join('、')} 中真实存在的 visualRef`,
      ]);
    }
    segments.push({
      segment: {
        id,
        narration,
        subtitle: normalizeAutomaticSubtitleText(narration),
        sellingPointIdRefs: sellingPointIds,
        sellingPointRefs,
        visualIntent,
        visualKeywords,
      },
      visualRefs,
      sellingPointIds,
    });
  });
  return segments;
}

interface RawSellingPointUsageEntry {
  status: string;
  reason: string;
}

/**
 * 卖点采用表由服务端推导：status 完全由「该卖点是否出现在某段 sellingPointIds 中」决定；
 * 模型返回的 sellingPointUsage 只作为 reason 的来源，以及「明确声称图片无画面证据」时的
 * omitted_no_visual_support 判断来源。登记缺失/乱填一律不阻断。
 */
function deriveSellingPointUsage(
  raw: JsonObject,
  sellingPoints: GenerationSellingPoint[],
  groundedSegments: GroundedScriptSegment[],
): NonNullable<ScriptOutputV3['sellingPointUsage']> {
  const rawUsage = new Map<string, RawSellingPointUsageEntry>();
  if (Array.isArray(raw.sellingPointUsage)) {
    raw.sellingPointUsage.forEach((value) => {
      const usage = object(value);
      const sellingPointId = string(usage.sellingPointId);
      if (!sellingPointId) return;
      rawUsage.set(sellingPointId, {
        status: string(usage.status),
        reason: string(usage.reason),
      });
    });
  }
  return sellingPoints.map((point) => {
    const used = groundedSegments.some((segment) => segment.sellingPointIds.includes(point.sellingPointId));
    const modelEntry = rawUsage.get(point.sellingPointId);
    const modelSaysNoVisualSupport = modelEntry?.status === 'omitted_no_visual_support' && Boolean(modelEntry.reason);
    const status: 'used' | 'omitted' | 'omitted_no_visual_support' = used
      ? 'used'
      : modelSaysNoVisualSupport
        ? 'omitted_no_visual_support'
        : 'omitted';
    const reason = modelEntry?.reason || (used ? '正文已引用该卖点' : '正文未引用该卖点');
    return {
      sellingPointId: point.sellingPointId,
      title: point.title,
      status,
      reason,
    };
  });
}

interface MaterialAssessment {
  templateFeasible: boolean;
  unsupportedNarrativeBeats: string[];
  reason: string;
  suggestedTemplate?: { id: string; name: string };
  advisories: string[];
}

function readMaterialAssessment(raw: JsonObject, input: ScriptGenerationInputV3): MaterialAssessment {
  const assessment = object(raw.materialAssessment);
  const template = promptTemplate(input);
  const allowedNarrativeBeats = new Set(template.narrativeStructure);
  const rawBeats = stringArray(assessment.unsupportedNarrativeBeats);
  const unsupportedNarrativeBeats = rawBeats.filter((beat) => allowedNarrativeBeats.has(beat));
  const invalidBeatCount = rawBeats.length - unsupportedNarrativeBeats.length;
  const advisories: string[] = [];
  if (invalidBeatCount > 0 && unsupportedNarrativeBeats.length > 0) {
    advisories.push(
      `materialAssessment.unsupportedNarrativeBeats 中存在 ${invalidBeatCount} 条不在 template.narrativeStructure 中的阶段，已忽略；必须原样列出模板阶段文案`,
    );
  }
  let suggestedTemplate: { id: string; name: string } | undefined;
  const suggestedTemplateId = string(assessment.suggestedTemplateId);
  if (suggestedTemplateId) {
    const suggested = getScriptTemplate(suggestedTemplateId);
    if (suggested) suggestedTemplate = { id: suggested.id, name: suggested.name };
  }
  const templateFeasible = assessment.templateFeasible;
  if (typeof templateFeasible !== 'boolean') {
    throw new ScriptOutputValidationError([
      'materialAssessment.templateFeasible 必须是布尔值 true 或 false',
    ]);
  }
  return {
    templateFeasible,
    unsupportedNarrativeBeats,
    reason: string(assessment.reason) || '当前图片无法承接所选模板的核心叙事阶段',
    suggestedTemplate,
    advisories,
  };
}

function normalizeCandidate(rawValue: unknown, input: ScriptGenerationInputV3): ScriptCandidate {
  const raw = object(rawValue);
  const material = readMaterialAssessment(raw, input);
  const sellingPoints = generationSellingPoints(input);
  const groundedSegments = normalizeSegments(raw, input, sellingPoints);
  if (material.templateFeasible === false && groundedSegments.length === 0) {
    throw new ScriptMaterialMismatchError(
      material.unsupportedNarrativeBeats,
      material.reason,
      material.suggestedTemplate?.id,
      material.suggestedTemplate?.name,
    );
  }
  if (groundedSegments.length === 0) {
    throw new ScriptOutputValidationError(['segments 至少要有一段非空 narration']);
  }
  const warnings: ScriptWarningV3[] = [];
  if (material.unsupportedNarrativeBeats.length > 0) {
    warnings.push({
      code: 'unsupported_narrative_beats',
      message: `当前分镜图片没有覆盖《${input.templateName}》的 ${material.unsupportedNarrativeBeats.length} 个叙事阶段，已按可承接的部分改写。${material.suggestedTemplate ? `更契合这批图片的模板是《${material.suggestedTemplate.name}》。` : ''}`,
      unsupportedNarrativeBeats: material.unsupportedNarrativeBeats,
      ...(material.suggestedTemplate
        ? {
            suggestedTemplateId: material.suggestedTemplate.id,
            suggestedTemplateName: material.suggestedTemplate.name,
          }
        : {}),
    });
  }
  const segments = groundedSegments.map(({ segment }) => segment);
  const sellingPointUsage = deriveSellingPointUsage(raw, sellingPoints, groundedSegments);
  const unusedSellingPoints = sellingPointUsage.filter((usage) => usage.status !== 'used');
  const usageAdvisories: string[] = unusedSellingPoints.length > 0
    ? [`有 ${unusedSellingPoints.length} 个已选卖点未写入正文：${unusedSellingPoints.map((usage) => usage.title).join('、')}；若当前图片确有支撑，请把该卖点写入对应段落`]
    : [];
  if (unusedSellingPoints.length > 0) {
    warnings.push({
      code: 'selling_point_derived',
      message: `${unusedSellingPoints.length} 个已选卖点未写入正文：${unusedSellingPoints.map((usage) => usage.title).join('、')}`,
    });
  }
  const title = string(raw.title) || `${input.productName || input.projectName || '产品'}口播脚本`;
  const titleResolution = resolveTitleParts(raw, input, groundedSegments, sellingPoints, title);
  if (titleResolution.coverTitleParts.source !== 'model') {
    warnings.push({
      code: 'cover_title_fallback',
      message: '封面标题未通过结构校验，已使用兜底标题，建议进入智能混剪前手动确认。',
    });
  }
  const fullScript = segments.map((segment) => segment.narration).join('\n');
  const fullSubtitle = segments.map((segment) => segment.subtitle).join('\n');
  const contentCharacterCount = countScriptContentCharacters(fullScript);
  const estimatedNarrationDurationSec = estimateNarrationDurationSec(contentCharacterCount);
  const budget = buildScriptDurationBudget(input.targetDurationSec);
  const qualification = contentCharacterCount < budget.minContentCharacters
    ? 'too_short'
    : contentCharacterCount > budget.maxContentCharacters ? 'too_long' : 'qualified';
  return {
    qualification,
    advisories: [...material.advisories, ...titleResolution.advisories, ...usageAdvisories],
    script: {
      version: 3,
      title,
      coverTitleParts: titleResolution.coverTitleParts,
      platform: input.platform,
      tone: input.tone,
      templateId: input.templateId,
      template: input.templateName,
      shotSetId: input.shotSetId,
      targetDurationSec: input.targetDurationSec,
      targetNarrationDurationSec: budget.targetNarrationSec,
      contentCharacterCount,
      estimatedNarrationDurationSec,
      durationStatus: 'qualified',
      durationPolicyVersion: budget.policyVersion,
      sellingPointUsage,
      ...(warnings.length > 0 ? { warnings } : {}),
      segments,
      fullScript,
      fullSubtitle,
    },
  };
}

function promptTemplate(input: ScriptGenerationInputV3) {
  const template = getScriptTemplate(input.templateId);
  if (!template) throw new Error('invalid_script_template');
  return {
    id: template.id,
    name: template.name,
    objective: template.objective,
    narrativeStructure: template.narrativeStructure,
    writingRules: template.writingRules,
    desiredAudienceResponse: template.desiredAudienceResponse,
  };
}

function promptVisualMaterials(input: ScriptGenerationInputV3) {
  return input.visuals.map((visual, index) => ({
    visualRef: visualRefForIndex(index),
    imageOrder: index + 1,
    shotIndex: visual.shotIndex,
  }));
}

const SCRIPT_VISUAL_REQUIREMENTS = [
  '按 visualMaterials 的 imageOrder 对应附图顺序，先看清每张图的主体、环境、构图、可见细节和可承接动作',
  '每段口播、visualIntent 和 visualKeywords 都必须能由至少一张附图承接；看不到的产品细节、动作、人物或场景不得写入',
  '每段必须返回至少一个 visualRefs，并且只能引用 visualMaterials 中真实存在的 visualRef',
  '已选卖点只有在附图能承接时才写入；缺少画面证据时宁可不写，禁止为了覆盖卖点而虚构素材',
] as const;

const SCRIPT_TEMPLATE_REQUIREMENTS = [
  '若部分叙事阶段缺少画面承接：仍必须产出完整脚本，把缺失阶段合并或跳过、其余阶段照常推进，并在 unsupportedNarrativeBeats 中原样列出被跳过的阶段；同时在 suggestedTemplateId 给出 allowedTemplates 中更契合当前图片的模板 id。只有全部叙事阶段都无任何画面承接时，才返回 templateFeasible=false 和空 segments。',
  '只有 templateFeasible=true 时才严格按 template.narrativeStructure 的顺序推进；阶段可以合并到同一段，但不得颠倒或省略核心转折',
  '逐条遵循 template.writingRules，让所选模板在开头、展开方式和结尾上形成明确差异',
] as const;

const SCRIPT_OUTPUT_CONTRACT = {
  materialAssessment: {
    templateFeasible: 'boolean；全部核心叙事阶段均有图片承接时才为 true',
    unsupportedNarrativeBeats: 'string[]；必须从 template.narrativeStructure 中原样复制所有无法由图片承接的阶段；可行时返回空数组',
    reason: 'string；说明图片为什么足够或不足',
    suggestedTemplateId: 'string；可为空；当前图片更契合的模板 id，只能取自 allowedTemplates',
  },
  coverTitleParts: {
    primary: '4-12 字；结构必须是“可见气质/材质/核心特征 + 具体产品品类”，例如“温润黑胡桃木床”“松弛感真皮沙发”“轻盈岩板餐桌”',
    secondary: '4-10 字；表达场景向往、理想状态或购买理由，例如“理想卧室必备”“客厅氛围担当”“小户型优雅之选”',
    productCategoryTerm: `1-6 字；从附图识别出的具体产品品类，且必须是 primary 的结尾，例如“床”“沙发”“餐桌”；禁止以下泛称：${GENERIC_PRODUCT_CATEGORY_TERM_VALUES.join('、')}`,
    primaryStyleModifier: `只能从以下词中原样选择一个，可为空：${Array.from(COVER_TITLE_STYLE_MODIFIERS).join('、')}`,
    primaryEvidenceTerm: '2-6 字；必须原样出现在 primary 中，并能在 selectedSellingPoints 至少一个 title 中找到，例如“黑胡桃木”“软弹”“岩板”',
    secondaryRole: `只能从以下角色中选择：${COVER_TITLE_SECONDARY_ROLE_VALUES.join('、')}`,
    secondaryQualifier: `只能从以下词中原样选择一个，可为空：${Array.from(COVER_TITLE_SECONDARY_QUALIFIERS).join('、')}`,
    secondarySceneTerm: '2-5 字；必须是附图中真实可见的具体场景词，并原样出现在至少一段 visualKeywords 中，例如“卧室”“客厅”“小户型”',
    secondaryValuePhrase: `只能从以下短语中原样选择一个：${Array.from(COVER_TITLE_SECONDARY_VALUE_PHRASES).join('、')}`,
    visualRefs: 'string[]；标题依据的附图，只允许 visualMaterials 中的 visualRef',
    sellingPointIds: 'string[]；标题依据的已选卖点，只允许原样引用 selectedSellingPoints 中的 sellingPointId',
  },
  segments: [{
    narration: 'string',
    sellingPointIds: 'string[]；本段实际使用的卖点，只允许原样引用 selectedSellingPoints 中的 sellingPointId；没有使用卖点时返回空数组',
    visualIntent: 'string',
    visualKeywords: 'string[]',
    visualRefs: 'string[]；只允许 visualMaterials 中的 visualRef',
  }],
  sellingPointUsage: [{
    sellingPointId: 'string；已选卖点的 sellingPointId；尽量逐项说明',
    status: '只能是 used、omitted 或 omitted_no_visual_support；正文引用时为 used，图片不能承接且正文未引用时为 omitted_no_visual_support，其余未引用时为 omitted',
    reason: 'string；具体说明在哪些图片中看到了支撑，或为什么当前图片无法证明该卖点；可为空，服务端会补默认文案',
    visualRefs: 'string[]；used 时建议列出实际承接该卖点的图片；其余可为空',
  }],
} as const;

function scriptRequirements(rewrite = false): string[] {
  return [
    ...SCRIPT_TEMPLATE_REQUIREMENTS,
    ...SCRIPT_VISUAL_REQUIREMENTS,
    '封面标题必须是两段式：primary 使用“可见气质/材质/核心特征 + 具体产品品类”，secondary 使用“场景向往/理想状态/购买理由”；两句都必须独立完整且互相补充',
    `禁止使用以下无具体信息的万能标题：${GENERIC_COVER_TITLE_PHRASES.join('、')}`,
    'primary 必须严格等于 primaryStyleModifier + primaryEvidenceTerm + productCategoryTerm；secondary 必须严格等于 secondaryQualifier + secondarySceneTerm + secondaryValuePhrase',
    'primary 和 secondary 的各组成字段不得互相包含或重复，避免“软弹沙发沙发”“安心客厅安心之选”这类病句',
    'coverTitleParts.visualRefs 和 sellingPointIds 必须证明标题能由真实附图与已选卖点共同承接；productCategoryTerm 和 secondarySceneTerm 所在段落的 visualRefs 必须与标题 visualRefs 至少命中同一张图',
    '只生成带自然标点的口播，不选择或绑定具体图片、shotId 或素材顺序；visualRefs 仅用于证明内容有输入图片承接',
    '返回独立主标题和副标题，正文只能使用已选卖点中的事实',
    '每段返回 narration、sellingPointIds、visualIntent、visualKeywords、visualRefs；不要复述卖点标题作为关联键',
    'sellingPointUsage 尽量逐项说明卖点采用情况，重点写清未采用卖点的原因；正文引用与采用状态以正文为准',
    rewrite ? '返回完整重写后的 JSON，不返回 diff，不截断字符串末尾' : '返回完整 JSON；字幕、全文、时长和 ID 由服务端派生',
  ];
}

function generationPrompt(input: ScriptGenerationInputV3): string {
  const budget = buildScriptDurationBudget(input.targetDurationSec);
  return JSON.stringify({
    task: 'generate_script_v3',
    product: {
      name: input.productName,
      code: input.productCode,
      category: input.productCategory,
    },
    audience: input.targetAudience,
    platform: input.platform,
    tone: input.tone,
    template: promptTemplate(input),
    allowedTemplates: SCRIPT_TEMPLATES.map((template) => ({
      id: template.id,
      name: template.name,
      suitable: template.suitable,
    })),
    selectedSellingPoints: generationSellingPoints(input),
    visualMaterials: promptVisualMaterials(input),
    duration: {
      targetTotalSec: budget.targetTotalSec,
      targetNarrationSec: budget.targetNarrationSec,
      targetContentCharacters: [budget.minContentCharacters, budget.maxContentCharacters],
    },
    outputContract: SCRIPT_OUTPUT_CONTRACT,
    requirements: scriptRequirements(),
  });
}

function rewritePrompt(
  input: ScriptGenerationInputV3,
  issue: 'too_short' | 'too_long' | 'contract_invalid' | 'advisory',
  previousResult: unknown,
  currentScript?: ScriptOutputV3,
  validationIssues?: string[],
): string {
  const budget = buildScriptDurationBudget(input.targetDurationSec);
  return JSON.stringify({
    task: 'rewrite_complete_script_v3',
    issue,
    targetNarrationSec: budget.targetNarrationSec,
    targetContentCharacters: [budget.minContentCharacters, budget.maxContentCharacters],
    currentContentCharacterCount: currentScript?.contentCharacterCount,
    currentEstimatedNarrationSec: currentScript?.estimatedNarrationDurationSec,
    template: promptTemplate(input),
    allowedTemplates: SCRIPT_TEMPLATES.map((template) => ({
      id: template.id,
      name: template.name,
      suitable: template.suitable,
    })),
    selectedSellingPoints: generationSellingPoints(input),
    visualMaterials: promptVisualMaterials(input),
    previousResult,
    // 结构失配时给出逐条可操作的失配原因，让模型定点修复而不是盲改。
    ...(validationIssues?.length ? { validationIssues } : {}),
    outputContract: SCRIPT_OUTPUT_CONTRACT,
    requirements: [
      ...(issue === 'contract_invalid' || issue === 'advisory'
        ? [validationIssues?.length
          ? '逐项修复 validationIssues 列出的全部问题，其余已合规内容保持不变'
          : '修复所有缺失或非法字段，至少返回一个非空 narration 段落']
        : ['完整重写自然句并达到目标字数']),
      ...scriptRequirements(true),
    ],
  });
}

interface AnalysisSellingPoint {
  sellingPointId: string;
  title: string;
}

interface NormalizedAnalysisCandidate {
  analysis?: ScriptStrategyAnalysisV3;
  validationIssues: string[];
}

function stableSellingPointId(title: string): string {
  const digest = createHash('sha256').update(title.normalize('NFKC').trim(), 'utf8').digest('hex').slice(0, 16);
  return `selling-point-${digest}`;
}

function buildAnalysisSellingPoints(input: AnalysisInput): AnalysisSellingPoint[] {
  const seenIds = new Set<string>();
  return input.sellingPoints.map((title) => {
    const sellingPointId = stableSellingPointId(title);
    if (seenIds.has(sellingPointId)) {
      throw new ScriptGenerationV3Error(
        'script_analysis_contract_invalid',
        '存在重复卖点，请合并或修改后再分析',
        { kind: 'analysis_contract', attempts: 0, validationIssues: [`duplicate_input_selling_point:${sellingPointId}`] },
      );
    }
    seenIds.add(sellingPointId);
    return { sellingPointId, title };
  });
}

function analysisPriority(rank: number, total: number): 'highest' | 'high' | 'medium' | 'low' {
  if (rank === 1) return 'highest';
  if (rank <= 3) return 'high';
  if (total >= 5 && rank === total) return 'low';
  return 'medium';
}

function analysisFactorScore(factors: {
  audienceFit: number;
  platformFit: number;
  sellingPointStrength: number;
}): number {
  return factors.audienceFit * 0.4 + factors.platformFit * 0.35 + factors.sellingPointStrength * 0.25;
}

function normalizeAnalysisCandidate(
  rawValue: unknown,
  sellingPoints: AnalysisSellingPoint[],
): NormalizedAnalysisCandidate {
  const raw = object(rawValue);
  const validationIssues: string[] = [];
  const audienceInsight = string(raw.audienceInsight);
  const platformAdvice = string(raw.platformAdvice);
  if (!audienceInsight) validationIssues.push('audienceInsight_required');
  if (!platformAdvice) validationIssues.push('platformAdvice_required');

  const sellingPointById = new Map(sellingPoints.map((point) => [point.sellingPointId, point]));
  const seenIds = new Set<string>();
  const seenRanks = new Set<number>();
  const rankingCandidates: Array<Omit<ScriptStrategyAnalysisV3['rankings'][number], 'rank' | 'priority'> & {
    modelRank: number;
  }> = [];
  const rawRankings = Array.isArray(raw.rankings) ? raw.rankings : [];
  rawRankings.forEach((value) => {
    const ranking = object(value);
    const sellingPointId = string(ranking.sellingPointId);
    const rank = Number(ranking.rank);
    const reason = string(ranking.reason);
    const factors = object(ranking.factors);
    const audienceFit = Number(factors.audienceFit);
    const platformFit = Number(factors.platformFit);
    const sellingPointStrength = Number(factors.sellingPointStrength);
    if (!sellingPointById.has(sellingPointId)) validationIssues.push(`unknown_selling_point_id:${sellingPointId || 'empty'}`);
    if (seenIds.has(sellingPointId)) validationIssues.push(`duplicate_selling_point_id:${sellingPointId}`);
    if (!Number.isInteger(rank) || rank < 1 || rank > sellingPoints.length) validationIssues.push(`invalid_rank:${sellingPointId || 'empty'}`);
    if (seenRanks.has(rank)) validationIssues.push(`duplicate_rank:${rank}`);
    if (!reason) validationIssues.push(`ranking_reason_required:${sellingPointId || 'empty'}`);
    const factorValues = [audienceFit, platformFit, sellingPointStrength];
    if (!factorValues.every((score) => Number.isInteger(score) && score >= 1 && score <= 5)) {
      validationIssues.push(`ranking_factors_invalid:${sellingPointId || 'empty'}`);
    }
    if (!sellingPointById.has(sellingPointId)
      || seenIds.has(sellingPointId)
      || !Number.isInteger(rank)
      || rank < 1
      || rank > sellingPoints.length
      || seenRanks.has(rank)
      || !reason
      || !factorValues.every((score) => Number.isInteger(score) && score >= 1 && score <= 5)) {
      return;
    }
    seenIds.add(sellingPointId);
    seenRanks.add(rank);
    rankingCandidates.push({
      sellingPointId,
      modelRank: rank,
      title: sellingPointById.get(sellingPointId)!.title,
      reason,
      factors: { audienceFit, platformFit, sellingPointStrength },
    });
  });
  sellingPoints.forEach((point) => {
    if (!seenIds.has(point.sellingPointId)) validationIssues.push(`missing_selling_point_id:${point.sellingPointId}`);
  });
  for (let rank = 1; rank <= sellingPoints.length; rank += 1) {
    if (!seenRanks.has(rank)) validationIssues.push(`missing_rank:${rank}`);
  }
  rankingCandidates.sort((left, right) => (
    analysisFactorScore(right.factors) - analysisFactorScore(left.factors)
      || left.modelRank - right.modelRank
  ));
  const rankings: ScriptStrategyAnalysisV3['rankings'] = rankingCandidates.map((ranking, index) => ({
    sellingPointId: ranking.sellingPointId,
    rank: index + 1,
    title: ranking.title,
    priority: analysisPriority(index + 1, sellingPoints.length),
    reason: ranking.reason,
    factors: ranking.factors,
  }));

  const rawRecommendation = object(raw.recommendedTemplate);
  const recommendation = getScriptTemplate(string(rawRecommendation.id));
  const recommendationReason = string(rawRecommendation.reason);
  if (!recommendation) validationIssues.push('recommended_template_invalid');
  if (!recommendationReason) validationIssues.push('recommended_template_reason_required');
  if (validationIssues.length > 0 || !recommendation) return { validationIssues };

  const analysis: ScriptStrategyAnalysisV3 = {
    version: 3,
    rankings,
    audienceInsight,
    platformAdvice,
    recommendedTemplate: {
      id: recommendation.id,
      name: recommendation.name,
      reason: recommendationReason,
    },
    recommendationSource: 'model',
  };
  const finalContractIssues = getScriptStrategyAnalysisV3ValidationIssues(analysis);
  if (finalContractIssues.length > 0) return { validationIssues: finalContractIssues };
  return { validationIssues: [], analysis };
}

function buildAnalysisPrompt(
  input: AnalysisInput,
  sellingPoints: AnalysisSellingPoint[],
  revision?: { previousResult: unknown; validationIssues: string[] },
): string {
  return JSON.stringify({
    task: revision ? 'rewrite_script_strategy_analysis_v3' : 'analyze_script_strategy_v3',
    targetAudience: input.targetAudience,
    platform: input.platform,
    sellingPoints,
    allowedTemplates: SCRIPT_TEMPLATES.map((template) => ({
      id: template.id,
      name: template.name,
      suitable: template.suitable,
      objective: template.objective,
      narrativeStructure: template.narrativeStructure,
      writingRules: template.writingRules,
      desiredAudienceResponse: template.desiredAudienceResponse,
    })),
    outputContract: {
      audienceInsight: 'string；必须具体分析目标人群的需求、顾虑和购买决策因素，不得为空',
      platformAdvice: 'string；必须具体分析所选平台的内容偏好、表达方式和信任证据，不得为空',
      rankings: [{
        sellingPointId: 'string；只能原样引用 sellingPoints 中的 sellingPointId，每个 ID 必须且只能出现一次',
        rank: 'integer；模型给出的综合判断顺序，仅在三维加权分相同时用于破同分；从 1 开始连续且不得重复或遗漏',
        factors: {
          audienceFit: 'integer 1-5；与目标人群需求的匹配度',
          platformFit: 'integer 1-5；与平台内容偏好和表达方式的匹配度',
          sellingPointStrength: 'integer 1-5；卖点自身的差异化、可信度和购买决策影响力',
        },
        reason: 'string；结合目标人群、平台和卖点强度解释排名，不得为空',
      }],
      recommendedTemplate: {
        id: 'string；只能使用 allowedTemplates 中的 id',
        reason: 'string；说明排名靠前的卖点、人群和平台如何匹配模板叙事结构',
      },
    },
    requirements: [
      '卖点最终排名由服务端按人群匹配 40%、平台匹配 35%、卖点强度 25% 加权计算；必须如实给出三项评分，禁止沿用输入顺序',
      '返回完整卖点排列，每个 sellingPointId 必须且只能出现一次；不要复述或改写卖点标题',
      '只推荐一个综合模板，推荐理由必须引用排名靠前卖点、人群和平台的具体关系',
      '不分析分镜图片；图片承接能力在脚本生成阶段单独判断',
    ],
    ...(revision || {}),
  });
}

export async function analyzeScriptStrategyV3(
  input: AnalysisInput,
  dependencies: ScriptGenerationV3Dependencies,
): Promise<ScriptStrategyAnalysisV3> {
  if (!input.targetAudience.trim()) {
    throw new ScriptGenerationV3Error(
      'script_analysis_contract_invalid',
      '请先填写目标人群，再进行策略分析',
      { kind: 'analysis_contract', attempts: 0, validationIssues: ['targetAudience_required'] },
    );
  }
  const sellingPoints = buildAnalysisSellingPoints(input);
  let previousResult: unknown;
  let validationIssues: string[] = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const raw = await dependencies.completeJson({
      systemPrompt: '你是电商短视频内容策略师。只返回完整 JSON，不分析或索取图片。必须结合目标人群、发布平台与卖点强度完成排序，并严格使用输入提供的 sellingPointId，不能按输入顺序机械排序。必须依据每个模板的目标、叙事结构和适用卖点推荐，不能只根据模板名称猜测。',
      userPrompt: buildAnalysisPrompt(
        input,
        sellingPoints,
        attempt === 1 ? undefined : { previousResult, validationIssues },
      ),
      temperature: attempt === 1 ? 0.5 : 0.2,
    });
    const normalized = normalizeAnalysisCandidate(raw, sellingPoints);
    if (normalized.analysis) return normalized.analysis;
    previousResult = raw;
    validationIssues = normalized.validationIssues;
  }
  throw new ScriptGenerationV3Error(
    'script_analysis_contract_invalid',
    '策略分析未返回完整的人群、平台与卖点排序结果，请重试',
    { kind: 'analysis_contract', attempts: 3, validationIssues },
  );
}

export async function generateScriptV3(
  input: ScriptGenerationInputV3,
  dependencies: ScriptGenerationV3Dependencies,
): Promise<{ script: ScriptOutputV3; attempts: number }> {
  if (input.visuals.length === 0) throw new Error('script_visuals_required');
  const budget = buildScriptDurationBudget(input.targetDurationSec);
  const images = input.visuals.map((visual) => ({
    mimeType: visual.mimeType,
    imageBase64: visual.imageBase64,
  }));
  let prompt = generationPrompt(input);
  let lastScript: ScriptOutputV3 | null = null;
  let lastQualification: 'too_short' | 'too_long' | 'contract_invalid' | 'qualified' = 'contract_invalid';
  let lastValidationIssues: string[] = [];
  let bestCandidate: ScriptCandidate | null = null;
  let materialMismatchSeen = false;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (dependencies.signal?.aborted) throw new DOMException('脚本生成已取消', 'AbortError');
    dependencies.onProgress?.({
      phase: 'generating',
      percent: 32 + ((attempt - 1) * 20),
      message: attempt === 1 ? '模型正在生成脚本' : `模型正在进行第 ${attempt - 1} 次修正`,
      attempt,
    });
    let raw: unknown;
    try {
      raw = await dependencies.completeJson({
        systemPrompt: '你是电商短视频口播编剧。只返回完整 JSON，不绑定固定素材顺序。必须查看随用户消息附带的全部候选分镜图。先判断图片能否承接模板；能承接时必须严格遵循用户消息中的 template 叙事结构和写作规则，并遵循两段式封面标题结构；部分阶段不能承接时降级出稿并列出缺失阶段。禁止把不同模板写成同一种通用卖点罗列，也禁止返回截断句或万能标题。',
        userPrompt: prompt,
        temperature: attempt === 1 ? 0.7 : 0.4,
        images,
        signal: dependencies.signal,
      });
    } catch (error) {
      if (dependencies.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
      if (!(error instanceof Error) || !/返回了无效 JSON|返回了空响应/.test(error.message)) throw error;
      // 解析级失败（截断/空响应/夹带文字）此前会直接终止生成；记为一次可修正失败继续循环。
      lastQualification = 'contract_invalid';
      lastValidationIssues = ['上次返回不是可解析的完整 JSON（可能中途截断或夹带多余文字）：请只返回一个完整 JSON 对象，不要输出 markdown 代码块或其他文字'];
      prompt = rewritePrompt(input, 'contract_invalid', undefined, undefined, lastValidationIssues);
      continue;
    }
    dependencies.onProgress?.({
      phase: 'validating',
      percent: 45 + ((attempt - 1) * 20),
      message: `正在校验第 ${attempt} 次输出`,
      attempt,
    });
    try {
      const normalized = normalizeCandidate(raw, input);
      if (normalized.advisories.length === 0 && normalized.qualification === 'qualified') {
        return { script: normalized.script, attempts: attempt };
      }
      bestCandidate = betterCandidate(bestCandidate, normalized);
      lastScript = normalized.script;
      lastQualification = normalized.qualification;
      prompt = rewritePrompt(
        input,
        normalized.qualification === 'qualified' ? 'advisory' : normalized.qualification,
        raw,
        normalized.script,
        normalized.advisories.length > 0 ? normalized.advisories : undefined,
      );
    } catch (error) {
      if (error instanceof ScriptMaterialMismatchError) {
        if (materialMismatchSeen) {
          throw new ScriptGenerationV3Error(
            'script_material_mismatch',
            '当前分镜图片无法承接所选模板，请补充对应素材或更换模板',
            {
              kind: 'material_mismatch',
              attempts: attempt,
              unsupportedNarrativeBeats: error.unsupportedNarrativeBeats,
              materialReason: error.materialReason,
              ...(error.suggestedTemplateId ? { suggestedTemplateId: error.suggestedTemplateId } : {}),
              ...(error.suggestedTemplateName ? { suggestedTemplateName: error.suggestedTemplateName } : {}),
            },
          );
        }
        materialMismatchSeen = true;
        lastQualification = 'contract_invalid';
        lastValidationIssues = [
          '必须降级出稿，不得返回空 segments：若部分叙事阶段缺少画面承接，仍要产出完整脚本，把缺失阶段合并或跳过并在 unsupportedNarrativeBeats 中原样列出，只有全部阶段都无法承接时才返回 templateFeasible=false 和空 segments',
          `当前材料原因：${error.materialReason}`,
        ];
        prompt = rewritePrompt(input, 'contract_invalid', raw, undefined, lastValidationIssues);
        continue;
      }
      lastQualification = 'contract_invalid';
      lastValidationIssues = error instanceof ScriptOutputValidationError
        ? error.issues
        : [error instanceof Error ? error.message : String(error)];
      prompt = rewritePrompt(input, 'contract_invalid', raw, undefined, lastValidationIssues);
    }
  }

  if (bestCandidate?.qualification === 'qualified') {
    return { script: bestCandidate.script, attempts: 3 };
  }
  const durationDetails: Omit<ScriptDurationErrorDetails, 'kind'> = {
    targetNarrationSec: budget.targetNarrationSec,
    estimatedNarrationSec: bestCandidate?.script.estimatedNarrationDurationSec || lastScript?.estimatedNarrationDurationSec || 0,
    contentCharacterCount: bestCandidate?.script.contentCharacterCount || lastScript?.contentCharacterCount || 0,
    targetCharacterRange: [budget.minContentCharacters, budget.maxContentCharacters],
    attempts: 3,
  };
  if (lastQualification === 'contract_invalid') {
    throw new ScriptGenerationV3Error('script_contract_invalid', '模型两次修正后仍未返回有效脚本结构', {
      kind: 'contract',
      ...durationDetails,
      validationIssues: lastValidationIssues,
    });
  }
  throw new ScriptGenerationV3Error('script_duration_unresolved', '模型两次修正后仍未达到时长要求', {
    kind: 'duration',
    ...durationDetails,
  });
}

export async function fitNarrationTextToDuration(
  input: {
    script: MixcutTaskScriptSnapshot;
    actualNarrationUs: number;
    targetNarrationUs: number;
  },
  dependencies: ScriptGenerationV3Dependencies,
): Promise<{ editedNarrationText: string }> {
  const budget = buildScriptDurationBudget(input.script.targetDurationSec);
  const raw = object(await dependencies.completeJson({
    systemPrompt: '你是电商短视频口播编辑。只返回完整 JSON，不新增事实，不改变音色或语速。',
    userPrompt: JSON.stringify({
      task: 'fit_narration_to_real_tts_duration',
      actualNarrationSec: input.actualNarrationUs / 1_000_000,
      targetNarrationSec: input.targetNarrationUs / 1_000_000,
      targetContentCharacters: [budget.minContentCharacters, budget.maxContentCharacters],
      segments: input.script.segments.map((segment) => ({
        id: segment.id,
        narration: segment.narration,
        sellingPointRefs: segment.sellingPointRefs || [],
        visualIntent: segment.visualIntent || '',
        visualKeywords: segment.visualKeywords || [],
      })),
      requirements: [
        '返回相同数量、相同顺序的 segments 和完整 narration',
        '完整重写自然句，禁止末尾硬截断',
        '保留已有卖点与事实，禁止新增参数或承诺',
      ],
    }),
    temperature: 0.3,
  }));
  const rawSegments = Array.isArray(raw.segments) ? raw.segments : [];
  const narrations = rawSegments.map((segment) => string(object(segment).narration)).filter(Boolean);
  const fullScript = narrations.join('\n');
  const contentCharacterCount = countScriptContentCharacters(fullScript);
  if (narrations.length !== input.script.segments.length
    || contentCharacterCount < budget.minContentCharacters
    || contentCharacterCount > budget.maxContentCharacters) {
    throw new ScriptGenerationV3Error('script_duration_unresolved', '智能贴合后仍未达到目标时长预算', {
      kind: 'duration',
      targetNarrationSec: budget.targetNarrationSec,
      estimatedNarrationSec: estimateNarrationDurationSec(contentCharacterCount),
      contentCharacterCount,
      targetCharacterRange: [budget.minContentCharacters, budget.maxContentCharacters],
      attempts: 1,
    });
  }
  return { editedNarrationText: fullScript };
}
