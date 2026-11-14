import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';
import type { ResourceAccessContext } from '../lib/media-core/access-context.ts';

register('./typescript-extension-loader.mjs', import.meta.url);

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-script-provider-execution-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = dataRoot;
delete process.env.CREATIVE_STUDIO_DEPLOYMENT_MODE;

const { getDb, closeDb } = await import('../lib/db.ts');
const { runWithAccessContext } = await import('../lib/media-core/access-context.ts');
const { checkExecutionReadiness } = await import('../lib/media-core/execution/readiness.ts');
const { createExecutionFacade } = await import('../lib/media-core/execution/operations.ts');
const { createExecutionJournal } = await import('../lib/media-core/execution/journal.ts');
const { registerExecutionInstance } = await import('../lib/media-core/execution/schema.ts');
const { updateActorPolicy, upsertExecutionPool } = await import('../lib/media-core/execution/pools.ts');
const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
const {
  clearExecutionModuleRuntime,
  setExecutionModuleRuntime,
} = await import('../lib/media-core/execution/module-runtime.ts');
const {
  completeJson,
  getAvailableProviders,
} = await import('../lib/script-providers/index.ts');

const db = getDb();
getAvailableProviders();
const readiness = await checkExecutionReadiness({ db, ...schemaUpgradeRuntimePaths(dataRoot) });
assert.equal(readiness.available, true);
const identity = { instanceId: 'script-provider-test', fence: 1 };
registerExecutionInstance(db, { ...identity, deploymentId: 'script-provider-test' });
upsertExecutionPool(db, {
  poolKey: 'llm:remote', kind: 'remote', capacity: 4, enabled: true,
  mappingSnapshot: { providerId: 'qwen' }, expectedVersion: 0,
});
updateActorPolicy(db, {
  actorId: 'user-a', monthlyLimitMinor: null, personalConcurrency: 4, paused: false, expectedVersion: 0,
});
updateActorPolicy(db, {
  actorId: 'user-b', monthlyLimitMinor: null, personalConcurrency: 4, paused: false, expectedVersion: 0,
});
const execution = createExecutionFacade({
  db,
  deploymentId: 'script-provider-test',
  journal: createExecutionJournal({
    deploymentId: 'script-provider-test',
    directory: path.join(dataRoot, 'storage', 'execution-journal', 'script-provider-test'),
  }),
  actorAllowed: () => true,
  scopeAllowed: () => true,
  maintenance: () => false,
});
await execution.lifecycle.start({ ...identity, deploymentId: 'script-provider-test', signal: new AbortController().signal });
setExecutionModuleRuntime({ facade: execution.facade, ...identity });

function access(userId: string): ResourceAccessContext {
  return {
    kind: 'team', actor: { userId, role: 'admin' },
    assertAccess() {}, resolveOwner() { return userId; }, registerRootScope() {},
    registerInheritedScope() {}, registerTaskPrincipal() {},
  };
}

function call(userId: string, taskId: string, input: Partial<Parameters<typeof completeJson>[0]> = {}) {
  return runWithAccessContext(access(userId), () => completeJson({
    providerId: 'qwen', systemPrompt: 'system', userPrompt: 'user',
    usageContext: { projectId: `${userId}-project`, refType: 'test', refId: taskId },
    executionContext: {
      taskId, step: 'complete:1', scope: { resourceType: 'project', resourceId: `${userId}-project` },
    },
    ...input,
  } as Parameters<typeof completeJson>[0]));
}

function configureProvider(apiStyle: string, model = 'model-x') {
  db.prepare(`
    UPDATE script_providers SET type=?, apiStyle=?, baseUrl=?, apiKey=?, model=?, enabled=1,
      supportsVision=1, executionScope='external' WHERE id='qwen'
  `).run(apiStyle, apiStyle, 'https://provider.test/v1', 'secret', model);
}

const originalFetch = globalThis.fetch;

const { setTimeout: delay } = await import('node:timers/promises');
const { mapAnalysisMaterials, waitForAnalysisAdmission } = await import('../lib/media-core/analysis-concurrency.ts');
try {
  configureProvider('openai-compatible');
  let posts = 0;
  let release!: () => void;
  const submitted = new Promise<void>(resolve => { release = resolve; });
  globalThis.fetch = async (_, init) => {
    const body = JSON.parse(String(init?.body));
    const index = Number(body.messages[1].content);
    if (++posts === 4) release();
    await submitted;
    if (index === 3) throw new TypeError('fetch failed', { cause: Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }) });
    await delay(30, undefined, { signal: init?.signal ?? undefined });
    return Response.json({ choices: [{ message: { content: JSON.stringify({ index }) } }] });
  };
  const completed: number[] = [];
  await assert.rejects(mapAnalysisMaterials([0, 1, 2, 3, 4, 5], async (index, _, signal) => {
    const result = await waitForAnalysisAdmission(() => call('user-a', `material-${index}`, { userPrompt: String(index), signal }), signal);
    completed.push(index);
    return result;
  }), { code: 'llm_execution_unknown' });
  assert.equal(posts, 4, 'a failed material must stop taking new work, without resubmitting');
  assert.deepEqual(completed.sort(), [0, 1, 2], 'other submitted materials must retain their successful results');
  const rows = db.prepare('SELECT taskId,status FROM execution_operations ORDER BY taskId').all();
  assert.deepEqual(rows, [0, 1, 2, 3].map(index => ({ taskId: `material-${index}`, status: index === 3 ? 'unknown' : 'succeeded' })));
  await assert.rejects(call('user-a', 'material-3', { userPrompt: '3' }), { code: 'llm_execution_unknown' });
  assert.equal(posts, 4, 're-entry must not resend the unknown call');
  console.log('PASS: one unknown analysis preserves three in-flight successes; no new work or paid retries');
} finally {
  clearExecutionModuleRuntime();
  globalThis.fetch = originalFetch;
  closeDb();
  fs.rmSync(dataRoot, { recursive: true, force: true });
}
