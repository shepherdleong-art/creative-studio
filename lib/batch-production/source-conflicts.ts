import type Database from 'better-sqlite3';
import { resolveModule4AssetGroupKeys } from './media-catalog.ts';

function clipAssetIds(arrangement: unknown): string[] {
  if (!arrangement || typeof arrangement !== 'object') return [];
  const clips = (arrangement as { clips?: unknown }).clips;
  if (!Array.isArray(clips)) return [];
  return [...new Set(clips.flatMap(clip => (
    clip && typeof clip.assetId === 'string' ? [clip.assetId] : []
  )))];
}

export interface BatchSourceConflictGroup {
  key: string;
  assetIds: string[];
}

/** 保留权威原图身份，使不同成片内的同源组也能使用一致的视觉编号。 */
function sourceConflictGroups(db: Database.Database, arrangement: unknown): BatchSourceConflictGroup[] {
  return sourceConflictGroupsFromKeys(resolveModule4AssetGroupKeys(db, clipAssetIds(arrangement)), arrangement);
}

/**
 * 用已预加载的 assetId → 权威组键映射按卡过滤。遍历顺序仍沿用映射本身
 * (来源行 createdAt/id 顺序),保证组内 assetIds 与逐卡查询一致。
 */
function sourceConflictGroupsFromKeys(
  keys: ReadonlyMap<string, string>,
  arrangement: unknown,
): BatchSourceConflictGroup[] {
  const cardAssetIds = new Set(clipAssetIds(arrangement));
  const groups = new Map<string, string[]>();
  for (const [assetId, key] of keys) {
    if (!cardAssetIds.has(assetId)) continue;
    const assets = groups.get(key) ?? [];
    assets.push(assetId);
    groups.set(key, assets);
  }
  return [...groups].filter(([, assets]) => assets.length > 1).map(([key, assetIds]) => ({ key, assetIds }));
}

/** 只检查画面，不计封面；同一视频的分割/不同截取仍是一个视频版本。 */
export function batchSourceConflicts(db: Database.Database, arrangement: unknown): string[][] {
  return sourceConflictGroups(db, arrangement).map(group => group.assetIds);
}

export function batchSourceReview(
  db: Database.Database,
  arrangement: unknown,
  /** 可选:批次级预计算的权威组键(见 resolveModule4AssetGroupKeys),不传则逐条查询。 */
  precomputedGroupKeys?: ReadonlyMap<string, string>,
) {
  const groups = precomputedGroupKeys
    ? sourceConflictGroupsFromKeys(precomputedGroupKeys, arrangement)
    : sourceConflictGroups(db, arrangement);
  const sourceConflictAssetIds = [...new Set(groups.flatMap(group => group.assetIds))];
  const result: string[] = [];
  if (sourceConflictAssetIds.length) {
    result.push('本条成片含同源图生成的不同视频，运镜不同但表达可能重复，建议更换画面；仍可确认和导出');
  }
  return { sourceWarnings: result, sourceConflictAssetIds, sourceConflictGroups: groups };
}

export function batchSourceWarnings(db: Database.Database, arrangement: unknown): string[] {
  return batchSourceReview(db, arrangement).sourceWarnings;
}
