import type { BatchSourceConflictGroup } from '@/lib/batch-production/source-conflicts';

interface UsageClip {
  clipId: string;
  assetId: string;
  sourceStartUs: number;
  sourceEndUs: number;
}

interface UsageFilm {
  planId: string;
  sourceConflictAssetIds?: string[];
  sourceConflictGroups?: BatchSourceConflictGroup[];
  arrangement: { clips: UsageClip[]; sourceConflictAssetIds?: string[]; sourceConflictGroups?: BatchSourceConflictGroup[] } | null;
}

export interface ReviewUsageGroup {
  key: string;
  label: string;
  colorIndex: number;
}

function alphabetLabel(index: number): string {
  let label = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    label = String.fromCharCode(65 + (n - 1) % 26) + label;
  }
  return label;
}

export interface ClipVideoUsage {
  totalUses: number;
  filmCount: number;
  usesInFilm: number;
  hasOverlap: boolean;
  hasSourceConflict: boolean;
  repeatGroup?: ReviewUsageGroup;
  sourceGroup?: ReviewUsageGroup;
}

/** 全批次当前视频片段的复用统计；不依赖选择、筛选、眼睛或组件是否挂载。 */
export function buildVideoUsage(films: UsageFilm[]) {
  const byAsset = new Map<string, Array<UsageClip & { planId: string }>>();
  const byPlan = new Map<string, Map<string, ClipVideoUsage>>();
  const sourceConflictsByPlan = new Map<string, Set<string>>();
  const sourceKeysByPlan = new Map<string, Map<string, string>>();
  const sourceGroupKeys = new Set<string>();
  for (const film of films) {
    byPlan.set(film.planId, new Map());
    sourceConflictsByPlan.set(film.planId, new Set(film.arrangement?.sourceConflictAssetIds ?? film.sourceConflictAssetIds ?? []));
    const sourceKeys = new Map<string, string>();
    // 已加载的编辑视图优先；不能从旧卡片恢复已解除的组，也不能把扁平 ID 列表猜成一个组。
    const groups = film.arrangement?.sourceConflictGroups ?? (film.arrangement?.sourceConflictAssetIds ? [] : film.sourceConflictGroups) ?? [];
    for (const group of groups) {
      sourceGroupKeys.add(group.key);
      for (const assetId of group.assetIds) sourceKeys.set(assetId, group.key);
    }
    sourceKeysByPlan.set(film.planId, sourceKeys);
    for (const clip of film.arrangement?.clips ?? []) {
      const list = byAsset.get(clip.assetId) ?? [];
      list.push({ ...clip, planId: film.planId });
      byAsset.set(clip.assetId, list);
    }
  }
  // 稳定身份排序，不受行顺序、片段顺序、选中、眼睛或筛选影响。色盘循环时编号仍唯一。
  const repeatGroups = new Map([...byAsset].filter(([, clips]) => clips.length > 1)
    .map(([assetId]) => assetId).sort().map((key, index) => [key, {
      key, label: alphabetLabel(index), colorIndex: index % 8 + 1,
    }]));
  const sourceGroups = new Map([...sourceGroupKeys].sort().map((key, index) => [key, {
    key, label: `S${index + 1}`, colorIndex: (repeatGroups.size + index) % 8 + 1,
  }]));
  let repeatedAssetCount = 0;
  let repeatedClipCount = 0;
  let overlapClipCount = 0;
  let sourceConflictClipCount = 0;
  const sourceConflictPlans = new Set<string>();
  for (const list of byAsset.values()) {
    if (list.length > 1) {
      repeatedAssetCount++;
      repeatedClipCount += list.length;
    }
    const usesByPlan = new Map<string, number>();
    for (const clip of list) usesByPlan.set(clip.planId, (usesByPlan.get(clip.planId) ?? 0) + 1);
    const overlapping = new Set<UsageClip>();
    // 比较源区间，而非时间线位置或播放时长；相邻分割端点不算重叠。
    const sorted = [...list].sort((a, b) => a.sourceStartUs - b.sourceStartUs);
    for (let i = 0; i < sorted.length; i++) {
      const a = sorted[i];
      for (let j = i + 1; j < sorted.length && sorted[j].sourceStartUs < a.sourceEndUs; j++) {
        const b = sorted[j];
        if (Math.min(a.sourceEndUs, b.sourceEndUs) > Math.max(a.sourceStartUs, b.sourceStartUs)) {
          overlapping.add(a);
          overlapping.add(b);
        }
      }
    }
    overlapClipCount += overlapping.size;
    for (const clip of list) {
      const sourceKey = sourceKeysByPlan.get(clip.planId)!.get(clip.assetId);
      const hasSourceConflict = sourceKey !== undefined || sourceConflictsByPlan.get(clip.planId)!.has(clip.assetId);
      if (hasSourceConflict) {
        sourceConflictClipCount++;
        sourceConflictPlans.add(clip.planId);
      }
      byPlan.get(clip.planId)!.set(clip.clipId, {
        totalUses: list.length,
        filmCount: usesByPlan.size,
        usesInFilm: usesByPlan.get(clip.planId)!,
        hasOverlap: overlapping.has(clip),
        hasSourceConflict,
        repeatGroup: repeatGroups.get(clip.assetId),
        sourceGroup: sourceKey === undefined ? undefined : sourceGroups.get(sourceKey),
      });
    }
  }
  return { byPlan, repeatGroups, repeatedAssetCount, repeatedClipCount, overlapClipCount, sourceConflictClipCount, sourceConflictFilmCount: sourceConflictPlans.size };
}
