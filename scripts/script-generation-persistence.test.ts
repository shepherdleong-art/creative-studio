import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-script-generation-persistence-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = dataRoot;
process.env.CREATIVE_STUDIO_DEPLOYMENT_MODE = 'server';
process.env.CREATIVE_STUDIO_PORT = '3300';
process.env.CREATIVE_STUDIO_DEPLOYMENT_ID = 'script-generation-persistence';
process.env.CREATIVE_STUDIO_TRUSTED_ORIGIN = 'https://studio.test';

const { ensureServerDeploymentMarker, readRuntimeConfig } = await import('../lib/team-service/config.ts');
const runtimeConfig = readRuntimeConfig();
assert.ok(runtimeConfig.mode === 'server');
ensureServerDeploymentMarker(runtimeConfig);
const { getDb, closeDb } = await import('../lib/db.ts');
const {
  getPersistentProjectScriptGeneration,
  recoverPersistentScriptGenerations,
  registerPersistentScriptGenerationExecutor,
  resetPersistentScriptGenerationWorkersForTests,
  startPersistentScriptGeneration,
  waitForPersistentScriptGenerationsIdle,
} = await import('../lib/script-generation-manager.ts');

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function task(db: Database.Database, input: {
  projectId: string;
  generationId: string;
  actorId: string;
  inputSnapshot?: unknown;
}) {
  return {
    db,
    projectId: input.projectId,
    generationId: input.generationId,
    actor: { userId: input.actorId },
    scope: { resourceType: 'project', resourceId: input.projectId },
    inputSnapshot: input.inputSnapshot ?? { body: { shotSetId: 'set-1' } },
    executorKey: 'test-v3',
    draftId: `draft-${input.generationId}`,
  };
}

const db = getDb();
const executions: string[] = [];
const drafts = new Set<string>();
const firstRun = deferred<void>();

registerPersistentScriptGenerationExecutor('test-v3', async (context) => {
  executions.push(`${context.actor.userId}:${context.generationId}`);
  if (context.generationId === 'gen-restart' && executions.filter((id) => id.endsWith('gen-restart')).length === 1) {
    await firstRun.promise;
  }
  drafts.add(context.draftId);
  return { status: 200, body: { draftId: context.draftId, script: { version: 3 } } };
});

try {
  const started = startPersistentScriptGeneration(task(db, {
    projectId: 'project-a', generationId: 'gen-restart', actorId: 'user-a',
  }));
  assert.equal(started.created, true);
  assert.equal(started.snapshot.state, 'running');
  assert.equal(started.snapshot.draftId, 'draft-gen-restart', '受理时固定最终草稿 ID');
  const accepted = db.prepare(`
    SELECT actorId, scopeType, scopeId, inputJson, executorKey, checkpointJson
    FROM script_generation_tasks WHERE generationId = 'gen-restart'
  `).get() as Record<string, unknown>;
  assert.equal(accepted.actorId, 'user-a');
  assert.equal(accepted.scopeType, 'project');
  assert.equal(accepted.scopeId, 'project-a');
  assert.equal(accepted.executorKey, 'test-v3');
  assert.match(String(accepted.inputJson), /set-1/);
  assert.equal(typeof accepted.checkpointJson, 'string');

  resetPersistentScriptGenerationWorkersForTests();
  const running = getPersistentProjectScriptGeneration(db, 'project-a');
  assert.equal(running?.state, 'running', '重启前记录必须仍在运行态');
  assert.equal(running?.draftId, 'draft-gen-restart');
  firstRun.resolve();
  await recoverPersistentScriptGenerations(db);
  assert.equal(await waitForPersistentScriptGenerationsIdle(db, 500), 0);
  assert.equal(getPersistentProjectScriptGeneration(db, 'project-a')?.state, 'succeeded');
  assert.equal(executions.filter((id) => id === 'user-a:gen-restart').length, 2,
    '新 worker 仅凭持久记录重建执行，不依赖旧闭包');

  // 模拟草稿事务已提交、任务终态尚未写回的崩溃窗口。
  db.prepare("UPDATE script_generation_tasks SET state='running', finishedAt=NULL WHERE generationId='gen-restart'").run();
  const draftCountBefore = drafts.size;
  await recoverPersistentScriptGenerations(db);
  assert.equal(drafts.size, draftCountBefore, '恢复不得重复创建最终草稿');
  assert.equal(db.prepare("SELECT COUNT(*) FROM script_generation_tasks WHERE generationId='gen-restart' AND draftId='draft-gen-restart'").pluck().get(), 1);

  startPersistentScriptGeneration(task(db, {
    projectId: 'project-a', generationId: 'gen-a-2', actorId: 'user-a', inputSnapshot: { body: { marker: 'A' } },
  }));
  startPersistentScriptGeneration(task(db, {
    projectId: 'project-b', generationId: 'gen-b-1', actorId: 'user-b', inputSnapshot: { body: { marker: 'B' } },
  }));
  await waitForPersistentScriptGenerationsIdle(db, 500);
  assert.equal(getPersistentProjectScriptGeneration(db, 'project-a')?.draftId, 'draft-gen-a-2');
  assert.equal(getPersistentProjectScriptGeneration(db, 'project-b')?.draftId, 'draft-gen-b-1');
  const principals = db.prepare(`
    SELECT generationId, actorId, scopeId FROM script_generation_tasks
    WHERE generationId IN ('gen-a-2', 'gen-b-1') ORDER BY generationId
  `).all();
  assert.deepEqual(principals, [
    { generationId: 'gen-a-2', actorId: 'user-a', scopeId: 'project-a' },
    { generationId: 'gen-b-1', actorId: 'user-b', scopeId: 'project-b' },
  ], '用户切换或停用不得串用 actor/scope 与草稿');

  console.log('script generation persistence tests passed');
} finally {
  firstRun.resolve();
  resetPersistentScriptGenerationWorkersForTests();
  closeDb();
  fs.rmSync(dataRoot, { recursive: true, force: true });
  delete process.env.CREATIVE_STUDIO_DEPLOYMENT_MODE;
}
