import type Database from 'better-sqlite3';
import { resolveFullRenderContractHash } from './cover-contract.ts';
import { parseRenderTaskRequestKey } from './render-task-key.ts';

/**
 * 正式成片新鲜度:一对正式视频/封面 artifact 是否仍然对应当前编辑方案。
 *
 * 工作区(镜像展示)与导出编排(幂等判断)共用同一函数,避免两处各写一套
 * "差不多"的比较。判断只使用数据库里已有的事实:
 * - 新任务:requestKey 携带完整渲染契约哈希,直接与当前契约比对;
 * - 旧任务(无契约):回落到编辑修订号 + 封面时间点比对(老批次兼容)。
 *
 * 没有任何成功渲染结果能对上这份 artifact 的指纹时,视为已过期。
 */
export function isFormalArtifactOutdated(
  db: Database.Database,
  projectId: string,
  batchId: string,
  outputVersionId: string,
  artifacts: {
    video: { outputVersionId: string; checksum: string };
    cover: { outputVersionId: string; checksum: string } | null;
  },
): boolean {
  if (
    artifacts.video.outputVersionId !== outputVersionId
    || !artifacts.cover
    || artifacts.cover.outputVersionId !== outputVersionId
  ) return true;
  // 找到真正被复制成这对正式产物的成功完整渲染：视频、封面两份指纹
  // 必须同时命中。只认视频会让缺失/错配封面仍被误报为已导出。
  const publishingAttempt = db.prepare(`
    SELECT t.requestKey AS requestKey, a.resultJson AS resultJson
    FROM batch_tasks t
    JOIN batch_task_attempts a ON a.taskId = t.id AND a.status = 'succeeded'
    WHERE t.projectId = ? AND t.batchId = ? AND t.workType = 'render'
      AND t.targetKind = 'output_version' AND t.targetId = ?
      AND json_extract(a.resultJson, '$.videoChecksum') = ?
      AND json_extract(a.resultJson, '$.coverChecksum') = ?
    ORDER BY a.finishedAt DESC, a.id DESC LIMIT 1
  `).get(
    projectId,
    batchId,
    outputVersionId,
    artifacts.video.checksum,
    artifacts.cover.checksum,
  ) as {
    requestKey: string | null;
    resultJson: string | null;
  } | undefined;
  if (!publishingAttempt) return true;
  // 新任务 requestKey 携带完整渲染契约哈希,可直接与当前契约比对。
  const taskKey = parseRenderTaskRequestKey(publishingAttempt.requestKey);
  if (taskKey) {
    if (taskKey.kind !== 'full' || taskKey.outputVersionId !== outputVersionId) return true;
    try {
      return taskKey.contractHash !== resolveFullRenderContractHash(db, outputVersionId);
    } catch {
      return true;
    }
  }
  // 旧任务没有契约哈希:只能靠「修订号 + 封面时间点」比对(老批次兼容)。
  // 证据不足绝不靠猜:任一事实缺失或损坏都判为已过期(保守),宁可多渲染
  // 一次也不把无法证明新鲜的 artifact 当最新播放。
  const result = parseJsonRecord(publishingAttempt.resultJson);
  const resultRevisionRaw = result.editRevision;
  const resultRevision = typeof resultRevisionRaw === 'number'
    && Number.isSafeInteger(resultRevisionRaw)
    && resultRevisionRaw >= 0
    ? resultRevisionRaw
    : null;
  const resultCoverUsRaw = result.coverTimeUs;
  const resultCoverUs = typeof resultCoverUsRaw === 'number'
    && Number.isSafeInteger(resultCoverUsRaw)
    && resultCoverUsRaw >= -1
    ? resultCoverUsRaw
    : null;
  if (resultRevision === null || resultCoverUs === null) return true;
  const current = readCurrentArrangementFacts(db, outputVersionId);
  if (!current) return true;
  if (current.editRevision < 0 || current.coverTimeUs < -1) return true;
  return resultRevision !== current.editRevision || resultCoverUs !== current.coverTimeUs;
}

function parseJsonRecord(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function readCurrentArrangementFacts(
  db: Database.Database,
  outputVersionId: string,
): { editRevision: number; coverTimeUs: number } | null {
  const row = db.prepare(`
    SELECT arrangementJson FROM batch_output_versions WHERE id = ?
  `).get(outputVersionId) as { arrangementJson: string | null } | undefined;
  if (!row?.arrangementJson) return null;
  try {
    const arrangement = JSON.parse(row.arrangementJson) as {
      editRevision?: unknown;
      cover?: { timeUs?: unknown };
    };
    const rawRevision = arrangement.editRevision;
    const editRevision = rawRevision === undefined
      ? 0
      : typeof rawRevision === 'number' && Number.isSafeInteger(rawRevision) && rawRevision >= 0
        ? rawRevision
        : -1;
    const rawCover = arrangement.cover?.timeUs;
    const coverTimeUs = typeof rawCover === 'number' && Number.isSafeInteger(rawCover) && rawCover >= 0
      ? rawCover
      : -1;
    return { editRevision, coverTimeUs };
  } catch {
    return null;
  }
}
