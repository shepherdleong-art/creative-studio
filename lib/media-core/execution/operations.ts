import { randomUUID } from 'node:crypto';
import {
  assertExecutionContext,
  assertMoney,
  ExecutionError,
  currentExecutionClientVersion,
  type EnqueueInput,
  type EnqueueResult,
  type ExecutionFacadeOptions,
  type ExecutionRuntime,
} from './context.ts';
import { mapOperation } from './records.ts';
import { admitOperation } from './admission.ts';
import { attachReceipt, markSubmitting, settleAttempt, transmitAttempt } from './attempts.ts';
import { reconcileAttempt, recoverExecution } from './reconciliation.ts';

function json(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new ExecutionError('invalid_input', '执行快照必须可序列化。');
  return serialized;
}

function required(value: string, name: string): string {
  if (!value.trim()) throw new ExecutionError('invalid_input', `${name} 不能为空。`);
  return value;
}

function validateInput(input: EnqueueInput): void {
  for (const [name, value] of Object.entries({
    operationKey: input.operationKey, module: input.module, taskId: input.taskId,
    step: input.step, inputRevision: input.inputRevision, inputHash: input.inputHash,
    continuationKey: input.continuationKey, actor: input.actor.userId,
    scopeType: input.scope.resourceType, scopeId: input.scope.resourceId,
    businessAttemptId: input.businessAttempt.id,
  })) required(value, name);
  const expected = `${input.module}/${input.taskId}/${input.step}/${input.inputRevision}`;
  if (input.operationKey !== expected) {
    throw new ExecutionError('invalid_input', `operationKey 必须为 ${expected}。`);
  }
  if (!Number.isSafeInteger(input.businessAttempt.number) || input.businessAttempt.number <= 0) {
    throw new ExecutionError('invalid_input', 'businessAttempt.number 必须是正整数。');
  }
  if (input.requiredPools.length === 0 || input.requiredPools.some((pool) => !pool.trim())) {
    throw new ExecutionError('pool_missing', '执行操作必须声明受控资源池。');
  }
  if (new Set(input.requiredPools).size !== input.requiredPools.length) {
    throw new ExecutionError('invalid_input', 'requiredPools 不得重复。');
  }
  if (input.quote.kind === 'priced') assertMoney(input.quote.reserve);
  if ((input.mediaTaskId?.trim() || null) !== null && !input.channelKey?.trim()) {
    throw new ExecutionError('invalid_input', '统一媒体操作必须同时提供 mediaTaskId 与 channelKey。');
  }
  if (input.channelKey?.trim() && !input.mediaTaskId?.trim()) {
    throw new ExecutionError('invalid_input', '统一媒体操作必须同时提供 mediaTaskId 与 channelKey。');
  }
}

