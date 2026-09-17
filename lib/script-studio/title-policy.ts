import type { FrozenKnowledgeContext } from './knowledge-context.ts';
import type { LibraryRevisionView } from './libraries.ts';
import { isSellingPointEvidenceUsable } from './selling-point-normalize.ts';
import { effectiveSearchTerms } from './title-embedding.ts';
import type { ScriptStudioScriptContent } from './types.ts';

export const SCRIPT_TITLE_LENGTHS = {
  title: [4, 16],
  'coverTitleParts.primary': [4, 12],
  'coverTitleParts.secondary': [4, 10],
} as const;
export type ScriptTitleField = keyof typeof SCRIPT_TITLE_LENGTHS;
export interface ScriptTitleSummary {
  title?: string;
  coverTitleParts?: { primary?: string; secondary?: string };
  scriptId?: string;
  revisionId?: string;
}
export interface ScriptTitleIssue {
  code: string;
  field: ScriptTitleField;
  message: string;
  conflictingText?: string;
}
export interface ScriptTitleContext {
  displayName: string;
  modelKeys: string[];
  searchTerms: string[];
}

function modelPattern(key: string): RegExp {
  const escaped = key.normalize('NFKC').trim().split(/[\s_-]+/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s_-]*');
  return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'gi');
}

/** 只从任务内已冻结的查找键识别型号；不扫描标题里的任意字母数字组合。 */
export function buildScriptTitleContext(
  library: Pick<LibraryRevisionView, 'productName' | 'category'>,
  knowledge?: FrozenKnowledgeContext | null,
): ScriptTitleContext {
  const strategy = knowledge?.strategy;
  const frozenModel = knowledge?.productIdentity?.modelKey || strategy?.normalizedModelKey || '';
  const keys = [frozenModel, strategy?.normalizedModelKey || ''];
  // 旧快照只存完整匹配键（如 ps691-b）。保留该键中明确分隔的主型号，兼容目录名中的 PS691。
  const baseModel = frozenModel.split(/[\s_-]+/)[0] || '';
  if (baseModel !== frozenModel && /[a-z]/i.test(baseModel) && /\d/.test(baseModel)) keys.push(baseModel);
  const modelKeys = [...new Set(keys.map((key) => key.normalize('NFKC').trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
  const cleanName = (value: string) => {
    let name = value.normalize('NFKC').replace(/#/g, '');
    for (const key of modelKeys) name = name.replace(modelPattern(key), '');
    return name.replace(/[()（）【】]/g, '').replace(/^[\s|_-]+|[\s|_-]+$/g, '').replace(/\s+/g, ' ').trim();
  };
  return {
    displayName: cleanName(strategy?.canonicalName || library.productName || '') || library.category || '产品',
    modelKeys,
    searchTerms: effectiveSearchTerms(strategy?.searchTerms || []),
  };
}

export function normalizeScriptTitle(value: string): string {
  return value.normalize('NFKC').toLowerCase()
    .replace(/(?:[（(]?(?:第|方案)?\d+(?:版|集|篇|期)?[)）]?)\s*$/u, '')
    .replace(/第[一二三四五六七八九十]+[版集篇期]/gu, '')
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

/** 短标题用保守的编辑距离；忽略空白、标点和编号，不把共用品类词当重复。 */
export function areScriptTitlesDuplicate(left: string, right: string): boolean {
  const a = Array.from(normalizeScriptTitle(left));
  const b = Array.from(normalizeScriptTitle(right));
  if (!a.length || !b.length) return false;
  let row = b.map((_, index) => index + 1);
  row.unshift(0);
  for (let i = 1; i <= a.length; i += 1) {
    const next = [i];
    for (let j = 1; j <= b.length; j += 1) {
      next[j] = Math.min(next[j - 1]! + 1, row[j]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    row = next;
  }
  const distance = row[b.length]!;
  return distance === 0 || (Math.min(a.length, b.length) >= 5 && distance / Math.max(a.length, b.length) <= 0.16);
}

function hasSameCharacterBag(left: string, right: string): boolean {
  const a = Array.from(normalizeScriptTitle(left));
  const b = Array.from(normalizeScriptTitle(right));
  // 只对满足副标题最小长度且包含多个有效字的副标题启用词序置换检查，避免
  // 极短单词被误判；完整字符多重集相同本身是严格条件，主标题不会参与判断。
  if (a.length < 4 || a.length !== b.length || new Set(a).size < 3) return false;
  const counts = new Map<string, number>();
  for (const character of a) counts.set(character, (counts.get(character) || 0) + 1);
  for (const character of b) {
    const count = counts.get(character) || 0;
    if (count === 0) return false;
    if (count === 1) counts.delete(character);
    else counts.set(character, count - 1);
  }
  return counts.size === 0;
}

/**
 * 封面去重以完整主副标题组合为边界。
 * 主标题可复用商品展示名；只有组合本身相同/近似才拦截。副标题额外识别
 * 同一组短语的词序调换（例如“横厅高颜值隔断”和“横厅隔断高颜值”）。
 */
export function areCoverTitlePairsDuplicate(left: ScriptTitleSummary, right: ScriptTitleSummary): boolean {
  const leftPrimary = titleFieldValue(left, 'coverTitleParts.primary');
  const rightPrimary = titleFieldValue(right, 'coverTitleParts.primary');
  const leftSecondary = titleFieldValue(left, 'coverTitleParts.secondary');
  const rightSecondary = titleFieldValue(right, 'coverTitleParts.secondary');
  if (!leftPrimary || !rightPrimary || !leftSecondary || !rightSecondary) return false;
  const normalizedPrimary = normalizeScriptTitle(leftPrimary);
  const normalizedRightPrimary = normalizeScriptTitle(rightPrimary);
  const normalizedSecondary = normalizeScriptTitle(leftSecondary);
  const normalizedRightSecondary = normalizeScriptTitle(rightSecondary);
  const primaryExact = normalizedPrimary === normalizedRightPrimary;
  const secondaryExact = normalizedSecondary === normalizedRightSecondary;
  const primaryNear = areScriptTitlesDuplicate(leftPrimary, rightPrimary);
  const secondaryNear = areScriptTitlesDuplicate(leftSecondary, rightSecondary);
  if (primaryExact) return secondaryNear || hasSameCharacterBag(leftSecondary, rightSecondary);
  // 实质不同的主标题 + 相同副标题明确放行；主标题只改一个语气字等极小变化时，
  // 仍属于完整组合近似。副标题词序调换也要和这种主标题小变体一起拦截。
  if (secondaryExact) return primaryNear;
  if (!primaryNear) return false;
  if (hasSameCharacterBag(leftSecondary, rightSecondary)) return true;
  if (!secondaryNear) return false;
  const leftPair = `${leftPrimary}${leftSecondary}`;
  const rightPair = `${rightPrimary}${rightSecondary}`;
  return areScriptTitlesDuplicate(leftPair, rightPair);
}

export function coverTitlePairValue(value: ScriptTitleSummary): string {
  return `${titleFieldValue(value, 'coverTitleParts.primary')}｜${titleFieldValue(value, 'coverTitleParts.secondary')}`;
}

const FIELD_LABELS: Record<ScriptTitleField, string> = {
  title: '脚本标题',
  'coverTitleParts.primary': '封面主标题',
  'coverTitleParts.secondary': '封面副标题',
};

export function titleFieldValue(content: ScriptTitleSummary, field: ScriptTitleField): string {
  if (field === 'title') return content.title || '';
  return field === 'coverTitleParts.primary' ? content.coverTitleParts?.primary || '' : content.coverTitleParts?.secondary || '';
}

// 确定性事实闸门覆盖数字、常见材质、认证、功效和绝对化用语；知识目录搜索词不充当证据。
const FACT_CLAIMS = /\d+(?:\.\d+)?(?:%|年|天|秒|倍|厘米|毫米|cm|mm|kg|公斤|米|层|档|人|级)?|[一二三四五六七八九十百千万两]+(?:年|天|秒|倍|厘米|毫米|层|档|人|级)|真皮|头层牛皮|牛皮|实木|棉麻|纯棉|乳胶|铝合金|不锈钢|岩板|碳纤维|雪尼尔|海绵|羽绒|食品级|婴幼儿级|a类|e0级|enf级|零甲醛|无甲醛|抗菌|抑菌|防螨|防霉|防水|阻燃|矫正|治疗|治愈|缓解疼痛|护脊|护腰|承重|认证|专利|最佳|最好|第一|唯一|绝对|百分百|永久|彻底|顶级|最强/giu;

export function checkScriptTitles(
  content: ScriptStudioScriptContent,
  options: {
    libraryRevision: LibraryRevisionView;
    context?: ScriptTitleContext;
    previousTitles?: ScriptTitleSummary[];
    /**
     * 参与检查的字段（默认全部三个）。爆文模板改写只有单标题语义，
     * 传 ['title'] 跳过封面主/副标题检查；其他模式不得用此参数放宽。
     */
    fields?: ScriptTitleField[];
  },
): ScriptTitleIssue[] {
  const issues: ScriptTitleIssue[] = [];
  const fields = options.fields ?? (Object.keys(SCRIPT_TITLE_LENGTHS) as ScriptTitleField[]);
  const context = options.context || buildScriptTitleContext(options.libraryRevision);
  const referencedIds = new Set(content.segments.flatMap((segment) => segment.sellingPointIdRefs || []));
  const facts = options.libraryRevision.sellingPoints
    .filter((point) => isSellingPointEvidenceUsable(point) && referencedIds.has(point.id))
    .map((point) => `${point.factText} ${point.evidenceQuote || ''}`);
  const evidence = [...facts, options.libraryRevision.brand || ''].join(' ').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
  const bareNames = [context.displayName, options.libraryRevision.productName || ''].map(normalizeScriptTitle).filter(Boolean);
  for (const field of fields) {
    const value = titleFieldValue(content, field).trim();
    const label = FIELD_LABELS[field];
    const add = (code: string, message: string, conflictingText?: string) => issues.push({ code, field, message, ...(conflictingText ? { conflictingText } : {}) });
    const [min, max] = SCRIPT_TITLE_LENGTHS[field];
    const length = Array.from(value.normalize('NFKC').replace(/\s/g, '')).length;
    if (!value) add(field === 'title' ? 'title_required' : 'cover_title_required', `${label}不能为空`);
    else if (length < min || length > max) add('title_length', `${label}须为 ${min}-${max} 字，当前 ${length} 字`);
    if (value.normalize('NFKC').includes('#')) add('title_hashtag', `${label}不要使用话题符号，搜索话题单独保留`);
    const model = context.modelKeys.find((key) => modelPattern(key).test(value.normalize('NFKC')));
    if (model) add('title_contains_model', `${label}含商品型号「${model}」，请改为具体卖点或场景`);
    if (field === 'title' && bareNames.includes(normalizeScriptTitle(value))) {
      add('title_bare_product_name', `${label}直接套用了商品名称，请写出本方案的具体卖点或场景`);
    }
    for (const claim of new Set(value.normalize('NFKC').match(FACT_CLAIMS) || [])) {
      const escapedClaim = claim.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const supported = /^\d/.test(claim)
        ? new RegExp(`(?<![\\d.])${escapedClaim}(?![\\d.])`).test(evidence)
        : evidence.includes(claim.toLowerCase());
      if (!supported) add('title_unsupported_fact', `${label}中的「${claim}」缺少本方案所引用卖点的证据`);
    }
    if (field !== 'title') continue;
    const conflict = options.previousTitles?.find((previous) => areScriptTitlesDuplicate(value, titleFieldValue(previous, field)));
    if (conflict) add('duplicate_title', `${label}与已用标题「${titleFieldValue(conflict, field)}」重复或过于相似，请换一个实质不同的切入点，不能只换编号`, titleFieldValue(conflict, field));
  }
  const checkCover = fields.includes('coverTitleParts.primary') || fields.includes('coverTitleParts.secondary');
  const coverConflict = checkCover
    ? options.previousTitles?.find((previous) => areCoverTitlePairsDuplicate(content, previous))
    : undefined;
  if (coverConflict) {
    issues.push({
      code: 'duplicate_cover_combo',
      field: 'coverTitleParts.secondary',
      message: `封面主副标题组合「${coverTitlePairValue(content)}」与已用组合「${coverTitlePairValue(coverConflict)}」重复或过于相似，请优先改写封面副标题；商品展示名可以复用`,
      conflictingText: coverTitlePairValue(coverConflict),
    });
  }
  return issues;
}

/** 只替换校验指出的字段；模型返回的正文、时长、引用等额外字段全部忽略。 */
export function applyScriptTitleRepair(
  content: ScriptStudioScriptContent,
  raw: unknown,
  issues: ScriptTitleIssue[],
): ScriptStudioScriptContent {
  const record = raw && typeof raw === 'object' ? raw as ScriptTitleSummary : {};
  const next = { ...content, coverTitleParts: { ...content.coverTitleParts } };
  for (const field of new Set(issues.map((issue) => issue.field))) {
    const value = titleFieldValue(record, field);
    if (typeof value !== 'string') continue;
    if (field === 'title') next.title = value.trim();
    else if (field === 'coverTitleParts.primary') next.coverTitleParts.primary = value.trim();
    else next.coverTitleParts.secondary = value.trim();
  }
  return next;
}

export function scriptTitleRequirements(): string[] {
  return [
    '脚本标题要表达本方案的具体卖点或场景，不能只写商品名；封面主标题可以使用商品展示名，封面副标题要表达本方案的具体卖点或场景；不要使用型号、话题符号或用序号区分重复标题',
    '封面主标题与副标题按完整组合去重；商品展示名主标题可以复用，但相同或近似的完整组合（包括副标题词序调换）必须改写副标题；实质不同的主标题配同副标题可以复用',
    '脚本标题 4-16 字，封面主标题 4-12 字，封面副标题 4-10 字（含标点，不计空白）',
    '标题的数字、材质、认证、功效与绝对化用语必须有本方案引用的卖点事实支持；展示名称、搜索词及创作要求都不是事实证据',
    '搜索话题保留在独立知识上下文，不强制写入脚本标题或封面',
  ];
}
