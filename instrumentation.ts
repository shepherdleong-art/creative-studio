const SHUTDOWN_TIMEOUT_MS = 15_000;
let processShutdownHandlersRegistered = false;

type GracefulShutdown = (opts: { timeoutMs: number }) => Promise<unknown>;
type ProcessSignalHost = {
  once(event: 'SIGTERM' | 'SIGINT', listener: () => void): void;
  exit(code?: number): never;
};

function registerProcessShutdownHandlers(gracefulShutdown: GracefulShutdown): void {
  if (processShutdownHandlersRegistered) return;
  processShutdownHandlersRegistered = true;
  const runtimeProcess = (globalThis as typeof globalThis & { process?: ProcessSignalHost }).process;
  if (!runtimeProcess) return;

  const handleSignal = () => {
    void gracefulShutdown({ timeoutMs: SHUTDOWN_TIMEOUT_MS }).then(
      () => runtimeProcess.exit(0),
      () => runtimeProcess.exit(0),
    );
  };
  runtimeProcess.once('SIGTERM', handleSignal);
  runtimeProcess.once('SIGINT', handleSignal);
}

/** Next.js Node 运行时启动后恢复批量调度;Edge/浏览器运行时不得加载本地 SQLite。 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { gracefulShutdown } = await import('./lib/shutdown');
  registerProcessShutdownHandlers(gracefulShutdown);
  try {
    const [{ getDb }, { reconcileUsageLedger }] = await Promise.all([
      import('./lib/db'),
      import('./lib/usage-ledger'),
    ]);
    reconcileUsageLedger(getDb());
  } catch {
    // Usage accounting is deliberately best-effort at startup; it must never
    // prevent the existing batch scheduler from recovering its work.
    console.error('[usage-ledger] startup reconciliation skipped');
  }
  const { startBatchSchedulerAfterReadiness } = await import('./lib/batch-production/bootstrap');
  void startBatchSchedulerAfterReadiness();
}
