import type { ScriptStudioHierarchyRole, SellingPointEvidenceRef } from './types.ts';

/**
 * 卖点字段的共享规范化领域函数。vision-extract（模型响应解析）与 libraries（持久化）
 * 都必须走这里，避免出现两份不一致的默认值逻辑。
 */

const HIERARCHY_ROLES = new Set<ScriptStudioHierarchyRole>(['primary', 'supporting', 'detail']);

export function normalizeHierarchyRole(value: unknown): ScriptStudioHierarchyRole {
  return typeof value === 'string' && HIERARCHY_ROLES.has(value as ScriptStudioHierarchyRole)
    ? value as ScriptStudioHierarchyRole
    : 'supporting';
}

export function normalizeImportance(value: unknown): number {
  // null/undefined/空串/非数字一律回退 50；Number(null)===0 不得被钳制成 1。
  if (value === null || value === undefined) return 50;
  const raw = typeof value === 'string' ? value.trim() : value;
  if (raw === '') return 50;
  const parsed = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(parsed)) return 50;
  return Math.max(1, Math.min(100, Math.floor(parsed)));
}

export function normalizeThemeTitle(value: unknown): string {
  return (typeof value === 'string' ? value : '')
    .normalize('NFKC')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase();
}

/**
 * 主题分组键由本地生成：pageIndex + 规范化 themeTitle。
 * 同一页面同一标题跨提取批次归并；不同页面即使模型返回相同 themeKey 也不碰撞。
 * 模型返回的 themeKey 只在没有标题可用时作辅助信息，绝不直接作为修订级稳定键。
 */
export function canonicalThemeKey(input: {
  pageIndex?: number | null;
  themeTitle?: unknown;
  modelThemeKey?: unknown;
  pointType?: string;
}): string {
  const page = typeof input.pageIndex === 'number' && Number.isInteger(input.pageIndex) && input.pageIndex >= 0
    ? String(input.pageIndex)
    : 'na';
  const title = normalizeThemeTitle(input.themeTitle);
  if (title) return `p${page}:${title}`;
  const modelKey = normalizeThemeTitle(input.modelThemeKey);
  if (modelKey) return `p${page}:mk:${modelKey}`;
  return `p${page}:type:${input.pointType || 'other'}`;
}

function toPageIndex(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * 证据定位的权威结构：每条引用自带 pageIndex + tileRef 配对。
 * 跨页合并的卖点因此仍能把每条证据定位回正确页面与切片。
 * 输入为旧结构（sourcePageIndex + tileRefs）时按同一页合成配对。
 */
export function normalizeEvidenceRefs(input: {
  evidenceRefs?: unknown;
  sourcePageIndex?: number | null;
  tileRefs?: unknown;
}): SellingPointEvidenceRef[] {
  const refs: SellingPointEvidenceRef[] = [];
  const seen = new Set<string>();
  const push = (pageIndex: number | null, tileRef: string): void => {
    if (pageIndex === null && !tileRef) return;
    const key = `${pageIndex ?? 'na'}${tileRef}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ pageIndex, tileRef });
  };
  if (Array.isArray(input.evidenceRefs)) {
    for (const raw of input.evidenceRefs) {
      const record = raw && typeof raw === 'object' && !Array.isArray(raw)
        ? raw as Record<string, unknown>
        : {};
      push(toPageIndex(record.pageIndex), typeof record.tileRef === 'string' ? record.tileRef.trim() : '');
    }
  }
  if (refs.length === 0) {
    const pageIndex = toPageIndex(input.sourcePageIndex);
    const tileRefs = Array.isArray(input.tileRefs) ? input.tileRefs : [];
    for (const raw of tileRefs) {
      if (typeof raw !== 'string' || !raw.trim()) continue;
      push(pageIndex, raw.trim());
    }
    if (refs.length === 0 && pageIndex !== null) push(pageIndex, '');
  }
  return refs;
}

function parseJsonArray(value: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** 持久化记录（evidenceRefsJson/sourcePageIndex/tileRefsJson 三列）→ 权威证据定位。 */
export function evidenceRefsOfRecord(point: {
  evidenceRefsJson: string;
  sourcePageIndex: number | null;
  tileRefsJson: string;
}): SellingPointEvidenceRef[] {
  return normalizeEvidenceRefs({
    evidenceRefs: parseJsonArray(point.evidenceRefsJson),
    sourcePageIndex: point.sourcePageIndex,
    tileRefs: parseJsonArray(point.tileRefsJson),
  });
}

export function primaryPageIndexOf(refs: SellingPointEvidenceRef[]): number | null {
  return refs.find((ref) => ref.pageIndex !== null)?.pageIndex ?? null;
}

/** 证据边界 fail closed：evidenceGate=failed 的卖点无论 usable/disabledByUser 如何都不可用。 */
export function isSellingPointEvidenceUsable(point: {
  usable: number;
  disabledByUser: number;
  evidenceGate: string;
}): boolean {
  return point.usable === 1 && point.disabledByUser === 0 && point.evidenceGate !== 'failed';
}
