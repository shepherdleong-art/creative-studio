import { splitCoverTitle } from './media-core/cover-domain.ts';
import type { ScriptOutputV3 } from './script-providers/types.ts';

type JsonObject = Record<string, unknown>;

interface ScriptCoverTitleInput {
  productCategory: string;
  productName: string;
  visuals: readonly unknown[];
}

interface GroundedScriptSegment {
  segment: { visualKeywords: string[] };
  visualRefs: string[];
}

interface GenerationSellingPoint {
  sellingPointId: string;
  title: string;
}

interface ResolveScriptCoverTitleInput {
  rawParts: unknown;
  input: ScriptCoverTitleInput;
  groundedSegments: GroundedScriptSegment[];
  sellingPoints: GenerationSellingPoint[];
  scriptTitle: string;
}

type ScriptCoverTitleResolution =
  | {
      status: 'resolved';
      coverTitleParts: ScriptOutputV3['coverTitleParts'];
      advisories: string[];
    }
  | { status: 'invalid_references'; issues: string[] };

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

function visualRefForIndex(index: number): string {
  return `visual-${index + 1}`;
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

/** 提示词与下方的服务端校验住在一起，调整标题契约时不能只改其中一边。 */
export const SCRIPT_COVER_TITLE_PROMPT = {
  outputContract: {
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
  requirements: [
    '封面标题必须是两段式：primary 使用“可见气质/材质/核心特征 + 具体产品品类”，secondary 使用“场景向往/理想状态/购买理由”；两句都必须独立完整且互相补充',
    `禁止使用以下无具体信息的万能标题：${GENERIC_COVER_TITLE_PHRASES.join('、')}`,
    'primary 必须严格等于 primaryStyleModifier + primaryEvidenceTerm + productCategoryTerm；secondary 必须严格等于 secondaryQualifier + secondarySceneTerm + secondaryValuePhrase',
    'primary 和 secondary 的各组成字段不得互相包含或重复，避免“软弹沙发沙发”“安心客厅安心之选”这类病句',
    'coverTitleParts.visualRefs 和 sellingPointIds 必须证明标题能由真实附图与已选卖点共同承接；productCategoryTerm 和 secondarySceneTerm 所在段落的 visualRefs 必须与标题 visualRefs 至少命中同一张图',
  ],
} as const;

function hasNoSentencePunctuation(value: string): boolean {
  return Boolean(value) && !/[，。！？；：,.!?;:]/u.test(value);
}

function titlePartsDoNotOverlap(values: string[]): boolean {
  const keys = values.map(titleKey).filter(Boolean);
  return keys.every((key, index) => keys.every((other, otherIndex) => (
    index === otherIndex || (!key.includes(other) && !other.includes(key))
  )));
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
  input: ScriptCoverTitleInput,
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
  input: ScriptCoverTitleInput,
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

/**
 * 普通结构失配可以按安全底线降级；图片或卖点引用不实则返回独立结果，
 * 由脚本生成入口继续走 blocking 修正，不能靠兜底标题掩盖编造引用。
 */
export function resolveScriptCoverTitle({
  rawParts: rawPartsValue, input, groundedSegments, sellingPoints, scriptTitle,
}: ResolveScriptCoverTitleInput): ScriptCoverTitleResolution {
  const rawParts = object(rawPartsValue);
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
  if (valid) return { status: 'resolved', coverTitleParts: { primary, secondary, source: 'model' }, advisories: [] };

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
    return { status: 'invalid_references', issues };
  }
  if (titleSafetyPasses(primary, secondary)) {
    return {
      status: 'resolved',
      coverTitleParts: { primary, secondary, source: 'system_composed' },
      advisories: ['封面标题未满足结构规则，已沿用模型措辞', ...issues],
    };
  }
  const composed = composeFallbackTitle(rawParts, input, groundedSegments, sellingPoints, scriptTitle);
  return {
    status: 'resolved',
    coverTitleParts: { primary: composed.primary, secondary: composed.secondary, source: 'system_composed' },
    advisories: ['封面标题未满足结构规则，已使用服务端合成标题', ...issues],
  };
}
