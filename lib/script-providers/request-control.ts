interface ScriptProviderRequestControlOptions {
  externalSignal?: AbortSignal;
  timeoutMs?: number;
  defaultTimeoutMs: number;
  timeoutMessage(timeoutMs: number): string;
}

export interface ScriptProviderRequestControl {
  signal: AbortSignal;
  timeoutMs: number;
  rethrow(error: unknown): never;
  dispose(): void;
}

export function createScriptProviderRequestControl(
  options: ScriptProviderRequestControlOptions,
): ScriptProviderRequestControl {
  const controller = new AbortController();
  const timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? options.defaultTimeoutMs));
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const signal = options.externalSignal
    ? AbortSignal.any([controller.signal, options.externalSignal])
    : controller.signal;

  return {
    signal,
    timeoutMs,
    rethrow(error: unknown): never {
      if (options.externalSignal?.aborted) throw new Error('脚本生成已取消');
      if (timedOut || (error instanceof Error && error.name === 'AbortError')) {
        throw new Error(options.timeoutMessage(timeoutMs));
      }
      throw error;
    },
    dispose() {
      clearTimeout(timeout);
    },
  };
}
