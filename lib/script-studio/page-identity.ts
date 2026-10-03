// 名称不相似不等于已证实跨商品。先看明确型号/品类冲突，再区分具体名称和泛称。
// sourcePages 必须来自调用方已验证的同项目、同来源集；文件名不能证明素材归属。

export interface ScriptStudioPageIdentity {
  pageIndex: number;
  productName: string;
  category: string;
  brand: string;
}

// 归一化：忽略大小写，只保留字母与数字，消除空格与标点差异。
export function normalizeIdentityField(value: string): string {
  return (value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

export interface PageIdentityContext {
  brand?: string;
  category?: string;
  sourcePages?: ReadonlyArray<{ pageIndex: number; filename: string }>;
}

export interface PageIdentityComparison {
  pageIndexes: [number, number];
  verdict: 'same' | 'unknown' | 'conflict';
  reason: string;
  sharedSourceStem: string | null;
}

function numberedSource(filename: string): { stem: string; number: number } | null {
  const basename = filename.normalize('NFKC').toLowerCase().split(/[\\/]/).at(-1) || '';
  const match = /^(.*?)(?:[-_](\d{1,6})|\((\d{1,6})\))\.(?:jpe?g|png|webp|avif|heic|tiff?)$/.exec(basename);
  if (!match) return null;
  const stem = match[1]!;
  // 排除 image-1、截图-2、IMG_0001-2 等通用短前缀；长时间戳仍只算辅助线索。
  if (normalizeIdentityField(stem).length < 8 || /^(?:img|image|photo|screenshot|截图|图片)[-_ ]?\d*$/.test(stem)) return null;
  return { stem, number: Number(match[2] || match[3]) };
}

export function sharedNumberedSourceStem(left: string, right: string): string | null {
  const a = numberedSource(left);
  const b = numberedSource(right);
  return a && b && a.stem === b.stem && a.number !== b.number ? a.stem : null;
}

function modelTokens(name: string): Array<{ base: string; variant: string }> {
  return [...name.normalize('NFKC').toLowerCase().matchAll(
    /(?<![a-z0-9])([a-z]{1,8})[\s_-]*(\d{2,8})(?:[-_\s]*([a-z]\d{0,3}))?(?![a-z0-9])/g,
  )].filter((match) => !['iso', 'gb', 'gbt', 'qb', 'qbt'].includes(match[1]!))
    .map((match) => ({ base: `${match[1]}${match[2]}`, variant: match[3] || '' }));
}

function brandNames(value: string): string[] {
  const full = normalizeIdentityField(value);
  if (!full) return [];
  const short = full.replace(/(?:家居|家具|木业|家私)$/, '');
  return [...new Set([full, ...(short.length >= 2 ? [short] : [])])];
}

function withoutBrand(name: string, brands: string[]): string {
  const prefix = [...brands].sort((a, b) => b.length - a.length).find((brand) => name.startsWith(brand));
  return prefix ? name.slice(prefix.length).replace(/^牌/, '') : name;
}

const CATEGORY_WORDS = /沙发床|沙发|软床|床框架|床架|床|餐边柜|电视柜|衣柜|书柜|柜子|餐桌|书桌|办公桌|桌子|茶几|边几|餐椅|椅子|凳子/g;
const GENERIC_WORDS = /家用|现代|简约|复古|多功能|电动|气动|升降|折叠|真皮|实木|布艺|科技布|棉麻|软包|储物|组合|单人|双人|三人|四人|框架|系列|款式|产品|商品|详情|细节|展示/g;

function specificName(name: string, category: string): string {
  if (category && name === category) return '';
  const label = name.replace(CATEGORY_WORDS, '').replace(GENERIC_WORDS, '');
  // “林氏沙发”即使品牌字段漏提，也只有品牌式称呼，没有具体商品名。
  return /^[\p{Script=Han}]{1,4}氏$/u.test(label) ? '' : label;
}

function productKinds(name: string): string[] {
  return [
    ['sofa', /沙发/], ['bed', /床/], ['chair', /椅|凳/],
    ['table', /桌|茶几|边几/], ['cabinet', /柜|书架|置物架/],
  ].filter(([, pattern]) => (pattern as RegExp).test(name)).map(([kind]) => String(kind));
}

export function comparePageIdentities(
  a: ScriptStudioPageIdentity,
  b: ScriptStudioPageIdentity,
  context: PageIdentityContext = {},
): PageIdentityComparison {
  const sources = context.sourcePages || [];
  const sharedSourceStem = sharedNumberedSourceStem(
    sources.find((page) => page.pageIndex === a.pageIndex)?.filename || '',
    sources.find((page) => page.pageIndex === b.pageIndex)?.filename || '',
  );
  const result = (verdict: PageIdentityComparison['verdict'], reason: string): PageIdentityComparison => ({
    pageIndexes: [a.pageIndex, b.pageIndex], verdict, reason, sharedSourceStem,
  });
  const nameA = normalizeIdentityField(a.productName);
  const nameB = normalizeIdentityField(b.productName);
  if (!nameA || !nameB) return result('unknown', 'missing_product_name');
  const modelsA = modelTokens(a.productName);
  const modelsB = modelTokens(b.productName);
  // 商品详情文件的完整共同主干可说明系列/组合关系；时间戳和通用编号不能。
  const sourceModels = modelTokens(sharedSourceStem || '');
  const hasSeriesSource = Boolean(sharedSourceStem && /详情/.test(sharedSourceStem) && sourceModels.length);
  const modelsCoveredBySource = hasSeriesSource && [...modelsA, ...modelsB].every((model) =>
    sourceModels.some((source) => source.base === model.base
      && (!model.variant || source.variant === model.variant)));
  const sharedModel = modelsA.some((left) => modelsB.some((right) => left.base === right.base
    && (!left.variant || !right.variant || left.variant === right.variant)));
  const sharedModelFamily = modelsA.some((left) => modelsB.some((right) => left.base === right.base));
  if (modelsA.length && modelsB.length && !sharedModelFamily && !modelsCoveredBySource) return result('conflict', 'different_explicit_models');
  if (nameA === nameB) return result('same', 'same_product_name');
  const kindsA = productKinds(nameA);
  const kindsB = productKinds(nameB);
  if (kindsA.length && kindsB.length && !kindsA.some((kind) => kindsB.includes(kind))) return result('conflict', 'different_product_kinds');
  const brandsA = brandNames(a.brand || context.brand || '');
  const brandsB = brandNames(b.brand || context.brand || '');
  if (brandsA.length > 0 && brandsB.length > 0 && !brandsA.some((brand) => brandsB.includes(brand))) {
    // 同一套详情文件（同主干含系列型号）里，逐页品牌识别常把角标/代工/slogan 误读为品牌；
    // 两边都没有明确型号时，品牌字段不足以证明跨商品，降级为不确定。
    // 时间戳主干、通用编号或任一边识别出明确型号时，不同品牌仍按冲突拦截。
    if (hasSeriesSource && modelsA.length === 0 && modelsB.length === 0) {
      return result('unknown', 'brand_mismatch_within_shared_detail_series');
    }
    return result('conflict', 'different_explicit_brands');
  }
  if (sharedModel) return result('same', 'shared_explicit_model');
  if (sharedModelFamily) return result('same', 'shared_model_family');
  if (modelsCoveredBySource) return result('same', 'shared_detail_series_source');
  const brands = [...new Set([...brandsA, ...brandsB, ...brandNames(context.brand || '')])];
  const specificA = specificName(withoutBrand(nameA, brands), normalizeIdentityField(a.category || context.category || ''));
  const specificB = specificName(withoutBrand(nameB, brands), normalizeIdentityField(b.category || context.category || ''));
  if (!specificA || !specificB) return result('unknown', sharedSourceStem ? 'numbered_segments_with_generic_name' : 'generic_or_incomplete_name');
  if (isSameProductName(specificA, specificB)) return result('same', 'compatible_specific_names');
  // 文件主干只能辅助解释一边是品牌/品类泛称或信息缺失的情况。两边都已
  // 识别出不兼容的具体名称时，仍保留冲突；不能用文件名把两个系列合成一件货。
  return result('conflict', 'different_specific_names');
}

export function comparePageIdentityPairs(
  identities: ScriptStudioPageIdentity[],
  context: PageIdentityContext = {},
): PageIdentityComparison[] {
  const comparisons: PageIdentityComparison[] = [];
  for (let i = 0; i < identities.length; i += 1) {
    for (let j = i + 1; j < identities.length; j += 1) {
      comparisons.push(comparePageIdentities(identities[i]!, identities[j]!, context));
    }
  }
  return comparisons;
}

function bigrams(value: string): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i + 2 <= value.length; i += 1) set.add(value.slice(i, i + 2));
  return set;
}

