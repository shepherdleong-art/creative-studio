import type { LibrarySellingPointInput } from './libraries.ts';
import { normalizeEvidenceRefs } from './selling-point-normalize.ts';
import type { ScriptStudioHierarchyRole } from './types.ts';

function normalizeForDedupe(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[\s\p{P}]+/gu, '')
    .toLowerCase();
}

function bigrams(value: string): Set<string> {
  if (value.length <= 1) return new Set(value ? [value] : []);
  const result = new Set<string>();
  for (let index = 0; index < value.length - 1; index += 1) {
    result.add(value.slice(index, index + 2));
  }
  return result;
}

function similarity(left: string, right: string): number {
  const a = bigrams(left);
  const b = bigrams(right);
  if (a.size === 0 || b.size === 0) {
    return left === right ? 1 : 0;
  }
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  return (2 * intersection) / (a.size + b.size);
}

export function isNearDuplicateSellingPoint(
  left: { title: string; factText: string },
  right: { title: string; factText: string },
  threshold = 0.8,
): boolean {
  const leftTitle = normalizeForDedupe(left.title);
  const rightTitle = normalizeForDedupe(right.title);
  if (leftTitle && rightTitle && similarity(leftTitle, rightTitle) >= threshold) return true;
  const leftFact = normalizeForDedupe(left.factText);
  const rightFact = normalizeForDedupe(right.factText);
  if (!leftFact || !rightFact) return false;
  const shorter = leftFact.length <= rightFact.length ? leftFact : rightFact;
  const longer = leftFact.length <= rightFact.length ? rightFact : leftFact;
  if (shorter.length >= 4 && longer.includes(shorter)) return true;
  return similarity(leftFact, rightFact) >= threshold;
}

const HIERARCHY_ROLE_STRENGTH: Record<ScriptStudioHierarchyRole, number> = {
  primary: 3,
  supporting: 2,
  detail: 1,
};

function strongerHierarchyRole(
  left: ScriptStudioHierarchyRole | undefined,
  right: ScriptStudioHierarchyRole | undefined,
): ScriptStudioHierarchyRole {
  const leftRole = left && HIERARCHY_ROLE_STRENGTH[left] ? left : 'supporting';
  const rightRole = right && HIERARCHY_ROLE_STRENGTH[right] ? right : 'supporting';
  return HIERARCHY_ROLE_STRENGTH[leftRole] >= HIERARCHY_ROLE_STRENGTH[rightRole] ? leftRole : rightRole;
}

export function dedupeSellingPoints(
  points: LibrarySellingPointInput[],
  options: { threshold?: number } = {},
): LibrarySellingPointInput[] {
  const result: LibrarySellingPointInput[] = [];
  for (const point of points) {
    const existingIndex = result.findIndex((candidate) => isNearDuplicateSellingPoint(
      { title: candidate.title, factText: candidate.factText },
      { title: point.title, factText: point.factText },
      options.threshold,
    ));
    if (existingIndex < 0) {
      result.push({ ...point });
      continue;
    }
    const existing = result[existingIndex]!;
    // 证据定位按 pageIndex + tileRef 配对合并：跨页重复事实合并后，
    // 每条引用仍能定位回自己的页面与切片，旧字段由配对结果派生。
    const evidenceRefs = normalizeEvidenceRefs({
      evidenceRefs: [
        ...normalizeEvidenceRefs(existing),
        ...normalizeEvidenceRefs(point),
      ],
    });
    // 合并重复事实时保留主题语境与最强层级信号：主题取首个非空，
    // 角色取 primary > supporting > detail，重要度取最高，证据定位全部保留。
    result[existingIndex] = {
      ...existing,
      evidenceQuote: [existing.evidenceQuote, point.evidenceQuote].filter(Boolean).join('；'),
      evidenceRefs,
      tileRefs: evidenceRefs.map((ref) => ref.tileRef).filter(Boolean),
      sourcePageIndex: evidenceRefs.find((ref) => ref.pageIndex !== null)?.pageIndex ?? undefined,
      modelConfidence: [existing.modelConfidence, point.modelConfidence]
        .filter((value) => value === 'high' || value === 'medium')
        .at(0)
        || existing.modelConfidence
        || point.modelConfidence
        || '',
      themeKey: existing.themeKey || point.themeKey || '',
      themeTitle: existing.themeTitle || point.themeTitle || '',
      hierarchyRole: strongerHierarchyRole(existing.hierarchyRole, point.hierarchyRole),
      importance: Math.max(existing.importance ?? 50, point.importance ?? 50),
    };
  }
  return result;
}
