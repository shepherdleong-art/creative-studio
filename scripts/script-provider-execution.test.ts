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
  LlmExecutionDeferredError,
} = await import('../lib/script-providers/index.ts');

const db = getDb();
getAvailableProviders();
const readiness = await checkExecutionReadiness({ db, ...schemaUpgradeRuntimePaths(dataRoot) });
assert.equal(readiness.available, true);
const identity = { instanceId: 'script-provider-test', fence: 1 };
registerExecutionInstance(db, { ...identity, deploymentId: 'script-provider-test' });
upsertExecutionPool(db, {
  poolKey: 'llm:remote', kind: 'remote', capacity: 1, enabled: true,
  mappingSnapshot: { providerId: 'qwen' }, expectedVersion: 0,
});
updateActorPolicy(db, {
  actorId: 'user-a', monthlyLimitMinor: null, personalConcurrency: 1, paused: false, expectedVersion: 0,
});
updateActorPolicy(db, {
  actorId: 'user-b', monthlyLimitMinor: null, personalConcurrency: 1, paused: false, expectedVersion: 0,
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
const encoder = new TextEncoder();
function sse(chunks: string[]): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

try {
  await assert.rejects(
    runWithAccessContext(access('user-a'), () => completeJson({ providerId: 'qwen', systemPrompt: 's', userPrompt: 'u' })),
    /执行上下文|execution context/i,
  );

  configureProvider('openai-compatible');
  let fallbackPosts = 0;
  globalThis.fetch = async () => {
    fallbackPosts += 1;
    if (fallbackPosts === 1) return new Response('Unsupported value: temperature is not supported', { status: 400 });
    return Response.json({ choices: [{ message: { content: '{"fallback":true}' } }] });
  };
  assert.deepEqual(await call('user-a', 'fallback', { temperature: 0.2 }), { fallback: true });
  assert.equal(fallbackPosts, 2);
  const fallbackAttempts = db.prepare(`
    SELECT a.transportSeq, a.submissionState, a.terminalState, a.costState
    FROM execution_attempts a JOIN execution_operations o ON o.id = a.operationId
    WHERE o.taskId = 'fallback' ORDER BY a.transportSeq
  `).all() as Array<Record<string, unknown>>;
  assert.equal(fallbackAttempts.length, 2, '内部温度回退必须新增 transport attempt');
  assert.deepEqual(fallbackAttempts.map((attempt) => attempt.transportSeq), [1, 2]);
  assert.equal(fallbackAttempts[0].terminalState, 'failed');
  assert.equal(fallbackAttempts[1].terminalState, 'succeeded');
  assert.equal(db.prepare(`
    SELECT COUNT(*) FROM execution_reservations r JOIN execution_operations o ON o.id = r.operationId
    WHERE o.taskId = 'fallback' AND r.kind = 'cost'
  `).pluck().get(), 2, '每次真实传输都必须重新计价');
  db.prepare("UPDATE execution_operations SET resultJson=NULL WHERE taskId='fallback'").run();
  configureProvider('openai-compatible', 'changed-after-accept');
  assert.deepEqual(await call('user-a', 'fallback', { temperature: 0.2 }), { fallback: true });
  assert.equal(fallbackPosts, 2, '回执已落盘但业务 result 尚未结算时，也必须从持久检查点恢复且不重新 POST');

  configureProvider('openai-responses');
  globalThis.fetch = async () => sse([
    'data: {"type":"response.output_text.delta","delta":"{\\"protocol\\":\\"responses\\"}"}\n\n',
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":2,"output_tokens":1}}}\n\n',
  ]);
  assert.deepEqual(await call('user-a', 'responses'), { protocol: 'responses' });

  configureProvider('anthropic-messages');
  globalThis.fetch = async () => Response.json({
    content: [{ type: 'text', text: '{"protocol":"anthropic"}' }], usage: { input_tokens: 2, output_tokens: 1 },
  });
  assert.deepEqual(await call('user-a', 'anthropic'), { protocol: 'anthropic' });

  configureProvider('native-gemini');
  globalThis.fetch = async () => Response.json({
    candidates: [{ content: { parts: [{ text: '{"protocol":"gemini"}' }] } }],
    usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1 },
  });
  assert.deepEqual(await call('user-a', 'gemini'), { protocol: 'gemini' });
  assert.equal(db.prepare(`
    SELECT COUNT(*) FROM execution_attempts a JOIN execution_operations o ON o.id = a.operationId
    WHERE o.taskId IN ('responses', 'anthropic', 'gemini')
  `).pluck().get(), 3, '所有协议的真实 POST 都必须经过 06 transmit');

  configureProvider('openai-compatible');
  let releaseHold!: () => void;
  const hold = new Promise<void>((resolve) => { releaseHold = resolve; });
  let holdStarted!: () => void;
  const started = new Promise<void>((resolve) => { holdStarted = resolve; });
  globalThis.fetch = async () => {
    holdStarted();
    await hold;
    return Response.json({ choices: [{ message: { content: '{"held":true}' } }] });
  };
  const holding = call('user-a', 'holding');
  await started;
  let deferred: unknown;
  const second = call('user-b', 'waiting').catch((error) => { deferred = error; });
  await second;
  assert.ok(deferred instanceof LlmExecutionDeferredError);
  assert.equal(db.prepare(`
    SELECT COUNT(*) FROM execution_attempts a JOIN execution_operations o ON o.id = a.operationId
    WHERE o.taskId = 'waiting'
  `).pluck().get(), 0, 'deferred 不得消耗提交预算或创建 transport');
  assert.equal(db.prepare("SELECT status FROM execution_operations WHERE taskId = 'waiting'").pluck().get(), 'deferred');
  releaseHold();
  assert.deepEqual(await holding, { held: true });

  globalThis.fetch = async () => Response.json({ choices: [{ message: { content: '{"resumed":true}' } }] });
  assert.deepEqual(await call('user-b', 'waiting'), { resumed: true });
  assert.equal(db.prepare(`
    SELECT COUNT(*) FROM execution_attempts a JOIN execution_operations o ON o.id = a.operationId
    WHERE o.taskId = 'waiting'
  `).pluck().get(), 1);

  upsertExecutionPool(db, {
    poolKey: 'llm:remote', kind: 'remote', capacity: 4, enabled: true,
    mappingSnapshot: { providerId: 'qwen' }, expectedVersion: 1,
  });
  let interruptedPosts = 0;
  globalThis.fetch = async () => {
    interruptedPosts += 1;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"{\\"partial\\":"}]}\n\n'));
        controller.error(new Error('socket reset'));
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  await assert.rejects(
    call('user-a', 'stream-interrupted', { onTextDelta: () => undefined }),
    (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error
      && (error as { code?: string }).code === 'llm_execution_unknown'),
  );
  assert.equal(interruptedPosts, 1, '流中断不得盲目回退或重试');
  assert.equal(db.prepare("SELECT status FROM execution_operations WHERE taskId = 'stream-interrupted'").pluck().get(), 'unknown');
  assert.equal(db.prepare(`
    SELECT submissionState FROM execution_attempts a JOIN execution_operations o ON o.id = a.operationId
    WHERE o.taskId = 'stream-interrupted'
  `).pluck().get(), 'maybe_sent', '流中断不能按免费未提交结算');

  let unknownPosts = 0;
  globalThis.fetch = async () => {
    unknownPosts += 1;
    throw new Error('network unknown: temperature unsupported value');
  };
  await assert.rejects(
    call('user-b', 'network-unknown', { temperature: 0.2 }),
    (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error
      && (error as { code?: string }).code === 'llm_execution_unknown'),
  );
  assert.equal(unknownPosts, 1, '只有明确 HTTP 温度拒绝才允许内部回退');
  assert.equal(db.prepare("SELECT status FROM execution_operations WHERE taskId = 'network-unknown'").pluck().get(), 'unknown');

  // 模拟单条混剪再次创作：同一素材的稳定调用身份继续碰到旧 unknown，不能再次 POST。
  const unknownOperationId = db.prepare("SELECT id FROM execution_operations WHERE taskId = 'network-unknown'").pluck().get();
  for (let repeat = 0; repeat < 2; repeat += 1) {
    await assert.rejects(
      call('user-b', 'network-unknown', { temperature: 0.2 }),
      (error: unknown) => error instanceof Error && error.message === 'LLM 调用结果尚未核清，未自动重提',
    );
  }
  assert.equal(unknownPosts, 1, '重新进入同一任务不能重提结果未知的调用');
  assert.equal(db.prepare("SELECT id FROM execution_operations WHERE taskId = 'network-unknown'").pluck().get(), unknownOperationId);
  assert.equal(db.prepare('SELECT COUNT(*) FROM execution_attempts WHERE operationId = ?').pluck().get(unknownOperationId), 1);

  // 经授权的补跑使用独立修订；旧 unknown 与费用预留不被新结果覆盖。
  const oldAttempt = db.prepare('SELECT * FROM execution_attempts WHERE operationId=?').get(unknownOperationId);
  const oldReservations = db.prepare('SELECT * FROM execution_reservations WHERE operationId=? ORDER BY id').all(unknownOperationId);
  let recoveryPosts = 0;
  globalThis.fetch = async () => {
    recoveryPosts += 1;
    return Response.json({ choices: [{ message: { content: '{"recovered":true}' } }] });
  };
  const recoveryInput = {
    temperature: 0.2,
    executionContext: {
      taskId: 'network-unknown', step: 'complete:1',
      scope: { resourceType: 'project', resourceId: 'user-b-project' },
      inputRevision: 'operator-recovery-1',
      businessAttempt: { id: 'operator-recovery-1', number: 2 },
    },
  };
  await assert.rejects(call('user-b', 'network-unknown', recoveryInput), LlmExecutionDeferredError);
  assert.equal(recoveryPosts, 0, '独立修订不能绕过仍占用的成员名额');
  updateActorPolicy(db, {
    actorId: 'user-b', monthlyLimitMinor: null, personalConcurrency: 2, paused: false, expectedVersion: 1,
  });
  assert.deepEqual(await call('user-b', 'network-unknown', recoveryInput), { recovered: true });
  assert.deepEqual(await call('user-b', 'network-unknown', recoveryInput), { recovered: true });
  assert.equal(recoveryPosts, 1, '补跑脚本重入必须复用成功检查点');
  assert.equal(db.prepare('SELECT status FROM execution_operations WHERE id=?').pluck().get(unknownOperationId), 'unknown');
  assert.deepEqual(db.prepare('SELECT * FROM execution_attempts WHERE operationId=?').get(unknownOperationId), oldAttempt);
  assert.deepEqual(db.prepare('SELECT * FROM execution_reservations WHERE operationId=? ORDER BY id').all(unknownOperationId), oldReservations);

  console.log('script provider execution tests passed');
} finally {
  clearExecutionModuleRuntime();
  globalThis.fetch = originalFetch;
  closeDb();
  fs.rmSync(dataRoot, { recursive: true, force: true });
}
