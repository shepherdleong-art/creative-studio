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
  poolKey: 'llm:remote', kind: 'remote', capacity: 16, enabled: true,
  mappingSnapshot: { providerId: 'qwen' }, expectedVersion: 0,
});
updateActorPolicy(db, {
  actorId: 'user-a', monthlyLimitMinor: null, personalConcurrency: 16, paused: false, expectedVersion: 0,
});
updateActorPolicy(db, {
  actorId: 'user-b', monthlyLimitMinor: null, personalConcurrency: 16, paused: false, expectedVersion: 0,
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


try {
  configureProvider('openai-compatible');
  let posts = 0;
  const secretMarker = 'PRIVATE_PROVIDER_BODY_token=secret-example';
  const cases = [
    { id: 'connection', code: 'transport_connection_reset', fetch: async () => { throw new TypeError(secretMarker, { cause: { code: 'ECONNRESET', message: secretMarker } }); } },
    { id: 'invalid-json', code: 'llm_response_invalid_json', fetch: async () => new Response(secretMarker) },
    { id: 'empty', code: 'llm_response_empty', fetch: async () => Response.json({ choices: [{ message: { content: '' } }] }) },
    { id: 'timeout', code: 'transport_timeout', fetch: async (_: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }) },
    { id: 'cancel', code: 'transport_canceled', fetch: async (_: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      external.abort();
    }) },
    { id: 'checkpoint', code: 'llm_checkpoint_write_failed', fetch: async () => Response.json({ choices: [{ message: { content: '{"ok":true}' } }] }) },
  ];
  const external = new AbortController();
  for (const c of cases) {
    if (c.id === 'checkpoint') db.exec("CREATE TRIGGER fail_test_checkpoint BEFORE INSERT ON llm_execution_checkpoints BEGIN SELECT RAISE(FAIL, 'test checkpoint disk failure'); END;");
    globalThis.fetch = async (url, init) => { posts++; return c.fetch(url, init); };
    const input = c.id === 'cancel' ? { signal: external.signal } : { timeoutMs: c.id === 'timeout' ? 15 : 1_000 };
    await assert.rejects(call('user-a', c.id, input), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'llm_execution_unknown');
      assert.equal((error as Error).message.includes(secretMarker), false);
      return true;
    });
    const attempt = db.prepare(`SELECT a.errorCode,a.submissionState,a.terminalState,o.status
      FROM execution_attempts a JOIN execution_operations o ON o.id=a.operationId WHERE o.taskId=?`).get(c.id);
    assert.deepEqual(attempt, { errorCode: c.code, submissionState: 'maybe_sent', terminalState: null, status: 'unknown' });
    const before = posts;
    await assert.rejects(call('user-a', c.id, c.id === 'cancel' ? {} : input), { code: 'llm_execution_unknown' });
    assert.equal(posts, before, 'diagnostics must not trigger a second POST');
  }
  const journalDir = path.join(dataRoot, 'storage/execution-journal/script-provider-test');
  const records = fs.readdirSync(journalDir).filter(n => n.endsWith('.jsonl')).flatMap(n => fs.readFileSync(path.join(journalDir,n),'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)));
  const receipts = records.filter(r => r.eventType === 'receipt' && r.terminalState === 'unknown');
  assert.deepEqual(receipts.map(r => r.errorCode).sort(), cases.map(c => c.code).sort());
  assert.equal(JSON.stringify(receipts).includes(secretMarker), false);
  console.log('PASS: safe failure categories survive unknown receipts, retries remain blocked, provider secrets are absent');
} finally {
  clearExecutionModuleRuntime(); globalThis.fetch = originalFetch; closeDb();
  fs.rmSync(dataRoot, { recursive: true, force: true });
}
