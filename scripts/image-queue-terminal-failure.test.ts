// node scripts/image-queue-terminal-failure.test.ts
// Real queue + isolated SQLite; replay gateway failures without paid calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';

register('./typescript-extension-loader.mjs', import.meta.url);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'image-queue-terminal-'));
const previousEnv = { ...process.env };
Object.assign(process.env, {
  CREATIVE_STUDIO_DATA_ROOT: root,
  CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
  CREATIVE_STUDIO_DEPLOYMENT_ID: 'image-terminal-test',
  CREATIVE_STUDIO_INSTANCE_ID: 'image-terminal-test-instance',
  CREATIVE_STUDIO_PORT: '43108',
  CREATIVE_STUDIO_TRUSTED_ORIGIN: 'https://studio.example.test',
});

const { getDb, closeDb } = await import('../lib/db.ts');
const { startTeamServiceRuntime, drainTeamRuntime, releaseTeamRuntimeOwner } = await import('../lib/team-service/runtime/index.ts');
const queue = await import('../lib/queue.ts');
const { configureLegacyMediaProviderPool } = await import('../lib/legacy-media-execution.ts');
const { updateActorPolicy } = await import('../lib/media-core/execution/pools.ts');
const { listTeamErrors } = await import('../lib/team-service/diagnostics.ts');
const originalFetch = globalThis.fetch;
let polls = 0;
let submissions = 0;
let pollTransportFailure = false;
let remoteError = '[BadRequestError] Your request was rejected by the safety system.';
globalThis.fetch = (async (_input, init) => {
  assert.ok(String(_input).startsWith('https://gateway.example.test/'), '仅允许模拟供应商请求');
  if (init?.method === 'POST') {
    submissions += 1;
    return Response.json({ id: 'remote-failed-image', status: 'queued', progress: 0 });
  }
  polls += 1;
  if (pollTransportFailure) throw new TypeError('fetch failed');
  return Response.json({
    id: 'remote-failed-image', status: 'failed', progress: 100,
    error: { message: remoteError },
  });
}) as typeof fetch;

