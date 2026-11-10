import type Database from 'better-sqlite3';
import type { SubmissionEvidence } from '../media-core/submission-evidence.ts';
import { releaseUnifiedChannelRecoveryProbe } from '../media-core/unified-media/health.ts';
import type { CanvasTaskContext } from './adapters/types.ts';
import type { CanvasTaskRecord } from './tasks.ts';
import {
  CanvasUnifiedCanceledError,
  CanvasUnifiedRequeueError,
  CanvasUnifiedStaleError,
  CanvasUnifiedTerminalError,
  CanvasUnifiedWaitingError,
  activateCanvasUnifiedChannel as activateImageChannel,
  assertCanvasUnifiedSubmissionStillCurrent as assertImageSubmissionCurrent,
  currentCanvasUnifiedOperation,
  handleCanvasUnifiedCapacityDeferred as handleImageCapacityDeferred,
  handleCanvasUnifiedExplicitFailure as handleImageExplicitFailure,
  isCanvasUnifiedImageTask,
  prepareCanvasUnifiedImageExecution,
  recordCanvasUnifiedAccepted as recordImageAccepted,
  recordCanvasUnifiedCanceled as recordImageCanceled,
  recordCanvasUnifiedConfirmedNotCreated as recordImageConfirmedNotCreated,
  recordCanvasUnifiedDownloadFailure as recordImageDownloadFailure,
  recordCanvasUnifiedFinalFailure as recordImageFinalFailure,
  recordCanvasUnifiedOperation as recordImageOperation,
  recordCanvasUnifiedRemoteId as recordImageRemoteId,
  recordCanvasUnifiedSucceeded as recordImageSucceeded,
  recordCanvasUnifiedUnknown as recordImageUnknown,
  releaseCanvasUnifiedPreparation as releaseImagePreparation,
  requestCanvasUnifiedImageCancellation,
  type CanvasUnifiedExecution as CanvasUnifiedImageExecution,
  type CanvasUnifiedFailureDecision as ImageFailureDecision,
} from './unified-image.ts';
import {
  activateCanvasUnifiedKlingChannel,
  assertCanvasUnifiedKlingSubmissionStillCurrent,
  handleCanvasUnifiedKlingCapacityDeferred,
  handleCanvasUnifiedKlingExplicitFailure,
  isCanvasUnifiedKlingTask,
  prepareCanvasUnifiedKlingExecution,
  recordCanvasUnifiedKlingAccepted,
  recordCanvasUnifiedKlingCanceled,
  recordCanvasUnifiedKlingConfirmedNotCreated,
  recordCanvasUnifiedKlingDownloadFailure,
  recordCanvasUnifiedKlingFinalFailure,
  recordCanvasUnifiedKlingOperation,
  recordCanvasUnifiedKlingRemoteId,
  recordCanvasUnifiedKlingSucceeded,
  recordCanvasUnifiedKlingUnknown,
  releaseCanvasUnifiedKlingPreparation,
  requestCanvasUnifiedKlingCancellation,
  type CanvasUnifiedKlingExecution,
} from './unified-kling.ts';

export {
  CanvasUnifiedCanceledError,
  CanvasUnifiedRequeueError,
  CanvasUnifiedStaleError,
  CanvasUnifiedTerminalError,
  CanvasUnifiedWaitingError,
  currentCanvasUnifiedOperation,
};

export type CanvasUnifiedMediaExecution =
  | CanvasUnifiedImageExecution
  | CanvasUnifiedKlingExecution;

export type CanvasUnifiedMediaFailureDecision =
  | {
    outcome: 'next_channel';
    previousChannelKey: string;
    nextChannelKey: string;
  }
  | {
    outcome: 'exhausted' | 'canceled' | 'ignored';
    reason?: string;
  };

export type CanvasUnifiedMediaCapacityDecision =
  | {
    outcome: 'waiting';
    nextEligibleAt: string;
    waitDetail?: Record<string, unknown>;
  }
  | {
    outcome: 'overflowed';
    previousChannelKey: string;
    nextChannelKey: string;
  }
  | {
    outcome: 'not_capacity' | 'ignored' | 'canceled';
    reason: string;
  };

