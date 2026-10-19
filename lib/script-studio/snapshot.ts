import type { TaskView } from './tasks.ts';
import type { ScriptStudioTaskSnapshot } from './types.ts';

export function toTaskSnapshot(task: TaskView): ScriptStudioTaskSnapshot {
  let inputSnapshot: Record<string, unknown> = {};
  try {
    inputSnapshot = JSON.parse(task.inputSnapshotJson || '{}') as Record<string, unknown>;
  } catch {
    inputSnapshot = {};
  }
  return {
    id: task.id,
    projectId: task.projectId,
    requestKey: task.requestKey,
    mode: task.mode,
    status: task.status,
    currentStage: task.currentStage,
    errorCode: task.errorCode,
    errorMessage: task.errorMessage,
    requestedCount: task.requestedCount,
    succeededCount: task.succeededCount,
    failedCount: task.failedCount,
    startedAt: task.createdAt,
    updatedAt: task.updatedAt,
    inputSnapshot,
    parentTaskId: task.parentTaskId,
    libraryRevisionId: task.libraryRevisionId,
    stages: task.stages.map((stage) => {
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(stage.payloadJson || '{}') as Record<string, unknown>;
      } catch {
        payload = {};
      }
      return {
        seq: stage.seq,
        stage: stage.stage,
        status: stage.status,
        payload,
        startedAt: stage.startedAt,
        finishedAt: stage.finishedAt,
        errorCode: stage.errorCode,
      };
    }),
  };
}
