import type Database from 'better-sqlite3';

interface ShotGenerationState {
  latestJobId?: string | null;
  latestGeneratedImageId?: string | null;
  jobStatus?: string | null;
}

/** 组的生成进度以当前任务为准，旧结果不能把正在重做的任务算成完成。 */
export function resolveShotSetStatus(
  set: { status: string; kind?: string },
  shots: readonly ShotGenerationState[],
): string {
  if (set.kind === 'free') return set.status;
  if (shots.some((shot) => ['pending', 'running', 'retrying', 'needs_check'].includes(shot.jobStatus ?? ''))) {
    return 'generating';
  }
  // 人工审核与视频阶段的状态不由图片完成度覆盖。
  if (['approved', 'video_ready', 'reviewing'].includes(set.status)) return set.status;
  if (shots.length > 0 && shots.every((shot) =>
    Boolean(shot.latestGeneratedImageId) && (!shot.latestJobId || shot.jobStatus === 'succeeded'),
  )) return 'completed';
  if (set.status === 'generating' || set.status === 'completed') {
    return shots.some((shot) => shot.latestJobId || shot.latestGeneratedImageId) ? 'reviewing' : 'draft';
  }
  return set.status;
}

/** 一次读取项目内各组的当前任务，列表与详情共用同一状态规则，无需改写历史数据。 */
export function readProjectShotSetStatuses(db: Database.Database, projectId: string): Map<string, string> {
  const rows = db.prepare(`
    SELECT ss.id AS shotSetId, ss.status, ss.kind, s.id AS shotId,
      s.latestJobId, s.latestGeneratedImageId, j.status AS jobStatus
    FROM shot_sets ss
    LEFT JOIN shots s ON s.shotSetId = ss.id
    LEFT JOIN jobs j ON j.id = s.latestJobId
    WHERE ss.projectId = ?
  `).all(projectId) as Array<ShotGenerationState & { shotSetId: string; shotId: string | null; status: string; kind: string }>;
  const groups = new Map<string, { status: string; kind: string; shots: ShotGenerationState[] }>();
  for (const row of rows) {
    const group = groups.get(row.shotSetId) ?? { status: row.status, kind: row.kind, shots: [] };
    if (row.shotId) group.shots.push(row);
    groups.set(row.shotSetId, group);
  }
  return new Map([...groups].map(([id, group]) => [id, resolveShotSetStatus(group, group.shots)]));
}
