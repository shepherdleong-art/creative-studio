import type Database from 'better-sqlite3';
import { getDb } from './db.ts';
import { runWithTaskAccessContext } from './media-core/access-context.ts';
import type { ExecutionModuleLifecycle } from './media-core/execution/contracts.ts';
import {
  recoverPersistentScriptGenerations,
  registerPersistentScriptGenerationExecutor,
  stopPersistentScriptGenerationWorkers,
} from './script-generation-manager.ts';
import { generateAndPersistScriptV3 } from './script-generation-v3-service.ts';

export const SCRIPT_GENERATION_V3_EXECUTOR_KEY = 'script-generation-v3';

registerPersistentScriptGenerationExecutor(SCRIPT_GENERATION_V3_EXECUTOR_KEY, async (context) => {
  const snapshot = context.inputSnapshot as {
    project?: Record<string, unknown>;
    body?: Record<string, unknown>;
  };
  if (!snapshot.project || !snapshot.body) throw new Error('脚本生成持久输入不完整');
  const { completeJson, getProviderMeta } = await import('./script-providers/index.ts');
  return runWithTaskAccessContext(getDb(), 'script_generation', context.generationId, async () => {
    let sequence = 0;
    return generateAndPersistScriptV3({
      projectId: context.projectId,
      project: snapshot.project!,
      body: snapshot.body!,
    }, {
      db: getDb(),
      completeJson: async (providerId, request) => {
        const step = `generate:${++sequence}`;
        const result = await completeJson({
          providerId,
          ...request,
          usageContext: {
            projectId: context.projectId,
            refType: 'script-generation',
            refId: context.generationId,
          },
          executionContext: {
            taskId: context.generationId,
            step,
            scope: context.scope,
          },
        });
        context.onCheckpoint({ lastCompletedStep: step });
        return result;
      },
      providerMeta: getProviderMeta,
      createId: () => context.draftId,
      signal: context.signal,
      onProgress: context.onProgress,
    });
  });
});

export function createScriptGenerationV3Lifecycle(db: Database.Database): ExecutionModuleLifecycle {
  let timer: NodeJS.Timeout | null = null;
  return {
    name: 'script-generation-v3',
    ensureSchemaReady() {},
    registerRecovery() {},
    recover() {},
    async start() {
      await recoverPersistentScriptGenerations(db);
      timer = setInterval(() => {
        void recoverPersistentScriptGenerations(db);
      }, 100);
      timer.unref();
    },
    drain() {
      if (timer) clearInterval(timer);
      timer = null;
      stopPersistentScriptGenerationWorkers();
      return db.prepare("SELECT COUNT(*) FROM script_generation_tasks WHERE state = 'running'").pluck().get() as number;
    },
  };
}