export function enqueueOperation(
  options: ExecutionFacadeOptions & { assertOpen(): void },
  input: EnqueueInput,
): EnqueueResult {
  options.assertOpen();
  validateInput(input);
  const verification = options.journal.verify();
  if (!verification.valid) throw new ExecutionError('execution_journal_unavailable', '执行 journal 不可信，拒绝登记新付费操作。');
  const now = options.now?.() ?? new Date();
  const run = options.db.transaction((): EnqueueResult => {
    const existing = options.db.prepare(`
      SELECT * FROM execution_operations WHERE actorId = ? AND operationKey = ?
    `).get(input.actor.userId, input.operationKey) as Parameters<typeof mapOperation>[0] | undefined;
    if (existing) {
      const operation = mapOperation(existing);
      if (operation.inputHash !== input.inputHash) {
        throw new ExecutionError('idempotency_conflict', '同一执行键的输入已经变化。');
      }
      if (json(operation.inputSnapshot) !== json(input.inputSnapshot)
        || operation.businessAttemptId !== input.businessAttempt.id
        || operation.businessAttemptNo !== input.businessAttempt.number
        || operation.scopeType !== input.scope.resourceType
        || operation.scopeId !== input.scope.resourceId
        || (operation.mediaTaskId ?? null) !== (input.mediaTaskId?.trim() || null)
        || (operation.channelKey ?? null) !== (input.channelKey?.trim() || null)) {
        throw new ExecutionError('idempotency_conflict', '同一执行键的操作身份或输入已经变化。');
      }
      return {
        kind: ['succeeded', 'failed'].includes(operation.status) ? 'completed' : 'deferred',
        operation,
        replayed: true,
      };
    }
    if (options.maintenance()) throw new ExecutionError('maintenance', '维护状态只阻止新阶段。');
    if (!options.actorAllowed(input.actor.userId)) {
      throw new ExecutionError('actor_disabled', '发起人已停用，只保留既有结果回收。');
    }
    if (!options.scopeAllowed(input.actor.userId, input.scope)) {
      throw new ExecutionError('scope_forbidden', '发起人无权在该 scope 开始新阶段。');
    }
    const state = options.db.prepare('SELECT nextReadySeq FROM execution_admission_state WHERE id = 1').get() as
      | { nextReadySeq: number } | undefined;
    if (!state) throw new ExecutionError('execution_not_ready', '执行准入状态未就绪。');
    const id = (options.newId ?? randomUUID)();
    const at = now.toISOString();
    input.persistCheckpoint?.(options.db);
    options.db.prepare(`
      INSERT INTO execution_operations (
        id, operationKey, actorId, scopeType, scopeId, module, taskId, step, inputRevision,
        businessAttemptId, businessAttemptNo, inputHash, inputSnapshotJson, continuationKey,
        providerSnapshotJson, configVersion, clientVersion, serverReleaseId,
        credentialVersionRef, requiredPoolsJson, quoteJson, mediaTaskId, channelKey,
        status, readySeq, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `).run(
      id, input.operationKey, input.actor.userId, input.scope.resourceType, input.scope.resourceId,
      input.module, input.taskId, input.step, input.inputRevision,
      input.businessAttempt.id, input.businessAttempt.number, input.inputHash, json(input.inputSnapshot),
      input.continuationKey, json(input.providerSnapshot), input.configVersion ?? null,
      input.clientVersion ?? null, options.serverReleaseId ?? null,
      input.credentialVersionRef ?? null, json([...input.requiredPools]), json(input.quote),
      input.mediaTaskId?.trim() || null, input.channelKey?.trim() || null,
      state.nextReadySeq, at, at,
    );
    options.db.prepare('UPDATE execution_admission_state SET nextReadySeq = ? WHERE id = 1')
      .run(state.nextReadySeq + 1);
    const row = options.db.prepare('SELECT * FROM execution_operations WHERE id = ?').get(id) as Parameters<typeof mapOperation>[0];
    return { kind: 'deferred', operation: mapOperation(row), replayed: false };
  });
  return run.immediate();
}

export function createExecutionFacade(options: ExecutionFacadeOptions): ExecutionRuntime {
  assertExecutionContext(options);
  let open = false;
  let recovered = false;
  const assertOpen = (): void => {
    if (!open) throw new ExecutionError('execution_not_ready', 'server 执行 readiness 尚未开放新付费工作。');
  };
  const facade: ExecutionRuntime['facade'] = {
    enqueue: (input: EnqueueInput) => enqueueOperation({ ...options, assertOpen }, {
      ...input,
      clientVersion: input.clientVersion ?? currentExecutionClientVersion(),
    }),
    admit: (instance) => admitOperation({ ...options, assertOpen }, instance),
    markSubmitting: (input) => markSubmitting({ ...options, assertOpen }, input),
    attachReceipt: (input) => attachReceipt(options, input),
    reconcile: (input) => reconcileAttempt(options, input),
    settle: (input) => settleAttempt(options, input),
    transmit: (intent, send) => transmitAttempt(options, intent, send),
    async captureError(record) {
      try {
        await options.recordError?.(record);
      } catch {
        // 诊断不可用不得改变 worker 已确定的业务状态。
      }
    },
    async captureRecovery(record) {
      try { await options.recordRecovery?.(record); } catch { /* 与 usage 同为旁路镜像 */ }
    },
  };
  return {
    facade,
    closeNewWork() { open = false; },
    lifecycle: {
      name: 'execution',
      ensureSchemaReady() {},
      registerRecovery() {},
      async recover() {
        const result = await recoverExecution(options);
        if (!result.available) throw new ExecutionError('execution_journal_unavailable', '执行恢复核查失败，保持新付费关闭。');
        recovered = true;
      },
      async start() {
        if (!recovered) {
          const result = await recoverExecution(options);
          if (!result.available) throw new ExecutionError('execution_journal_unavailable', '执行恢复核查失败，保持新付费关闭。');
          recovered = true;
        }
        open = true;
      },
      drain() {
        open = false;
        const pending = options.db.prepare(`
          SELECT COUNT(*) AS count FROM execution_attempts
          WHERE submissionState IN ('maybe_sent', 'accepted')
        `).pluck().get() as number;
        return pending;
      },
    },
  };
}
