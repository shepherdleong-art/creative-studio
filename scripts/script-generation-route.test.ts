import assert from 'node:assert/strict';
import {
  handleScriptGenerationDelete,
  handleScriptGenerationGet,
  handleScriptGenerationPost,
  type ScriptGenerationRouteDeps,
} from '../lib/script-generation-route-handler.ts';
import {
  beginScriptGenerationShutdown,
  cancelScriptGeneration,
  getProjectScriptGeneration,
  isScriptGenerationShuttingDown,
  resetScriptGenerationManagerForTests,
  startScriptGeneration,
  type ScriptGenerationExecutionResult,
} from '../lib/script-generation-manager.ts';
import type { ScriptGenerationProgress } from '../lib/script-generation-v3.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const okResult: ScriptGenerationExecutionResult = {
  status: 200,
  body: { draftId: 'draft-1', script: { version: 3 } },
};

/**
 * 用真实管理器 + 注入执行器装配 deps；executorFactory 按 body 决定后台任务行为。
 * 这样动态测试走真实状态机，只把「模型调用」换成受控异步执行器。
 */
function makeDeps(options: {
  projectId: string;
  existingProjects?: Set<string>;
  executor: (body: Record<string, unknown>, context: {
    signal: AbortSignal;
    onProgress: (progress: ScriptGenerationProgress) => void;
  }) => Promise<ScriptGenerationExecutionResult>;
}): ScriptGenerationRouteDeps {
  const existing = options.existingProjects ?? new Set([options.projectId]);
  return {
    projectExists: () => existing.has(options.projectId),
    isShuttingDown: () => isScriptGenerationShuttingDown(),
    start: (body) => startScriptGeneration({
      projectId: options.projectId,
      generationId: String(body.generationId),
      execute: (context) => options.executor(body, context),
    }),
    getCurrent: () => getProjectScriptGeneration(options.projectId),
    cancel: (generationId) => cancelScriptGeneration(options.projectId, generationId),
  };
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const unhandled: unknown[] = [];
process.on('unhandledRejection', (reason) => { unhandled.push(reason) });

try {
  // ── POST 新任务：202 + created，执行器收到 signal/onProgress ──
  {
    const gate = deferred<ScriptGenerationExecutionResult>();
    let sawSignal = false;
    const deps = makeDeps({
      projectId: 'project-a',
      executor: (_body, { signal, onProgress }) => {
        sawSignal = signal instanceof AbortSignal;
        onProgress({ phase: 'preparing', percent: 5, message: '正在准备分镜图片' });
        return gate.promise;
      },
    });
    const res = handleScriptGenerationPost(deps, { generationId: 'gen-1', shotSetId: 'set-1' });
    assert.equal(res.status, 202);
    assert.equal(res.body.created, true);
    assert.deepEqual(res.body.generation, { generationId: 'gen-1', state: 'running' });
    assert.ok(sawSignal, '执行器必须收到管理器的 AbortSignal，而不是 request.signal');
    gate.resolve(okResult);
    await tick();
  }

  resetScriptGenerationManagerForTests();

  // ── 幂等与互斥：同 ID 重试 / 同项目不同 ID 都复用权威任务 ──
  {
    const gate = deferred<ScriptGenerationExecutionResult>();
    let executions = 0;
    const deps = makeDeps({
      projectId: 'project-a',
      executor: () => { executions += 1; return gate.promise; },
    });
    const first = handleScriptGenerationPost(deps, { generationId: 'gen-1' });
    const retry = handleScriptGenerationPost(deps, { generationId: 'gen-1' });
    const second = handleScriptGenerationPost(deps, { generationId: 'gen-2' });
    assert.equal(first.body.created, true);
    assert.equal(retry.status, 202);
    assert.equal(retry.body.created, false);
    assert.equal(second.status, 202);
    assert.equal(second.body.created, false);
    assert.deepEqual(second.body.generation, { generationId: 'gen-1', state: 'running' }, '必须返回权威任务 ID');
    assert.equal(executions, 1, '重试与冲突都不得再次调用模型');
    gate.resolve(okResult);
    await tick();
  }

  resetScriptGenerationManagerForTests();

  // ── 启动前可判定的错误：4xx，不注册任务 ──
  {
    const deps = makeDeps({ projectId: 'project-a', executor: async () => okResult });
    const missing = handleScriptGenerationPost(deps, { shotSetId: 'set-1' });
    assert.equal(missing.status, 400);
    const notObject = handleScriptGenerationPost(deps, null);
    assert.equal(notObject.status, 400);
    const notFound = handleScriptGenerationPost(
      makeDeps({ projectId: 'project-ghost', existingProjects: new Set(['project-a']), executor: async () => okResult }),
      { generationId: 'gen-1' },
    );
    assert.equal(notFound.status, 404);
    assert.equal(handleScriptGenerationGet(deps).body.generation, null, '4xx 不得注册任何任务');
  }

  resetScriptGenerationManagerForTests();

  // ── GET：no-store；running 快照带真实进度 ──
  {
    const gate = deferred<ScriptGenerationExecutionResult>();
    const deps = makeDeps({
      projectId: 'project-a',
      executor: (_body, { onProgress }) => {
        onProgress({ phase: 'generating', percent: 42, message: '正在生成脚本' });
        return gate.promise;
      },
    });
    handleScriptGenerationPost(deps, { generationId: 'gen-1' });
    const res = handleScriptGenerationGet(deps);
    assert.equal(res.status, 200);
    assert.equal(res.headers?.['Cache-Control'], 'no-store');
    const generation = res.body.generation as { state: string; progress: { percent: number } };
    assert.equal(generation.state, 'running');
    assert.equal(generation.progress.percent, 42);
    gate.resolve(okResult);
    await tick();
  }

  resetScriptGenerationManagerForTests();

  // ── 客户端断连不影响任务：POST 返回后执行器继续完成并落终态 ──
  {
    const deps = makeDeps({
      projectId: 'project-a',
      executor: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return okResult;
      },
    });
    handleScriptGenerationPost(deps, { generationId: 'gen-1' });
    // 这里没有也不允许有任何 request.signal 绑定：断连无可取消之物，任务自然完成
    await new Promise((resolve) => setTimeout(resolve, 60));
    const generation = handleScriptGenerationGet(deps).body.generation as { state: string; draftId: string };
    assert.equal(generation.state, 'succeeded');
    assert.equal(generation.draftId, 'draft-1');
  }

  resetScriptGenerationManagerForTests();

  // ── DELETE 显式取消：执行器收到 abort；迟到结果不改终态；幂等 ──
  {
    const gate = deferred<ScriptGenerationExecutionResult>();
    let aborted = false;
    const deps = makeDeps({
      projectId: 'project-a',
      executor: (_body, { signal }) => {
        signal.addEventListener('abort', () => { aborted = true; });
        return gate.promise;
      },
    });
    handleScriptGenerationPost(deps, { generationId: 'gen-1' });
    const cancelled = handleScriptGenerationDelete(deps, 'gen-1');
    assert.equal(cancelled.status, 200);
    assert.equal((cancelled.body.generation as { state: string }).state, 'cancelled');
    assert.ok(aborted, '取消必须 abort 执行器信号');
    gate.resolve(okResult); // 上游忽略 abort 的迟到结果
    await tick();
    const again = handleScriptGenerationDelete(deps, 'gen-1');
    assert.equal(again.status, 200, '已终态任务取消幂等');
    assert.equal((again.body.generation as { state: string }).state, 'cancelled');
    assert.equal((again.body.generation as { draftId: unknown }).draftId, null, '迟到结果不得补写 draftId');
  }

  resetScriptGenerationManagerForTests();

  // ── DELETE 参数校验：缺参 400；不存在/跨项目 404 ──
  {
    const gate = deferred<ScriptGenerationExecutionResult>();
    const depsA = makeDeps({ projectId: 'project-a', executor: () => gate.promise });
    const depsB = makeDeps({
      projectId: 'project-b',
      existingProjects: new Set(['project-a', 'project-b']),
      executor: () => gate.promise,
    });
    handleScriptGenerationPost(depsA, { generationId: 'gen-a' });
    assert.equal(handleScriptGenerationDelete(depsA, undefined).status, 400);
    assert.equal(handleScriptGenerationDelete(depsA, 'gen-missing').status, 404);
    assert.equal(handleScriptGenerationDelete(depsB, 'gen-a').status, 404, '不得跨项目取消');
    assert.equal(handleScriptGenerationGet(depsB).body.generation, null, '跨项目不得泄漏任务状态');
    assert.equal(handleScriptGenerationDelete(depsA, 'gen-a').status, 200);
  }

  resetScriptGenerationManagerForTests();

  // ── 领域错误进入 failed 终态，由 GET 返回脱敏错误 ──
  {
    const deps = makeDeps({
      projectId: 'project-a',
      executor: async () => ({
        status: 422,
        body: { error: 'project_deleted', message: '项目已被删除，脚本未保存', raw: 'upstream-payload' },
      }),
    });
    handleScriptGenerationPost(deps, { generationId: 'gen-1' });
    await tick();
    const generation = handleScriptGenerationGet(deps).body.generation as {
      state: string;
      error: { code: string; message: string };
    };
    assert.equal(generation.state, 'failed');
    assert.deepEqual(generation.error, { code: 'project_deleted', message: '项目已被删除，脚本未保存' });
    assert.equal(JSON.stringify(generation).includes('upstream-payload'), false);
  }

  resetScriptGenerationManagerForTests();

  // ── 执行器抛错 → failed，无未处理 rejection ──
  {
    const deps = makeDeps({
      projectId: 'project-a',
      executor: async () => { throw new Error('网络抖动'); },
    });
    handleScriptGenerationPost(deps, { generationId: 'gen-1' });
    await tick();
    const generation = handleScriptGenerationGet(deps).body.generation as {
      state: string; error: { code: string; message: string };
    };
    assert.equal(generation.state, 'failed');
    assert.equal(generation.error.code, 'script_generation_error');
    assert.equal(generation.error.message, '网络抖动');
  }

  resetScriptGenerationManagerForTests();

  // ── 停机：POST 503 稳定错误码，不注册任务 ──
  {
    const deps = makeDeps({ projectId: 'project-a', executor: async () => okResult });
    beginScriptGenerationShutdown();
    const res = handleScriptGenerationPost(deps, { generationId: 'gen-1' });
    assert.equal(res.status, 503);
    assert.equal(res.body.error, 'script_generation_shutting_down');
    assert.equal(handleScriptGenerationGet(deps).body.generation, null, '停机后不得注册任务');
  }

  resetScriptGenerationManagerForTests();
  await tick();
  assert.deepEqual(unhandled, [], '不得产生未处理的 Promise rejection');

  console.log('script generation route tests passed');
} finally {
  resetScriptGenerationManagerForTests();
}
