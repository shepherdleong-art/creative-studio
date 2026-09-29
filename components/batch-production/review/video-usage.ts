interface UsageClip {
  clipId: string;
  assetId: string;
  sourceStartUs: number;
  sourceEndUs: number;
}

interface UsageFilm {
  planId: string;
  arrangement: { clips: UsageClip[] } | null;
}

export interface ClipVideoUsage {
  totalUses: number;
  filmCount: number;
  usesInFilm: number;
  hasOverlap: boolean;
}

/** 全批次当前视频片段的复用统计；不依赖选择、筛选、眼睛或组件是否挂载。 */
export function buildVideoUsage(films: UsageFilm[]) {
  const byAsset = new Map<string, Array<UsageClip & { planId: string }>>();
  const byPlan = new Map<string, Map<string, ClipVideoUsage>>();
  for (const film of films) {
    byPlan.set(film.planId, new Map());
    for (const clip of film.arrangement?.clips ?? []) {
      const list = byAsset.get(clip.assetId) ?? [];
      list.push({ ...clip, planId: film.planId });
      byAsset.set(clip.assetId, list);
    }
  }
  let repeatedAssetCount = 0;
  let repeatedClipCount = 0;
  let overlapClipCount = 0;
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
      byPlan.get(clip.planId)!.set(clip.clipId, {
        totalUses: list.length,
        filmCount: usesByPlan.size,
        usesInFilm: usesByPlan.get(clip.planId)!,
        hasOverlap: overlapping.has(clip),
      });
    }
  }
  return { byPlan, repeatedAssetCount, repeatedClipCount, overlapClipCount };
}
