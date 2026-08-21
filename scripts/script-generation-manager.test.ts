import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  beginScriptGenerationShutdown,
  cancelScriptGeneration,
  configureScriptGenerationManagerForTests,
  getProjectScriptGeneration,
  isScriptGenerationShuttingDown,
  resetScriptGenerationManagerForTests,
  ScriptGenerationShuttingDownError,
  startScriptGeneration,
  waitForScriptGenerationsIdle,
  type ScriptGenerationExecutionResult,
} from '../lib/script-generation-manager.ts';

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

// 未处理的 Promise rejection 必须被视为测试失败：管理器要完整捕获后台任务。
const unhandled: unknown[] = [];
process.on('unhandledRejection', (reason) => { unhandled.push(reason); });

try {
  // ── 幂等：相同 projectId + generationId 重试返回原快照，不重复执行 ──
  {
    let executions = 0;
    const gate = deferred<ScriptGenerationExecutionResult>();
    const input = {
      projectId: 'project-a',
      generationId: 'gen-1',
      execute: () => { executions += 1; return gate.promise; },
    };
    const first = startScriptGeneration(input);
    const replay = startScriptGeneration(input);
    assert.equal(first.created, true);
    assert.equal(replay.created, false);
    assert.equal(replay.snapshot.generationId, 'gen-1');
    assert.equal(replay.snapshot.state, 'running');
    assert.equal(executions, 1, '相同 generationId 重试不得再次调用模型');
    gate.resolve(okResult);
    await gate.promise.then(() => new Promise((r) => setTimeout(r, 0)));
    const done = getProjectScriptGeneration('project-a');
    assert.equal(done?.state, 'succeeded');
    assert.equal(done?.draftId, 'draft-1');
    // 终态后重试仍返回原快照
    const replayAfterDone = startScriptGeneration(input);
    assert.equal(replayAfterDone.created, false);
    assert.equal(replayAfterDone.snapshot.state, 'succeeded');
    assert.equal(executions, 1);
  }

  resetScriptGenerationManagerForTests();

  // ── 同项目互斥：已有 running 任务时返回该任务，created=false ──
  {
    const gate = deferred<ScriptGenerationExecutionResult>();
    const first = startScriptGeneration({
      projectId: 'project-a', generationId: 'gen-1', execute: () => gate.promise,
    });
    const second = startScriptGeneration({
      projectId: 'project-a', generationId: 'gen-2', execute: () => gate.promise,
    });
    assert.equal(first.created, true);
    assert.equal(second.created, false, '同项目已有活动任务时不得新建');
    assert.equal(second.snapshot.generationId, 'gen-1', '必须返回权威任务 ID');
    // 终态释放占用：允许立即再次生成
    gate.resolve(okResult);
    await new Promise((r) => setTimeout(r, 0));
    const third = startScriptGeneration({
      projectId: 'project-a', generationId: 'gen-3', execute: () => deferred<ScriptGenerationExecutionResult>().promise,
    });
    assert.equal(third.created, true, '进入终态后必须立即释放项目占用');
    assert.equal(third.snapshot.generationId, 'gen-3');
  }

  resetScriptGenerationManagerForTests();

  // ── 跨项目并行：互不泄漏状态或取消权限 ──
  {
    const gateA = deferred<ScriptGenerationExecutionResult>();
    const gateB = deferred<ScriptGenerationExecutionResult>();
    startScriptGeneration({ projectId: 'project-a', generationId: 'gen-a', execute: () => gateA.promise });
    const b = startScriptGeneration({ projectId: 'project-b', generationId: 'gen-b', execute: () => gateB.promise });
    assert.equal(b.created, true, '不同项目必须允许并行');
    assert.equal(cancelScriptGeneration('project-b', 'gen-a'), false, '不得跨项目取消');
    assert.equal(getProjectScriptGeneration('project-b')?.generationId, 'gen-b');
    assert.equal(cancelScriptGeneration('project-a', 'gen-a'), true);
    const aSnapshot = getProjectScriptGeneration('project-a');
    assert.equal(aSnapshot?.state, 'cancelled');
    assert.equal(aSnapshot?.cancellationReason, 'user');
    gateB.resolve(okResult);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(getProjectScriptGeneration('project-b')?.state, 'succeeded');
  }

  resetScriptGenerationManagerForTests();

  // ── 进度来自真实 onProgress 回调；快照是拷贝，外部改不动内部状态 ──
  {
    const gate = deferred<ScriptGenerationExecutionResult>();
    startScriptGeneration({
      projectId: 'project-a',
      generationId: 'gen-1',
      execute: ({ onProgress }) => {
        onProgress({ phase: 'preparing', percent: 5, message: '正在准备分镜图片' });
        onProgress({ phase: 'generating', percent: 40, message: '正在生成' });
        return gate.promise;
      },
    });
    const snapshot = getProjectScriptGeneration('project-a');
    assert.deepEqual(snapshot?.progress, { phase: 'generating', percent: 40, message: '正在生成' });
    snapshot!.progress.percent = 99;
    assert.equal(getProjectScriptGeneration('project-a')?.progress.percent, 40, '返回快照必须是拷贝');
    gate.resolve(okResult);
    await new Promise((r) => setTimeout(r, 0));
  }

  resetScriptGenerationManagerForTests();

  // ── 失败：只保存脱敏的错误码和中文说明，不携带上游完整响应 ──
  {
    startScriptGeneration({
      projectId: 'project-a',
      generationId: 'gen-1',
      execute: async () => ({
        status: 422,
        body: {
          error: 'script_material_mismatch',
          message: '当前分镜图片无法承接所选模板',
          details: { internal: 'upstream-raw-response', authorization: 'Bearer sk-secret' },
        },
      }),
    });
    await new Promise((r) => setTimeout(r, 0));
    const snapshot = getProjectScriptGeneration('project-a');
    assert.equal(snapshot?.state, 'failed');
    assert.deepEqual(snapshot?.error, {
      code: 'script_material_mismatch',
      message: '当前分镜图片无法承接所选模板',
    });
    assert.equal(JSON.stringify(snapshot).includes('sk-secret'), false, '快照不得包含上游密钥或完整响应');
    assert.ok(snapshot?.finishedAt);
  }

  resetScriptGenerationManagerForTests();

  // ── 失败：details 按白名单透传并截断，上游原文/密钥绝不外泄 ──
  {
    const beats = Array.from({ length: 12 }, (_, index) => `阶段-${index + 1}`);
    const issues = Array.from({ length: 6 }, (_, index) => `问题-${index + 1}`);
    startScriptGeneration({
      projectId: 'project-a',
      generationId: 'gen-1',
      execute: async () => ({
        status: 422,
        body: {
          error: 'script_material_mismatch',
          message: '当前分镜图片无法承接所选模板',
          details: {
            kind: 'material_mismatch',
            attempts: 2,
            unsupportedNarrativeBeats: beats,
            materialReason: '附图只展示成品',
            suggestedTemplateId: 'scene_seeding',
            suggestedTemplateName: '场景种草',
            validationIssues: issues,
            contentCharacterCount: 42,
            targetCharacterRange: [54, 59],
            authorization: 'Bearer sk-secret',
            internal: 'upstream-raw-response',
          },
        },
      }),
    });
    await new Promise((r) => setTimeout(r, 0));
    const snapshot = getProjectScriptGeneration('project-a');
    assert.equal(snapshot?.state, 'failed');
    assert.deepEqual(snapshot?.error, {
      code: 'script_material_mismatch',
      message: '当前分镜图片无法承接所选模板',
      details: {
        unsupportedNarrativeBeats: beats.slice(0, 10),
        materialReason: '附图只展示成品',
        suggestedTemplateId: 'scene_seeding',
        suggestedTemplateName: '场景种草',
        validationIssues: issues.slice(0, 5),
        contentCharacterCount: 42,
        targetCharacterRange: [54, 59],
      },
    });
    assert.equal(JSON.stringify(snapshot).includes('sk-secret'), false, 'details 白名单不得透传密钥');
    assert.equal(JSON.stringify(snapshot).includes('upstream-raw-response'), false, 'details 白名单不得透传上游原文');
  }

  resetScriptGenerationManagerForTests();

  // ── 执行器抛错 → failed；AbortError 但管理器未取消 → failed（取消只能来自管理器）──
  {
    startScriptGeneration({
      projectId: 'project-a',
      generationId: 'gen-1',
      execute: async () => { throw new Error('上游网关超时'); },
    });
    await new Promise((r) => setTimeout(r, 0));
    const failed = getProjectScriptGeneration('project-a');
    assert.equal(failed?.state, 'failed');
    assert.equal(failed?.error?.code, 'script_generation_error');
    assert.equal(failed?.error?.message, '上游网关超时');
  }

  resetScriptGenerationManagerForTests();

  // ── 取消：迟到结果不得把 cancelled 改回成功或失败；进度回调丢弃 ──
  {
    let lateProgress: (() => void) | null = null;
    const gate = deferred<ScriptGenerationExecutionResult>();
    startScriptGeneration({
      projectId: 'project-a',
      generationId: 'gen-1',
      execute: ({ onProgress }) => {
        lateProgress = () => onProgress({ phase: 'generating', percent: 80, message: '迟到进度' });
        return gate.promise;
      },
    });
    assert.equal(cancelScriptGeneration('project-a', 'gen-1'), true);
    lateProgress!();
    gate.resolve(okResult); // 上游忽略 abort，稍后才返回
    await new Promise((r) => setTimeout(r, 0));
    const snapshot = getProjectScriptGeneration('project-a');
    assert.equal(snapshot?.state, 'cancelled', '迟到结果不得改变 cancelled 终态');
    assert.equal(snapshot?.draftId, null);
    assert.equal(snapshot?.progress.percent, 0, '取消后的进度回调必须丢弃');
    // 幂等：再取消返回 false（已终态）
    assert.equal(cancelScriptGeneration('project-a', 'gen-1'), false);
    assert.equal(cancelScriptGeneration('project-a', 'gen-missing'), false);
  }

  resetScriptGenerationManagerForTests();

  // ── 停机：拒绝新任务，运行中任务以 shutdown 原因取消 ──
  {
    const gate = deferred<ScriptGenerationExecutionResult>();
    startScriptGeneration({ projectId: 'project-a', generationId: 'gen-1', execute: () => gate.promise });
    const aborted = beginScriptGenerationShutdown();
    assert.equal(aborted, 1);
    assert.equal(isScriptGenerationShuttingDown(), true);
    const snapshot = getProjectScriptGeneration('project-a');
    assert.equal(snapshot?.state, 'cancelled');
    assert.equal(snapshot?.cancellationReason, 'shutdown');
    assert.throws(
      () => startScriptGeneration({ projectId: 'project-b', generationId: 'gen-2', execute: () => gate.promise }),
      (error: unknown) => error instanceof ScriptGenerationShuttingDownError
        && error.code === 'script_generation_shutting_down',
    );
    assert.equal(await waitForScriptGenerationsIdle(500), 0);
    gate.reject(new Error('进程已退出')); // 迟到 rejection 也必须被吞掉
    await new Promise((r) => setTimeout(r, 0));
  }

  resetScriptGenerationManagerForTests();

  // ── waitForScriptGenerationsIdle：有运行任务时等待，返回未完成数 ──
  {
    const gate = deferred<ScriptGenerationExecutionResult>();
    startScriptGeneration({ projectId: 'project-a', generationId: 'gen-1', execute: () => gate.promise });
    const waiter = waitForScriptGenerationsIdle(2_000);
    setTimeout(() => gate.resolve(okResult), 30);
    assert.equal(await waiter, 0);
    // 不结束的任务在超时后报告剩余数量
    startScriptGeneration({ projectId: 'project-a', generationId: 'gen-2', execute: () => deferred<ScriptGenerationExecutionResult>().promise });
    const startedAt = Date.now();
    assert.equal(await waitForScriptGenerationsIdle(100), 1);
    assert.ok(Date.now() - startedAt < 500, '等待必须受超时约束');
  }

  resetScriptGenerationManagerForTests();

  // ── 终态保留 10 分钟：过期后 GET 返回 null；活动索引在终态即释放 ──
  {
    let nowMs = 1_000_000;
    configureScriptGenerationManagerForTests({ now: () => nowMs });
    startScriptGeneration({
      projectId: 'project-a',
      generationId: 'gen-1',
      execute: async () => okResult,
    });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(getProjectScriptGeneration('project-a')?.state, 'succeeded', '无活动任务时仍返回最近终态');
    nowMs += 9 * 60 * 1000;
    assert.ok(getProjectScriptGeneration('project-a'), '10 分钟内必须保留终态');
    nowMs += 2 * 60 * 1000;
    assert.equal(getProjectScriptGeneration('project-a'), null, '终态过期后必须返回 null');
    configureScriptGenerationManagerForTests(null);
  }

  resetScriptGenerationManagerForTests();

  // ── 进程级单例：重复导入（模拟 Next 模块重载产生第二个模块实例）共享同一状态 ──
  {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'script-generation-manager-'));
    const copyPath = path.join(tempDir, 'script-generation-manager-copy.ts');
    fs.copyFileSync(
      path.join(process.cwd(), 'lib', 'script-generation-manager.ts'),
      copyPath,
    );
    const fresh = await import(pathToFileURL(copyPath).href) as typeof import('../lib/script-generation-manager.ts');
    const gate = deferred<ScriptGenerationExecutionResult>();
    startScriptGeneration({ projectId: 'project-a', generationId: 'gen-1', execute: () => gate.promise });
    const seenByFreshInstance = fresh.getProjectScriptGeneration('project-a');
    assert.equal(seenByFreshInstance?.generationId, 'gen-1', '第二个模块实例必须看到同一注册表');
    assert.equal(fresh.cancelScriptGeneration('project-a', 'gen-1'), true, '第二个模块实例必须能取消');
    assert.equal(getProjectScriptGeneration('project-a')?.state, 'cancelled');
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  resetScriptGenerationManagerForTests();

  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(unhandled, [], '不得产生未处理的 Promise rejection');

  console.log('script generation manager tests passed');
} finally {
  configureScriptGenerationManagerForTests(null);
  resetScriptGenerationManagerForTests();
}
