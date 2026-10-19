/**
 * 字体选择的纯逻辑（不访问 DOM / localStorage），供 Node 测试直接覆盖：
 * identity 归一、去重、搜索、收藏优先排序、缺失项归并。
 * 所有比较统一走 fontIdentity，提交时仍保留原 family 字符串。
 */

/** 字体身份：NFKC 归一 + 去空格 + en-US 小写。搜索、去重、收藏命中、缺失判断全部用它。 */
export function fontIdentity(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('en-US');
}

/** 按 identity 去重，保留第一次出现的原字符串；忽略空串。 */
export function dedupeFontFamilies(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const clean = typeof value === 'string' ? value.trim() : '';
    if (!clean) continue;
    const id = fontIdentity(clean);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(clean);
  }
  return out;
}

/**
 * 固定顺序归并：当前值 → 服务端 → queryLocalFonts() → 收藏偏好。
 * 同 identity 时保留第一个原值（当前值优先，避免被替换成同字体的其它写法）。
 */
export function mergeFontSources(sources: string[][]): string[] {
  return dedupeFontFamilies(sources.flat());
}

/** identity 包含匹配；空查询返回原列表。不做拼音/模糊/联网。 */
export function filterFontsByQuery(families: string[], query: string): string[] {
  const q = fontIdentity(query);
  if (!q) return families;
  return families.filter((family) => fontIdentity(family).includes(q));
}

/**
 * 收藏优先排序：收藏组按偏好数组顺序（最近收藏在前），其余按
 * Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })；
 * collator 相等时按原 family 字符串码点打破平局，保证各平台结果唯一。
 */
export function sortFontFamilies(families: string[], favorites: string[]): string[] {
  const favSet = new Set(favorites.map(fontIdentity));
  const favOrder = new Map(favorites.map((family, index) => [fontIdentity(family), index]));
  const favoriteList: string[] = [];
  const rest: string[] = [];
  for (const family of families) {
    const id = fontIdentity(family);
    if (favSet.has(id)) favoriteList.push(family);
    else rest.push(family);
  }
  favoriteList.sort(
    (left, right) => (favOrder.get(fontIdentity(left)) ?? 0) - (favOrder.get(fontIdentity(right)) ?? 0),
  );
  const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
  // 破平局必须是**码点**顺序：localeCompare() 不带 locale 用的是默认区域设置，
  // 正是这里要规避的平台相关行为（'alpha' vs 'Alpha' 的先后会随 ICU 变）。
  const byCodePoint = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
  rest.sort((left, right) => collator.compare(left, right) || byCodePoint(left, right));
  return [...favoriteList, ...rest];
}

/** 归一后的去重收藏（最近收藏在前），供偏好写入与比较使用。 */
export function normalizeFavorites(values: string[]): string[] {
  return dedupeFontFamilies(values);
}
