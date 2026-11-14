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

/**
 * 批次级预计算的同源上下文:权威组键 + 映射插入序号。
 * 每张卡只遍历自己的 clip assetId,按批次映射顺序恢复组与组内 assetIds 顺序。
 */
export interface BatchSourceConflictPreload {
  groupKeys: ReadonlyMap<string, string>;
  ordinals: ReadonlyMap<string, number>;
}

export function prepareSourceConflictPreload(
  keys: ReadonlyMap<string, string>,
): BatchSourceConflictPreload {
  const ordinals = new Map<string, number>();
  let ordinal = 0;
  for (const assetId of keys.keys()) ordinals.set(assetId, ordinal++);
  return { groupKeys: keys, ordinals };
}

/** 保留权威原图身份，使不同成片内的同源组也能使用一致的视觉编号。 */
function sourceConflictGroups(db: Database.Database, arrangement: unknown): BatchSourceConflictGroup[] {
  return sourceConflictGroupsFromPreload(
    prepareSourceConflictPreload(resolveModule4AssetGroupKeys(db, clipAssetIds(arrangement))),
    arrangement,
  );
}

/**
 * 用已预加载的 assetId → 组键映射按卡过滤。只遍历本卡的 clip assetId,
 * 按批次映射的插入序号排序,保证组顺序与组内 assetIds 顺序和旧逐卡查询一致。
 */
function sourceConflictGroupsFromPreload(
  preload: BatchSourceConflictPreload,
  arrangement: unknown,
): BatchSourceConflictGroup[] {
  const ordered = clipAssetIds(arrangement)
    .map((assetId) => ({ assetId, ordinal: preload.ordinals.get(assetId) }))
    .filter((entry): entry is { assetId: string; ordinal: number } => entry.ordinal !== undefined)
    .sort((left, right) => left.ordinal - right.ordinal);
  const groups = new Map<string, string[]>();
  for (const { assetId } of ordered) {
    const key = preload.groupKeys.get(assetId);
    if (key === undefined) continue;
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
  /** 可选:批次级预计算的权威组键与顺序(见 prepareSourceConflictPreload),不传则逐条查询。 */
  precomputed?: BatchSourceConflictPreload,
) {
  const groups = precomputed
    ? sourceConflictGroupsFromPreload(precomputed, arrangement)
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