export function isCanvasUnifiedMediaTask(task: CanvasTaskRecord): boolean {
  return isCanvasUnifiedImageTask(task) || isCanvasUnifiedKlingTask(task);
}

export function prepareCanvasUnifiedMediaExecution(
  db: Database.Database,
  task: CanvasTaskRecord,
  context: CanvasTaskContext,
  options: { resuming: boolean; now?: Date },
): CanvasUnifiedMediaExecution {
  return isCanvasUnifiedKlingTask(task)
    ? prepareCanvasUnifiedKlingExecution(db, task, context, options)
    : prepareCanvasUnifiedImageExecution(db, task, context, options);
}

export function recordCanvasUnifiedOperation(
  db: Database.Database,
  execution: CanvasUnifiedMediaExecution,
  operationId: string,
): void {
  if (execution.mediaKind === 'image') recordImageOperation(db, execution, operationId);
  else recordCanvasUnifiedKlingOperation(db, execution, operationId);
}

export function activateCanvasUnifiedChannel(
  db: Database.Database,
  execution: CanvasUnifiedMediaExecution,
): void {
  if (execution.mediaKind === 'image') activateImageChannel(db, execution);
  else activateCanvasUnifiedKlingChannel(db, execution);
}

export function releaseCanvasUnifiedPreparation(
  db: Database.Database,
  execution: CanvasUnifiedMediaExecution,
): void {
  if (execution.mediaKind === 'image') releaseImagePreparation(db, execution);
  else releaseCanvasUnifiedKlingPreparation(db, execution);
}

export function assertCanvasUnifiedSubmissionStillCurrent(
  db: Database.Database,
  execution: CanvasUnifiedMediaExecution,
): void {
  if (execution.mediaKind === 'image') assertImageSubmissionCurrent(db, execution);
  else assertCanvasUnifiedKlingSubmissionStillCurrent(db, execution);
}

export function handleCanvasUnifiedCapacityDeferred(
  db: Database.Database,
  execution: CanvasUnifiedMediaExecution,
  input: { reasons: string[]; operationId: string | null; now?: Date },
): CanvasUnifiedMediaCapacityDecision {
  return execution.mediaKind === 'image'
    ? handleImageCapacityDeferred(db, execution, input)
    : handleCanvasUnifiedKlingCapacityDeferred(db, execution, input);
}

export function handleCanvasUnifiedExplicitFailure(
  db: Database.Database,
  task: CanvasTaskRecord,
  input: {
    evidence: SubmissionEvidence;
    attemptId?: string;
    operationId?: string;
    channelKey?: string | null;
  },
): CanvasUnifiedMediaFailureDecision {
  if (isCanvasUnifiedKlingTask(task)) {
    return handleCanvasUnifiedKlingExplicitFailure(db, task, input);
  }
  return handleImageExplicitFailure(db, task, input) as ImageFailureDecision;
}

export function recordCanvasUnifiedAccepted(
  db: Database.Database,
  execution: CanvasUnifiedMediaExecution,
  remoteId: string,
): void {
  if (execution.mediaKind === 'image') recordImageAccepted(db, execution, remoteId);
  else recordCanvasUnifiedKlingAccepted(db, execution, remoteId);
}

export function recordCanvasUnifiedRemoteId(
  db: Database.Database,
  task: CanvasTaskRecord,
  remoteId: string,
): void {
  if (isCanvasUnifiedKlingTask(task)) recordCanvasUnifiedKlingRemoteId(db, task, remoteId);
  else recordImageRemoteId(db, task, remoteId);
}

export function recordCanvasUnifiedConfirmedNotCreated(
  db: Database.Database,
  task: CanvasTaskRecord,
): void {
  if (isCanvasUnifiedKlingTask(task)) recordCanvasUnifiedKlingConfirmedNotCreated(db, task);
  else recordImageConfirmedNotCreated(db, task);
}

