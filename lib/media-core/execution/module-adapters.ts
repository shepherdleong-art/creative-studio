import type { ExecutionFacade, ExecutionGrant } from './context.ts';

export type ExecutionContinuation = (
  grant: ExecutionGrant,
  facade: ExecutionFacade,
) => Promise<void>;

const REGISTRY_KEY = Symbol.for('creative-studio.execution-module-adapters');

function registry(): Map<string, ExecutionContinuation> {
  const scope = globalThis as Record<PropertyKey, unknown>;
  if (!scope[REGISTRY_KEY]) scope[REGISTRY_KEY] = new Map<string, ExecutionContinuation>();
  return scope[REGISTRY_KEY] as Map<string, ExecutionContinuation>;
}

export function registerExecutionContinuation(key: string, continuation: ExecutionContinuation): void {
  if (!key.trim()) throw new Error('continuationKey 不能为空');
  registry().set(key, continuation);
}

export async function executeExecutionContinuation(
  grant: ExecutionGrant,
  facade: ExecutionFacade,
): Promise<void> {
  const continuation = registry().get(grant.continuationKey);
  if (!continuation) throw new Error(`未注册的执行 continuation：${grant.continuationKey}`);
  await continuation(grant, facade);
}
