import type Database from 'better-sqlite3';
import { requestUnifiedImageCancellation } from './execution.ts';
import { requestUnifiedKlingCancellation } from './video-execution.ts';

export const CANCEL_SETTLING_MESSAGE =
  '已停止后续生成；已提交任务仍在收尾，晚到结果会保留在任务记录。';
export const CANCEL_BEFORE_SEND_MESSAGE =
  '已停止后续生成，未发起新的付费提交。';

export interface UnifiedMediaCancelResult {
  status: string;
  acceptedSubmittedWork: boolean;
  idempotent: boolean;
}

/**
 * Persist a cancel intent at the business-task level. Accepted work keeps its
 * current status so the queue can continue querying and retain a late result.
 */
export function applyUnifiedImageJobCancel(
  db: Database.Database,
  jobId: string,
  now = new Date(),
): UnifiedMediaCancelResult | null {
  const job = db.prepare(`SELECT id, status, unifiedModel, providerTaskId, providerStatus,
      remoteImageUrl, outputImageId, cancelRequestedAt
    FROM jobs WHERE id = ?`).get(jobId) as {
      id: string; status: string; unifiedModel: string | null; providerTaskId: string | null;
      providerStatus: string | null; remoteImageUrl: string | null; outputImageId: string | null;
      cancelRequestedAt: string | null;
    } | undefined;
  if (!job) return null;
  if (!job.unifiedModel) throw new Error('old_media_cancel_contract');

  if (['succeeded', 'failed', 'canceled'].includes(job.status)) {
    return { status: job.status, acceptedSubmittedWork: false, idempotent: true };
  }
  const at = now.toISOString();
  const acceptedSubmittedWork = Boolean(job.providerTaskId
    || job.outputImageId
    || (job.providerStatus === 'download_failed' && job.remoteImageUrl));
  if (job.cancelRequestedAt) {
    return { status: job.status, acceptedSubmittedWork, idempotent: true };
  }
  requestUnifiedImageCancellation(db, jobId);
  const imageDownloadOnly = job.providerStatus === 'download_failed' && Boolean(job.remoteImageUrl);
  if (acceptedSubmittedWork && !job.providerTaskId && !imageDownloadOnly) {
    db.prepare(`UPDATE jobs SET status = 'canceled', cancelRequestedAt = COALESCE(cancelRequestedAt, ?),
      errorMessage = ?, finishedAt = COALESCE(finishedAt, ?) WHERE id = ?`).run(
      at, CANCEL_SETTLING_MESSAGE, at, jobId,
    );
    return { status: 'canceled', acceptedSubmittedWork: true, idempotent: false };
  }
  if (acceptedSubmittedWork) {
    db.prepare(`UPDATE jobs SET cancelRequestedAt = COALESCE(cancelRequestedAt, ?),
      errorMessage = ?, finishedAt = NULL WHERE id = ?`).run(
      at, CANCEL_SETTLING_MESSAGE, jobId,
    );
    return { status: job.status, acceptedSubmittedWork: true, idempotent: false };
  }
  db.prepare(`UPDATE jobs SET status = 'canceled',
    cancelRequestedAt = COALESCE(cancelRequestedAt, ?), errorMessage = ?,
    finishedAt = COALESCE(finishedAt, ?)
    WHERE id = ? AND status IN ('pending', 'retrying', 'running', 'deferred', 'needs_check')`).run(
    at, CANCEL_BEFORE_SEND_MESSAGE, at, jobId,
  );
  return { status: 'canceled', acceptedSubmittedWork: false, idempotent: false };
}

export function applyUnifiedKlingJobCancel(
  db: Database.Database,
  jobId: string,
  now = new Date(),
): UnifiedMediaCancelResult | null {
  const job = db.prepare(`SELECT id, status, unifiedModel, providerTaskId, providerStatus,
      remoteVideoUrl, localVideoPath, filename, cancelRequestedAt
    FROM video_jobs WHERE id = ?`).get(jobId) as {
      id: string; status: string; unifiedModel: string | null; providerTaskId: string | null;
      providerStatus: string | null; remoteVideoUrl: string | null;
      localVideoPath: string | null; filename: string | null;
      cancelRequestedAt: string | null;
    } | undefined;
  if (!job) return null;
  if (!job.unifiedModel) throw new Error('old_media_cancel_contract');

  if (['succeeded', 'failed', 'canceled'].includes(job.status)) {
    return { status: job.status, acceptedSubmittedWork: false, idempotent: true };
  }
  const at = now.toISOString();
  const acceptedSubmittedWork = Boolean(job.providerTaskId
    || job.localVideoPath
    || job.filename
    || (job.providerStatus === 'download_failed' && job.remoteVideoUrl));
  if (job.cancelRequestedAt) {
    return { status: job.status, acceptedSubmittedWork, idempotent: true };
  }
  requestUnifiedKlingCancellation(db, jobId);
  const videoDownloadOnly = job.providerStatus === 'download_failed' && Boolean(job.remoteVideoUrl);
  if (acceptedSubmittedWork && !job.providerTaskId && !videoDownloadOnly) {
    db.prepare(`UPDATE video_jobs SET status = 'canceled', cancelRequestedAt = COALESCE(cancelRequestedAt, ?),
      errorMessage = ?, finishedAt = COALESCE(finishedAt, ?) WHERE id = ?`).run(
      at, CANCEL_SETTLING_MESSAGE, at, jobId,
    );
    return { status: 'canceled', acceptedSubmittedWork: true, idempotent: false };
  }
  if (acceptedSubmittedWork) {
    db.prepare(`UPDATE video_jobs SET cancelRequestedAt = COALESCE(cancelRequestedAt, ?),
      errorMessage = ?, finishedAt = NULL WHERE id = ?`).run(
      at, CANCEL_SETTLING_MESSAGE, jobId,
    );
    return { status: job.status, acceptedSubmittedWork: true, idempotent: false };
  }
  db.prepare(`UPDATE video_jobs SET status = 'canceled',
    cancelRequestedAt = COALESCE(cancelRequestedAt, ?), errorMessage = ?,
    finishedAt = COALESCE(finishedAt, ?)
    WHERE id = ? AND status IN ('pending', 'retrying', 'running', 'deferred', 'needs_check')`).run(
    at, CANCEL_BEFORE_SEND_MESSAGE, at, jobId,
  );
  return { status: 'canceled', acceptedSubmittedWork: false, idempotent: false };
}
