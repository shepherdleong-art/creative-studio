// 跨商品保护的身份判定：extract 阶段每张详情页独立走一遍视觉模型，同一产品的
// 不同页在 productName/category/brand 上几乎必然有措辞差异（缺品牌、多型号、
// 「真皮床」对「真皮储物床」）。因此只把「商品名都识别出来且明显不同」当作冲突，
// 品类/品牌只作辅助信息不参与判定，未识别出名字的页弃权。

export interface ScriptStudioPageIdentity {
  pageIndex: number;
  productName: string;
  category: string;
  brand: string;
}

// 归一化：忽略大小写，只保留字母与数字，消除空格与标点差异。
export function normalizeIdentityField(value: string): string {
  return (value || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
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
): [ScriptStudioPageIdentity, ScriptStudioPageIdentity] | null {
  const named = identities.filter((identity) => normalizeIdentityField(identity.productName));
  for (let i = 0; i < named.length; i += 1) {
    for (let j = i + 1; j < named.length; j += 1) {
      if (!isSameProductName(
        normalizeIdentityField(named[i]!.productName),
        normalizeIdentityField(named[j]!.productName),
      )) {
        return [named[i]!, named[j]!];
      }
    }
  }
  return null;
}