export function recordCanvasUnifiedUnknown(
  db: Database.Database,
  execution: CanvasUnifiedMediaExecution,
  evidence: SubmissionEvidence,
  remoteId: string | null,
): void {
  if (execution.mediaKind === 'image') recordImageUnknown(db, execution, evidence, remoteId);
  else recordCanvasUnifiedKlingUnknown(db, execution, evidence, remoteId);
}

export function recordCanvasUnifiedDownloadFailure(
  db: Database.Database,
  execution: CanvasUnifiedMediaExecution,
  evidence: SubmissionEvidence,
): void {
  if (execution.mediaKind === 'image') recordImageDownloadFailure(db, execution, evidence);
  else recordCanvasUnifiedKlingDownloadFailure(db, execution, evidence);
}

export function recordCanvasUnifiedSucceeded(
  db: Database.Database,
  execution: CanvasUnifiedMediaExecution,
  result: { outputAssetId: string; remoteId?: string | null },
): void {
  if (execution.mediaKind === 'image') recordImageSucceeded(db, execution, result);
  else recordCanvasUnifiedKlingSucceeded(db, execution, result);
}

export function recordCanvasUnifiedFinalFailure(
  db: Database.Database,
  execution: CanvasUnifiedMediaExecution,
  input: { code: string; message: string },
): void {
  if (execution.mediaKind === 'image') recordImageFinalFailure(db, execution, input);
  else recordCanvasUnifiedKlingFinalFailure(db, execution, input);
}

export function recordCanvasUnifiedCanceled(
  db: Database.Database,
  execution: CanvasUnifiedMediaExecution | null,
): void {
  if (!execution) return;
  if (execution.mediaKind === 'image') recordImageCanceled(db, execution);
  else recordCanvasUnifiedKlingCanceled(db, execution);
}

export function requestCanvasUnifiedMediaCancellation(
  db: Database.Database,
  task: CanvasTaskRecord,
  now = new Date(),
): void {
  if (isCanvasUnifiedKlingTask(task)) requestCanvasUnifiedKlingCancellation(db, task, now);
  else requestCanvasUnifiedImageCancellation(db, task, now);
}

/** Recovery found a persisted explicit remote failure before a worker resumed it. */
export function recordCanvasUnifiedRecoveredFailure(
  db: Database.Database,
  task: CanvasTaskRecord,
): void {
  const parent = db.prepare(`SELECT id, unifiedModel, currentChannelKey
    FROM execution_media_tasks WHERE taskKey = ?`).get(`canvas:${task.id}`) as
    | { id: string; unifiedModel: string; currentChannelKey: string | null }
    | undefined;
  if (!parent) return;
  const channel = parent.currentChannelKey
    ? db.prepare(`SELECT id, channelKey, providerId FROM execution_media_channels
        WHERE mediaTaskId = ? AND channelKey = ?`).get(parent.id, parent.currentChannelKey) as
      | { id: string; channelKey: string; providerId: string }
      | undefined
    : undefined;
  const at = new Date().toISOString();
  db.transaction(() => {
    if (channel) {
      db.prepare(`UPDATE execution_media_channels SET state = 'failed', evidenceJson = ?,
        updatedAt = ? WHERE id = ?`).run(JSON.stringify({
        kind: 'recovered_remote_terminal_failure',
        at,
      }), at, channel.id);
    }
    db.prepare(`UPDATE execution_media_tasks SET status = 'failed', resultJson = ?, updatedAt = ?
      WHERE id = ?`).run(JSON.stringify({
      taskId: task.id,
      errorCode: 'provider_failed',
      channelKey: channel?.channelKey ?? null,
    }), at, parent.id);
  }).immediate();
  if (channel) {
    releaseUnifiedChannelRecoveryProbe(db, {
      unifiedModel: parent.unifiedModel,
      channelKey: channel.channelKey,
      providerId: channel.providerId,
    });
  }
}
