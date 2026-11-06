import { register as registerTypeScriptExtensions } from 'node:module';

registerTypeScriptExtensions('./typescript-extension-loader.mjs', import.meta.url);
const mode = process.argv[2];
if (mode !== 'local' && mode !== 'server') throw new Error('mode required');

const { register } = await import('../instrumentation.ts');
await register();

if (mode === 'local') {
  const { getBatchSchedulerController } = await import('../lib/batch-production/runner.ts');
  const deadline = Date.now() + 10_000;
  while (!getBatchSchedulerController() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const { getBatchSchedulerController } = await import('../lib/batch-production/runner.ts');
const { getScriptStudioSchedulerController } = await import('../lib/script-studio/scheduler.ts');
const { getTeamRuntimeState } = await import('../lib/team-service/runtime/state.ts');
const { getDb } = await import('../lib/db.ts');
const { gracefulShutdown } = await import('../lib/shutdown.ts');
const state = getTeamRuntimeState();
const corruptCore = process.argv[3] === 'corrupt-core';
const tableExists = (name: string) => {
  if (corruptCore) return null;
  const db = getDb();
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
};
const report = {
  mode,
  batchSchedulerStarted: getBatchSchedulerController() !== null,
  scriptStudioSchedulerStarted: Boolean(getScriptStudioSchedulerController()),
  ready: state.ready,
  code: state.code ?? null,
  teamSchema: tableExists('team_schema_migrations'),
  executionSchema: tableExists('execution_schema_migrations'),
};
const shutdown = await gracefulShutdown({ timeoutMs: 5_000 });
process.stdout.write(`${JSON.stringify({ ...report, shutdown })}\n`);
