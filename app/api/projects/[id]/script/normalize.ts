import type { ScriptOutput, ScriptSegment, DroppedShot, SellingPointMapEntry } from '@/lib/script-providers';

export interface NormalizeShotRow {
  shotId: string;
  indexNum: number;
  /** 模型实际看到的那张图（latestGeneratedImageId ?? sourceImageId）。 */
  imageAssetId: string;
}

type Raw = Record<string, unknown>;

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/**
 * 把模型输出收敛成可信的 v2 契约。
 *
 * 与旧版的关键差异：**不再强制 segments 数量等于分镜数**。模型选子集是设计要求，
 * 不是错误。这里只保证：shotId 合法、不重复、有 narration；未被 segments 提及的
 * 分镜一律补进 droppedShots（备用池），使 segments ∪ droppedShots 覆盖全部候选。
 */
export function normalizeScriptOutput(
  raw: unknown,
  shotRows: NormalizeShotRow[],
  fallbackShotSetId: string,
  targetDurationSec: number,
): ScriptOutput {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Raw;
  const imageByShotId = new Map(shotRows.map((row) => [row.shotId, row.imageAssetId]));

  const rawSegments = Array.isArray(source.segments) ? source.segments : [];
  const segments: ScriptSegment[] = [];
  const usedShotIds = new Set<string>();

  for (const item of rawSegments) {
    const entry = (item && typeof item === 'object' ? item : {}) as Raw;
    const shotId = str(entry.shotId);
    const narration = str(entry.narration);
    // 幻觉出来的 shotId、重复引用、空口播 —— 一律丢弃，绝不猜测模型的本意。
    if (!imageByShotId.has(shotId) || usedShotIds.has(shotId) || !narration) continue;
    usedShotIds.add(shotId);
    segments.push({
      shotId,
      imageAssetId: imageByShotId.get(shotId) as string,
      narration,
      subtitle: str(entry.subtitle) || narration,
      rationale: str(entry.rationale),
    });
  }

  if (segments.length === 0) {
    throw new Error('脚本没有产出任何画面段落（segments 为空）');
  }

  const rawDropped = Array.isArray(source.droppedShots) ? source.droppedShots : [];
  const droppedReasons = new Map<string, string>();
  for (const item of rawDropped) {
    const entry = (item && typeof item === 'object' ? item : {}) as Raw;
    const shotId = str(entry.shotId);
    if (!imageByShotId.has(shotId) || usedShotIds.has(shotId)) continue;
    droppedReasons.set(shotId, str(entry.reason) || '未说明原因');
  }
  // 模型漏提的分镜也必须落进备用池，否则成片阶段无从替补。
  const droppedShots: DroppedShot[] = shotRows
    .filter((row) => !usedShotIds.has(row.shotId))
    .map((row) => ({
      shotId: row.shotId,
      reason: droppedReasons.get(row.shotId) || '脚本未使用',
    }));

  const rawMap = Array.isArray(source.sellingPointMap) ? source.sellingPointMap : [];
  const sellingPointMap: SellingPointMapEntry[] = rawMap
    .map((item) => (item && typeof item === 'object' ? item : {}) as Raw)
    .filter((entry) => usedShotIds.has(str(entry.shotId)))
    .map((entry) => ({ shotId: str(entry.shotId), sellingPoint: str(entry.sellingPoint) }));

  const fullScript = str(source.fullScript) || segments.map((s) => s.narration).join('');
  const rawCoverTitle = source.coverTitleParts && typeof source.coverTitleParts === 'object'
    ? source.coverTitleParts as Raw
    : null;
  const coverPrimary = rawCoverTitle ? str(rawCoverTitle.primary) : '';
  const coverSecondary = rawCoverTitle ? str(rawCoverTitle.secondary) : '';

  return {
    version: 2,
    title: str(source.title) || '未命名脚本',
    ...(coverPrimary && coverSecondary
      ? { coverTitleParts: { primary: coverPrimary, secondary: coverSecondary } }
      : {}),
    platform: str(source.platform) || '通用',
    tone: str(source.tone) || '种草',
    targetDurationSec,
    template: str(source.template),
    shotSetId: str(source.shotSetId) || fallbackShotSetId,
    sellingPointMap,
    segments,
    droppedShots,
    fullScript,
  };
}