try {
  const runtime = await startTeamServiceRuntime();
  assert.equal(runtime.ready, true, runtime.code);
  const db = getDb();
  const now = new Date().toISOString();
  const inputPath = path.join(root, 'input.png');
  fs.writeFileSync(inputPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  db.prepare(`INSERT INTO team_users (id, employeeId, displayName, role, status, passwordHash, createdAt, updatedAt)
    VALUES ('member', 'member', 'member', 'employee', 'active', 'hash', ?, ?)`).run(now, now);
  updateActorPolicy(db, { actorId: 'member', monthlyLimitMinor: null, personalConcurrency: 10, paused: false, expectedVersion: 0 });
  db.prepare(`INSERT INTO providers (id, name, type, baseUrl, apiKey, model, enabled)
    VALUES ('gateway', 'gateway', 'gateway-task-image', 'https://gateway.example.test', 'fixture-key-value', 'image2-medium', 1)`).run();
  db.prepare(`INSERT INTO projects (id, name, providerId, model, prompt)
    VALUES ('project', 'project', 'gateway', 'image2-medium', 'prompt')`).run();
  db.prepare(`INSERT INTO image_assets (id, projectId, role, filename, path, mimeType)
    VALUES ('input', 'project', 'input', 'input.png', ?, 'image/png')`).run(inputPath);
  db.prepare(`INSERT INTO jobs (id, projectId, inputImageId, providerId, model, prompt, size, quality,
      status, attempt, maxAttempts, providerTaskId)
    VALUES ('job', 'project', 'input', 'gateway', 'image2-medium', 'prompt', '1024x1024', 'standard',
      'needs_check', 1, 5, 'remote-failed-image')`).run();
  db.prepare(`INSERT INTO team_resource_scopes (resourceType, resourceId, ownerUserId, rootType, rootId, createdAt, updatedAt)
    VALUES ('project', 'project', 'member', 'project', 'project', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO team_resource_scopes (resourceType, resourceId, ownerUserId, parentType, parentId, rootType, rootId, createdAt, updatedAt)
    VALUES ('job', 'job', 'member', 'project', 'project', 'project', 'project', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO team_task_principals (module, taskId, actorUserId, scopeType, scopeId, creationSnapshot, createdAt)
    VALUES ('image', 'job', 'member', 'project', 'project', '{}', ?)`).run(now);

  const readJob = (id: string) => db.prepare('SELECT status, providerStatus, providerTaskId, attempt, errorMessage FROM jobs WHERE id = ?')
    .get(id) as { status: string; providerStatus: string; providerTaskId: string; attempt: number; errorMessage: string };
  function seedJob(id: string, providerId: string, accepted = false): void {
    db.prepare(`INSERT INTO jobs (id, projectId, inputImageId, providerId, model, prompt, size, quality,
        status, attempt, maxAttempts, providerTaskId)
      VALUES (?, 'project', 'input', ?, 'image2-medium', 'prompt', '1024x1024', 'standard', ?, ?, 5, ?)`)
      .run(id, providerId, accepted ? 'needs_check' : 'pending', accepted ? 1 : 0, accepted ? 'remote-failed-image' : null);
    db.prepare(`INSERT INTO team_resource_scopes (resourceType, resourceId, ownerUserId, parentType, parentId, rootType, rootId, createdAt, updatedAt)
      VALUES ('job', ?, 'member', 'project', 'project', 'project', 'project', ?, ?)`).run(id, now, now);
    db.prepare(`INSERT INTO team_task_principals (module, taskId, actorUserId, scopeType, scopeId, creationSnapshot, createdAt)
      VALUES ('image', ?, 'member', 'project', 'project', '{}', ?)`).run(id, now);
  }
  async function runBoundedQueue(id: string): Promise<void> {
    const deadline = setTimeout(() => queue.cancelQueue('project'), 12_000);
    try {
      await queue.runQueue({ projectId: 'project', jobId: id, concurrency: 1, maxAttempts: 5, timeoutMs: 30_000 });
    } finally {
      clearTimeout(deadline);
    }
  }

  await queue.resumeImageJobPolling('job');
  const job = readJob('job');
  assert.equal(job.status, 'failed', '远端明确 failed 后必须停止，不能重新进入 needs_check 续查');
  assert.equal(job.providerStatus, 'failed');
  assert.equal(job.providerTaskId, 'remote-failed-image', '保留失败任务身份供诊断');
  assert.equal(job.attempt, 1, '续查不能增加付费提交次数');
  assert.match(job.errorMessage, /safety system/);
  assert.equal(polls, 1);
  assert.equal(submissions, 0);
  await queue.runQueue({ projectId: 'project', concurrency: 1, maxAttempts: 5, timeoutMs: 30_000 });
  assert.equal(polls, 1, '重启队列不能再次领取已失败的任务');
  assert.equal(submissions, 0, '远端失败不能自动重新付费提交');

  // 新提交任务也必须在失败后释放 execution 名额，并只留一条错误记录。
  configureLegacyMediaProviderPool({ baseUrl: 'https://gateway.example.test', apiKey: 'fixture-key-value', capacity: 1 });
  for (const type of ['gateway-task-image', 'geekai-json']) {
    const providerId = `provider-${type}`;
    db.prepare(`INSERT INTO providers (id, name, type, baseUrl, apiKey, model, enabled)
      VALUES (?, ?, ?, 'https://gateway.example.test', 'fixture-key-value', 'image2-medium', 1)`)
      .run(providerId, providerId, type);
    for (const mode of ['server', 'local']) {
      process.env.CREATIVE_STUDIO_DEPLOYMENT_MODE = mode;
      remoteError = mode === 'server' ? 'upstream task failed' : 'rejected by the safety system';
      const id = `${type}-${mode}`;
      seedJob(id, providerId);
      const before: { polls: number; submissions: number } = { polls, submissions };
      await runBoundedQueue(id);
      assert.equal(readJob(id).status, 'failed', `${id}: 明确失败不能自动续查或重试`);
      assert.equal(readJob(id).providerStatus, 'failed');
      assert.equal(readJob(id).attempt, 1);
      assert.equal(polls - before.polls, 1);
      assert.equal(submissions - before.submissions, 1);
      await runBoundedQueue(id);
      assert.equal(submissions - before.submissions, 1, '重启不能产生第二次付费提交');
      assert.equal(polls - before.polls, 1, '重启不能继续轮询终态任务');
      if (mode === 'server') {
        assert.equal(db.prepare('SELECT status FROM execution_operations WHERE taskId = ?').pluck().get(id), 'failed');
        assert.equal(db.prepare(`SELECT COUNT(*) FROM execution_reservations WHERE kind = 'concurrency' AND state = 'held'`).pluck().get(), 0);
        assert.equal(listTeamErrors(db, { userId: 'member', role: 'employee' }).items.filter((item) => item.taskId === id).length, 1);
      }
    }
  }

  // 传输错误仍可续查同一任务；下次收到明确失败才停止。
  process.env.CREATIVE_STUDIO_DEPLOYMENT_MODE = 'server';
  seedJob('transport-error', 'gateway', true);
  const beforeTransport = submissions;
  pollTransportFailure = true;
  await queue.resumeImageJobPolling('transport-error');
  assert.equal(readJob('transport-error').status, 'needs_check');
  assert.equal(readJob('transport-error').providerTaskId, 'remote-failed-image');
  pollTransportFailure = false;
  await queue.resumeImageJobPolling('transport-error');
  assert.equal(readJob('transport-error').status, 'failed');
  assert.equal(readJob('transport-error').attempt, 1);
  assert.equal(submissions, beforeTransport, '断网恢复只能续查，不能重新提交');
  console.log('image queue terminal failure tests passed (paid calls: 0)');
} finally {
  globalThis.fetch = originalFetch;
  await drainTeamRuntime(5_000);
  await releaseTeamRuntimeOwner();
  closeDb();
  process.env = previousEnv;
  fs.rmSync(root, { recursive: true, force: true });
}
