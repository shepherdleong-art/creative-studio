import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { register } from 'node:module';

// 端到端复现线上那条卡住的任务：
//   老通道（kling-2.5，非统一模型）任务提交后、轮询中途用户点取消。
// 修复前：业务行 canceled、执行记录永远 accepted，任务中心一直显示「供应商已受理」。
// 修复后：执行记录收敛到终态，任务中心的 effectiveStatus 显示「已取消」。
register('./typescript-extension-loader.mjs', import.meta.url);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-cancel-settle-'));
const previousEnv = { ...process.env };
Object.assign(process.env, {
  CREATIVE_STUDIO_DATA_ROOT: root,
  CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
  CREATIVE_STUDIO_DEPLOYMENT_ID: 'legacy-cancel-settle',
  CREATIVE_STUDIO_INSTANCE_ID: 'legacy-cancel-settle-instance',
  CREATIVE_STUDIO_PORT: '43117',
  CREATIVE_STUDIO_TRUSTED_ORIGIN: 'https://studio.example.test',
});

const [
  { getDb, closeDb },
  { startTeamServiceRuntime, drainTeamRuntime, releaseTeamRuntimeOwner },
  videoQueue,
  videoProviders,
  { updateActorPolicy },
] = await Promise.all([
  import('../lib/db.ts'),
  import('../lib/team-service/runtime/index.ts'),
  import('../lib/video-queue.ts'),
  import('../lib/video-providers/index.ts'),
  import('../lib/media-core/execution/pools.ts'),
]);
const { configureLegacyMediaProviderPool } = await import('../lib/legacy-media-execution.ts');
const { listTeamTasks } = await import('../lib/team-service/tasks.ts');
const { applyLegacyVideoJobCancel } = await import('../lib/legacy-media-cancel.ts');

const runtime = await startTeamServiceRuntime();
assert.equal(runtime.ready, true, runtime.code);

const db = getDb();
const now = new Date().toISOString();
const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#eeeeee' } }).png().toBuffer();
const inputPath = path.join(root, 'input.png');
fs.writeFileSync(inputPath, png);
const baseUrl = 'http://127.0.0.1:43117';

let submits = 0;
let polls = 0;
let firstPollStarted!: () => void;
const firstPoll = new Promise<void>((resolve) => { firstPollStarted = resolve; });
let releaseFirstPoll!: () => void;
const firstPollRelease = new Promise<void>((resolve) => { releaseFirstPoll = resolve; });

const server = http.createServer((req, res) => {
  res.writeHead(404).end();
});
await new Promise<void>((resolve) => server.listen(43117, '127.0.0.1', resolve));

