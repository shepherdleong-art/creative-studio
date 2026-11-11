import type Database from 'better-sqlite3';
import {
  CANCEL_BEFORE_SEND_MESSAGE,
  CANCEL_SETTLING_MESSAGE,
} from './media-core/unified-media/cancel-intent.ts';

/** Persist cancellation while allowing submitted legacy work to settle. */
export interface LegacyMediaCancelResult {
  status: string;
  acceptedSubmittedWork: boolean;
  idempotent: boolean;
}

const VIDEO_ACTIVE_STATUSES = "('pending', 'running', 'needs_check', 'deferred')";

/**
 * 取消一条老通道视频任务。
 *
 * - 提交在途、已有远端身份（task_id）或已拿到结果：只写取消意图，保持当前状态，由队列继续收尾；
 * - 尚未受理：立即 `canceled` 并写取消意图（调用方还需把执行记录结算为 stage_canceled）；
 * - 已是终态或已记录过意图：幂等返回，不重复写入。
 */
export function applyLegacyVideoJobCancel(
  db: Database.Database,
  jobId: string,
  now = new Date(),
): LegacyMediaCancelResult | null {
  const job = db.prepare(`SELECT id, status, providerTaskId, providerStatus,
      remoteVideoUrl, localVideoPath, filename, cancelRequestedAt, executionRevision
    FROM video_jobs WHERE id = ?`).get(jobId) as {
      id: string; status: string; providerTaskId: string | null; providerStatus: string | null;
      remoteVideoUrl: string | null; localVideoPath: string | null; filename: string | null;
      cancelRequestedAt: string | null; executionRevision: number;
    } | undefined;
  if (!job) return null;

  if (['succeeded', 'failed', 'canceled'].includes(job.status)) {
    return { status: job.status, acceptedSubmittedWork: false, idempotent: true };
  }

  // A POST can be in flight before its remote ID reaches the business row.
  const hasExecutionTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'execution_operations'")
    .get();
  const submittedAttempt = hasExecutionTable && db.prepare(`SELECT 1 FROM execution_operations o
    JOIN execution_attempts a ON a.id = o.currentAttemptId
    WHERE o.module = 'video' AND o.taskId = ? AND o.inputRevision = ?
      AND a.submissionState IN ('maybe_sent', 'accepted', 'terminal')
      AND COALESCE(a.terminalState, '') <> 'not_created'`).get(jobId, `r${job.executionRevision ?? 0}`);
  const acceptedSubmittedWork = Boolean(
    submittedAttempt || job.providerTaskId
    || job.localVideoPath
    || job.filename
    || (job.providerStatus === 'download_failed' && job.remoteVideoUrl),
  );
  if (job.cancelRequestedAt) {
    return { status: job.status, acceptedSubmittedWork, idempotent: true };
  }

  const at = now.toISOString();
  if (acceptedSubmittedWork) {
    // 保持 status（running/needs_check）不变：轮询循环据此继续只读查询，
    // 远端终态到来时再由队列结算执行记录并保存结果。
    db.prepare(`UPDATE video_jobs SET cancelRequestedAt = COALESCE(cancelRequestedAt, ?),
      errorMessage = ?, finishedAt = NULL
      WHERE id = ? AND status IN ${VIDEO_ACTIVE_STATUSES}`).run(at, CANCEL_SETTLING_MESSAGE, jobId);
    return { status: job.status, acceptedSubmittedWork: true, idempotent: false };
  }

  db.prepare(`UPDATE video_jobs SET status = 'canceled',
    cancelRequestedAt = COALESCE(cancelRequestedAt, ?), errorMessage = ?,
    finishedAt = COALESCE(finishedAt, ?)
    WHERE id = ? AND status IN ${VIDEO_ACTIVE_STATUSES}`).run(
    at, CANCEL_BEFORE_SEND_MESSAGE, at, jobId,
  );
  return { status: 'canceled', acceptedSubmittedWork: false, idempotent: false };
}

/** Apply the same cancellation contract to every active legacy job. */
export function applyLegacyVideoQueueCancelIntents(
  db: Database.Database,
  projectId: string,
  now = new Date(),
): number {
  const rows = db.prepare(`SELECT id FROM video_jobs
    WHERE projectId = ? AND status IN ${VIDEO_ACTIVE_STATUSES}
      AND unifiedModel IS NULL AND cancelRequestedAt IS NULL`)
    .all(projectId) as Array<{ id: string }>;
  let changed = 0;
  for (const row of rows) {
    const result = applyLegacyVideoJobCancel(db, row.id, now);
    if (result && !result.idempotent) changed += 1;
  }
  return changed;
}

/**
 * 启动时修复历史孤儿：业务行已取消、却没有写取消意图的老通道任务。
 *
 * 这类行是旧版本取消路径留下的：执行记录停在 `accepted`，队列既不会续跑也不会补抓。
 * 补写取消意图后，队列的续跑领取条件（`canceled` + 意图非空 + 远端身份非终态）
 * 才能把它们捞回来收口。只处理仍有远端身份的活任务，已终态的不动。
 */
export function repairLegacyCanceledMediaJobs(
  db: Database.Database,
  now = new Date(),
): { video: number; image: number } {
  const at = now.toISOString();

  const video = db.prepare(`UPDATE video_jobs SET
      cancelRequestedAt = COALESCE(finishedAt, ?),
      errorMessage = ?, finishedAt = NULL
    WHERE unifiedModel IS NULL AND status = 'canceled' AND cancelRequestedAt IS NULL
      AND (providerTaskId IS NOT NULL
        OR (providerStatus = 'download_failed' AND remoteVideoUrl IS NOT NULL))
      AND COALESCE(providerStatus, '') NOT IN ('succeeded', 'failed', 'not_created')`)
    .run(at, CANCEL_SETTLING_MESSAGE).changes;

  const image = db.prepare(`UPDATE jobs SET
      cancelRequestedAt = COALESCE(finishedAt, ?),
      errorMessage = ?, finishedAt = NULL
    WHERE unifiedModel IS NULL AND status = 'canceled' AND cancelRequestedAt IS NULL
      AND (providerTaskId IS NOT NULL
        OR (providerStatus = 'download_failed' AND remoteImageUrl IS NOT NULL))
      AND COALESCE(providerStatus, '') NOT IN ('succeeded', 'failed', 'not_created')`)
    .run(at, CANCEL_SETTLING_MESSAGE).changes;

  return { video, image };
}
