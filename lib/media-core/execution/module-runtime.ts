import type { ExecutionFacade, InstanceFence } from './context.ts';

export interface ExecutionModuleRuntime extends InstanceFence {
  facade: ExecutionFacade;
}

const RUNTIME_KEY = Symbol.for('creative-studio.execution-module-runtime');

function globals(): Record<PropertyKey, unknown> {
  return globalThis as Record<PropertyKey, unknown>;
}

export function setExecutionModuleRuntime(runtime: ExecutionModuleRuntime): void {
  globals()[RUNTIME_KEY] = runtime;
}

export function getExecutionModuleRuntime(): ExecutionModuleRuntime | null {
  return (globals()[RUNTIME_KEY] as ExecutionModuleRuntime | undefined) ?? null;
}

export function clearExecutionModuleRuntime(): void {
  delete globals()[RUNTIME_KEY];
}