// 「林氏家居pc615真皮床」vs「林氏家居pc615真皮储物床」重合度约 0.83 判同款；
// 「pc615床」vs「pc669床」重合度 0.4 判不同款。
const SAME_PRODUCT_NAME_MIN_DICE = 0.6;

export function isSameProductName(a: string, b: string): boolean {
  if (!a || !b) return true;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const bigA = bigrams(a);
  const bigB = bigrams(b);
  if (bigA.size === 0 || bigB.size === 0) return false;
  let shared = 0;
  for (const gram of bigA) if (bigB.has(gram)) shared += 1;
  return (2 * shared) / (bigA.size + bigB.size) >= SAME_PRODUCT_NAME_MIN_DICE;
}

// 返回第一对确认为不同商品的页身份；全部兼容（或无法判定）时返回 null。
export function findCrossProductConflict(
  identities: ScriptStudioPageIdentity[],
  context: PageIdentityContext = {},
): [ScriptStudioPageIdentity, ScriptStudioPageIdentity] | null {
  const named = identities.filter((identity) => normalizeIdentityField(identity.productName));
  for (const comparison of comparePageIdentityPairs(named, context)) {
    if (comparison.verdict === 'conflict') {
      const first = named.find((identity) => identity.pageIndex === comparison.pageIndexes[0]);
      const second = named.find((identity) => identity.pageIndex === comparison.pageIndexes[1]);
      if (first && second) return [first, second];
    }
  }
  return null;
}
