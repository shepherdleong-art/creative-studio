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
  const groups = new Map<string, string[]>();
  for (const [assetId, key] of resolveModule4AssetGroupKeys(db, clipAssetIds(arrangement))) {
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

export function batchSourceReview(db: Database.Database, arrangement: unknown) {
  const groups = sourceConflictGroups(db, arrangement);
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
