import { createHash } from 'node:crypto';
import { requireAccessContext } from '../access-context.ts';
import { registerExecutionContinuation } from './module-adapters.ts';
import { getExecutionModuleRuntime } from './module-runtime.ts';
import type {
  CostQuote,
  ExecutionFacade,
  ExecutionGrant,
  ExecutionReceipt,
  Money,
} from './context.ts';

export interface SyncOperationContext {
  module?: string;
  taskId: string;
  step: string;
  inputRevision?: string;
  businessAttempt?: { id: string; number: number };
  scope: { resourceType: string; resourceId: string };
  requiredPools?: readonly string[];
}

export interface SyncOperationTransport {
  facade: ExecutionFacade;
  grant: ExecutionGrant;
  submittingStarted?: boolean;
}

export interface SyncOperationOutcome<T> {
  value?: T;
  terminalState: 'succeeded' | 'failed';
  result?: unknown;
  actualCost?: Money | null;
  errorCode?: string;
}

export class MediaExecutionDeferredError extends Error {
  readonly code = 'llm_execution_deferred';
  readonly operationId: string;
  readonly waitReason: string | null;
  constructor(operationId: string, waitReason: string | null) {
    super('媒体调用正在等待统一执行名额');
    this.name = 'MediaExecutionDeferredError';
    this.operationId = operationId;
    this.waitReason = waitReason;
  }
}

export class MediaExecutionUnknownError extends Error {
  readonly code = 'media_execution_unknown';
  constructor() {
    super('媒体调用结果尚未核清，未自动重提');
    this.name = 'MediaExecutionUnknownError';
  }
}

export class MediaExecutionFailedError extends Error {
  readonly code = 'media_execution_failed';
  readonly details?: unknown;
  constructor(message = '媒体调用已明确失败', details?: unknown) {
    super(message);
    this.name = 'MediaExecutionFailedError';
    this.details = details;
  }
}

export async function transmitSyncOperation<T>(
  transport: SyncOperationTransport,
  input: {
    requestSnapshot: unknown;
    send: () => Promise<SyncOperationOutcome<T>>;
  },
): Promise<T> {
  const intent = await transport.facade.markSubmitting({
    grant: transport.grant,
    requestSnapshot: input.requestSnapshot,
  });
  transport.submittingStarted = true;
  let outcome: SyncOperationOutcome<T> | undefined;
  await transport.facade.transmit(intent, async (): Promise<ExecutionReceipt> => {
    outcome = await input.send();
    return {
      terminalState: outcome.terminalState,
      actualCost: outcome.actualCost ?? null,
      errorCode: outcome.errorCode,
    };
  });
  if (!outcome) throw new MediaExecutionUnknownError();
  const completed = outcome as SyncOperationOutcome<T>;
  await transport.facade.settle({
    attemptId: intent.attemptId,
    outcome: completed.terminalState,
    actualCost: completed.actualCost ?? null,
    remoteTerminal: true,
    result: completed.terminalState === 'failed' ? completed.value ?? completed.result : completed.result,
    errorCode: completed.errorCode,
  });
  if (completed.terminalState === 'failed') throw new MediaExecutionFailedError('媒体调用已明确失败', completed.value);
  return completed.value as T;
}

export function registerSyncOperationContinuation(
  key: string,
  handler: (transport: SyncOperationTransport, snapshot: unknown) => Promise<unknown>,
): void {
  registerExecutionContinuation(key, async (grant, facade) => {
    await handler({ facade, grant }, grant.inputSnapshot);
  });
}

export async function executeSyncOperation<T>(input: {
  context: SyncOperationContext;
  inputSnapshot: unknown;
  continuationKey: string;
  providerSnapshot: unknown;
  configVersion?: string;
  credentialVersionRef?: string;
  quote: CostQuote;
  replay: (result: unknown) => T;
  execute: (transport: SyncOperationTransport, snapshot: unknown) => Promise<T>;
}): Promise<T> {
  const runtime = getExecutionModuleRuntime();
  if (!runtime) throw new Error('executeSyncOperation 仅在 server execution runtime 使用');
  const { context } = input;
  if (!context.taskId.trim() || !context.step.trim() || !context.scope.resourceId.trim()) {
    throw new Error('server 媒体调用缺少稳定执行上下文');
  }
  const access = requireAccessContext();
  if (access.kind !== 'team') throw new Error('server 媒体调用缺少团队发起人上下文');
  const moduleName = context.module ?? 'media';
  const inputRevision = context.inputRevision ?? 'r1';
  const operationKey = `${moduleName}/${context.taskId}/${context.step}/${inputRevision}`;
  const inputHash = createHash('sha256').update(JSON.stringify({
    inputSnapshot: input.inputSnapshot,
    context,
  })).digest('hex');
  const businessAttempt = context.businessAttempt ?? { id: `${context.taskId}:${context.step}`, number: 1 };
  const enqueue = () => runtime.facade.enqueue({
    operationKey,
    actor: { userId: access.actor.userId },
    scope: context.scope,
    module: moduleName,
    taskId: context.taskId,
    step: context.step,
    inputRevision,
    businessAttempt,
    inputSnapshot: input.inputSnapshot,
    inputHash,
    continuationKey: input.continuationKey,
    providerSnapshot: input.providerSnapshot,
    configVersion: input.configVersion,
    credentialVersionRef: input.credentialVersionRef,
    requiredPools: context.requiredPools ?? ['media:remote'],
    quote: input.quote,
  });
  let operation = enqueue().operation;
  for (;;) {
    if (operation.status === 'succeeded') return input.replay(operation.result);
    if (operation.status === 'failed') throw new MediaExecutionFailedError('媒体调用已明确失败', operation.result);
    if (['unknown', 'reconciling'].includes(operation.status)) throw new MediaExecutionUnknownError();
    if (['admitted', 'maybe_sent', 'accepted'].includes(operation.status)) {
      throw new MediaExecutionDeferredError(operation.id, 'inflight');
    }
    const admitted = runtime.facade.admit({
      instanceId: runtime.instanceId,
      fence: runtime.fence,
      operationId: operation.id,
    });
    if (admitted.kind !== 'admitted') {
      throw new MediaExecutionDeferredError(operation.id, operation.waitReason);
    }
    const transport: SyncOperationTransport = { facade: runtime.facade, grant: admitted.grant };
    try {
      return await input.execute(transport, admitted.grant.inputSnapshot);
    } catch (error) {
      if (!transport.submittingStarted) {
        await runtime.facade.settle({
          attemptId: admitted.grant.attempt.id,
          outcome: 'not_created',
          actualCost: null,
          remoteTerminal: true,
          errorCode: 'preflight_failed',
        });
      }
      operation = enqueue().operation;
      if (['unknown', 'reconciling', 'admitted', 'maybe_sent', 'accepted'].includes(operation.status)) {
        throw new MediaExecutionUnknownError();
      }
      throw error;
    }
  }
}