try {
  db.prepare(`INSERT INTO team_users (id, employeeId, displayName, role, status, passwordHash, createdAt, updatedAt)
    VALUES ('member', 'member', 'member', 'employee', 'active', 'hash', ?, ?)`).run(now, now);
  updateActorPolicy(db, {
    actorId: 'member', monthlyLimitMinor: null, personalConcurrency: 1, paused: false, expectedVersion: 0,
  });
  db.prepare(`INSERT INTO providers (id, name, baseUrl, apiKeyEnv, apiKey, model, type, enabled)
    VALUES ('ip', 'ip', ?, '', 'key', 'image2', 'gateway-task-image', 1)`).run(baseUrl);
  db.prepare(`INSERT INTO video_providers (id, name, type, baseUrlEnv, apiKeyEnv, modelEnv,
      defaultModel, enabled, baseUrl, apiKey, accessKey, secretKey)
    VALUES ('vp', 'vp', 'openai-video', '', '', '', 'kling-2.5', 1, ?, 'key', 'ak', 'sk')`).run(baseUrl);
  db.prepare(`INSERT INTO projects (id, name, providerId, model, prompt)
    VALUES ('project', 'project', 'ip', 'kling-2.5', 'prompt')`).run();
  db.prepare(`INSERT INTO team_resource_scopes (resourceType, resourceId, ownerUserId, rootType, rootId, createdAt, updatedAt)
    VALUES ('project', 'project', 'member', 'project', 'project', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO image_assets (id, projectId, role, filename, path, mimeType)
    VALUES ('image', 'project', 'input', 'input.png', ?, 'image/png')`).run(inputPath);
  db.prepare(`INSERT INTO video_jobs (id, projectId, sourceImageId, providerId, model, prompt,
      durationSec, status, attempt, maxAttempts, createdAt)
    VALUES ('job', 'project', 'image', 'vp', 'kling-2.5', 'prompt', 5, 'pending', 0, 2, ?)`).run(now);
  db.prepare(`INSERT INTO team_task_principals (module, taskId, actorUserId, scopeType, scopeId, creationSnapshot, createdAt)
    VALUES ('video', 'job', 'member', 'project', 'project', '{}', ?)`).run(now);
  db.prepare(`INSERT INTO team_resource_scopes (resourceType, resourceId, ownerUserId, parentType, parentId,
      rootType, rootId, createdAt, updatedAt)
    VALUES ('video_job', 'job', 'member', 'project', 'project', 'project', 'project', ?, ?)`).run(now, now);
  configureLegacyMediaProviderPool({ baseUrl, apiKey: 'key' });

  videoProviders.registerTestVideoAdapter('openai-video', {
    submit: async () => {
      submits += 1;
      return { providerTaskId: 'remote-stuck', rawResponse: null };
    },
    poll: async () => {
      polls += 1;
      if (polls === 1) {
        firstPollStarted();
        await firstPollRelease;
        return { status: 'processing', rawResponse: null };
      }
      // 取消后远端最终返回失败：验证「已取消」不会被改写成「失败」
      return { status: 'failed', errorMessage: 'remote failed after cancel', rawResponse: null };
    },
    minimumPollingTimeoutMs: () => 0,
  });

  const run = videoQueue.runVideoQueue({ projectId: 'project', concurrency: 1, timeoutMs: 60_000 });
  await firstPoll;

  // 用户点「停止后续生成」——正是线上那条任务的触发路径
  const cancel = applyLegacyVideoJobCancel(db, 'job');
  assert.equal(cancel?.acceptedSubmittedWork, true, '已受理任务应识别为「已提交」');
  assert.equal(
    db.prepare(`SELECT status FROM video_jobs WHERE id = 'job'`).pluck().get(),
    'running',
    '已受理任务取消后必须保持 running，交给队列继续收尾',
  );

  // 取消后轮询继续；这里让远端明确失败，验证取消语义不被改写
  releaseFirstPoll();
  await run;

  const job = db.prepare(`SELECT status, providerStatus, cancelRequestedAt, errorMessage
    FROM video_jobs WHERE id = 'job'`).get() as {
      status: string; providerStatus: string | null; cancelRequestedAt: string | null; errorMessage: string | null;
    };
  assert.ok(job.cancelRequestedAt, '取消意图必须持久化');
  assert.equal(submits, 1, '取消不得触发重新提交（不得重复付费）');

  const operations = db.prepare(`SELECT status, waitReason FROM execution_operations
    WHERE module = 'video' AND taskId = 'job'`).all() as Array<{ status: string; waitReason: string | null }>;
  assert.equal(operations.length, 1);
  assert.notEqual(operations[0]!.status, 'accepted', '执行记录不得停在 accepted');

  // 任务中心看到的必须与项目页一致：已取消
  const tasks = listTeamTasks(db, { userId: 'member', role: 'employee' }, {}, { page: 1, pageSize: 25 });
  const view = tasks.items.find((item) => item.taskId === 'job');
  assert.ok(view, '任务列表应包含这条任务');
  assert.equal(view!.status, 'canceled', '任务中心必须显示已取消，而不是「供应商已受理」');

  console.log('legacy cancel settles task center test passed');
} finally {
  server.close();
  // 先排空运行时再关库：drain 会回写 execution_instances，库已关会抛「连接未打开」。
  try { await drainTeamRuntime(5_000); } catch { /* 测试收尾，忽略排空异常 */ }
  releaseTeamRuntimeOwner();
  closeDb();
  process.env = previousEnv;
  fs.rmSync(root, { recursive: true, force: true });
}
