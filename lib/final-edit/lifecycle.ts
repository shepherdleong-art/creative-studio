import type Database from 'better-sqlite3';
import type { ExecutionModuleLifecycle } from '../media-core/execution/contracts.ts';

export function createFinalEditExecutionLifecycle(
  _db: Database.Database,
  options: {
    recoverPrepare?: () => void;
    wakeWorker?: () => void;
  } = {},
): ExecutionModuleLifecycle {
  return {
    name: 'final-edit',
    ensureSchemaReady() {},
    registerRecovery() {},
    recover() {},
    async start(context) {
      if (context.signal.aborted) return;
      const recoverPrepare = options.recoverPrepare
        ?? (await import('./runtime.ts')).recoverFinalEditPrepareJobs;
      const wakeWorker = options.wakeWorker
        ?? (await import('./worker.ts')).wakeFinalEditWorker;
      recoverPrepare();
      wakeWorker();
    },
  };
}
