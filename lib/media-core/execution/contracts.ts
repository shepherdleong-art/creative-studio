export interface ExecutionInstanceIdentity {
  instanceId: string;
  fence: number;
}

export interface ExecutionActor {
  kind: 'local' | 'team';
  actorId: string;
}

export interface ExecutionScope {
  resourceType: string;
  resourceId: string;
}

export interface ExecutionOperationKey {
  module: string;
  taskId: string;
  step: string;
  inputRevision: string;
}

export type ExecutionOperationStatus =
  | 'pending'
  | 'admitted'
  | 'deferred'
  | 'maybe_sent'
  | 'submitted'
  | 'reconciling'
  | 'succeeded'
  | 'failed'
  | 'unknown';

export interface ExecutionOperation extends ExecutionInstanceIdentity {
  operationKey: ExecutionOperationKey;
  actor: ExecutionActor;
  scope: ExecutionScope;
  status: ExecutionOperationStatus;
  inputFingerprint: string;
}

export type ExecutionAttemptStatus = 'preparing' | 'maybe_sent' | 'submitted' | 'settled' | 'unknown';

export interface ExecutionAttempt {
  attemptId: string;
  operationKey: ExecutionOperationKey;
  transportSequence: number;
  status: ExecutionAttemptStatus;
  remoteId?: string;
}

export interface ExecutionPoolReservation extends ExecutionInstanceIdentity {
  reservationId: string;
  poolId: string;
  operationKey: ExecutionOperationKey;
  category: 'upload' | 'remote_generation' | 'download' | 'media';
  remoteInFlight: boolean;
}

export interface ExecutionModuleContext extends ExecutionInstanceIdentity {
  deploymentId: string;
  signal: AbortSignal;
}

export interface ExecutionModuleLifecycle {
  readonly name: string;
  ensureSchemaReady(): Promise<void> | void;
  registerRecovery(context: ExecutionModuleContext): Promise<void> | void;
  recover(context: ExecutionModuleContext): Promise<void> | void;
  start(context: ExecutionModuleContext): Promise<void> | void;
  drain?(context: ExecutionModuleContext): Promise<number> | number;
}

export function assertExecutionFence(
  expected: ExecutionInstanceIdentity,
  actual: ExecutionInstanceIdentity,
): void {
  if (expected.instanceId !== actual.instanceId || expected.fence !== actual.fence) {
    throw new Error('执行 instance/fence 已变化，拒绝迟到写回');
  }
}
