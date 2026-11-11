import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { register } from 'node:module';

// node scripts/legacy-video-cancel-races.test.ts
// 真实队列与执行记录，隔离 SQLite 和 loopback 媒体，覆盖取消与提交的竞态。
register('./typescript-extension-loader.mjs', import.meta.url);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-video-cancel-races-'));
const previousEnv = { ...process.env };
Object.assign(process.env, {
  CREATIVE_STUDIO_DATA_ROOT: root,
  CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
  CREATIVE_STUDIO_DEPLOYMENT_ID: 'legacy-video-cancel-races',
  CREATIVE_STUDIO_INSTANCE_ID: 'legacy-video-cancel-races-instance',
  CREATIVE_STUDIO_PORT: '43118',
  CREATIVE_STUDIO_TRUSTED_ORIGIN: 'https://studio.example.test',
});
const [database, runtimeModule, queue, providers, legacy, cancellation, pools, ffmpeg] = await Promise.all([
  import('../lib/db.ts'), import('../lib/team-service/runtime/index.ts'),
  import('../lib/video-queue.ts'), import('../lib/video-providers/index.ts'),
  import('../lib/legacy-media-execution.ts'), import('../lib/legacy-media-cancel.ts'),
  import('../lib/media-core/execution/pools.ts'), import('../lib/ffmpeg.ts'),
]);

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), 30_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

let videoBytes: Buffer = Buffer.alloc(0);
const server = http.createServer((request, response) => {
  if (request.url === '/result.mp4') {
    response.writeHead(200, { 'content-type': 'video/mp4', 'content-length': videoBytes.length });
    response.end(videoBytes);
  } else {
    response.writeHead(404).end();
  }
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address !== 'string');
const baseUrl = `http://127.0.0.1:${address.port}`;
const failures: unknown[] = [];

try {
  const runtime = await runtimeModule.startTeamServiceRuntime();
  assert.equal(runtime.ready, true, runtime.code);
  const db = database.getDb();
  const facade = runtimeModule.getTeamExecutionFacade();
  const now = new Date().toISOString();
  const inputPath = path.join(root, 'input.png');
  await sharp({ create: { width: 16, height: 16, channels: 3, background: '#eeeeee' } }).png().toFile(inputPath);
  const videoPath = path.join(root, 'result.mp4');
  await ffmpeg.runFfmpeg([
    '-f', 'lavfi', '-i', 'color=c=black:s=32x32:r=24', '-t', '1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', videoPath,
  ]);
  videoBytes = fs.readFileSync(videoPath);
  db.prepare(`INSERT INTO team_users (id, employeeId, displayName, role, status, passwordHash, createdAt, updatedAt)
    VALUES ('member', 'member', 'member', 'employee', 'active', 'hash', ?, ?)`).run(now, now);
  pools.updateActorPolicy(db, {
    actorId: 'member', monthlyLimitMinor: null, personalConcurrency: 1, paused: false, expectedVersion: 0,
  });
  db.prepare(`INSERT INTO providers (id, name, baseUrl, apiKeyEnv, apiKey, model, type, enabled)
    VALUES ('ip', 'ip', ?, '', 'key', 'image2', 'gateway-task-image', 1)`).run(baseUrl);
  db.prepare(`INSERT INTO video_providers (id, name, type, baseUrlEnv, apiKeyEnv, modelEnv,
      defaultModel, enabled, baseUrl, apiKey)
    VALUES ('vp', 'vp', 'openai-video', '', '', '', 'kling-2.5', 1, ?, 'key')`).run(baseUrl);
  legacy.configureLegacyMediaProviderPool({ baseUrl, apiKey: 'key', capacity: 4 });

  function fixture(id: string): void {
    db.prepare(`INSERT INTO projects (id, name, providerId, model, prompt)
      VALUES (?, ?, 'ip', 'kling-2.5', 'prompt')`).run(id, id);
    db.prepare(`INSERT INTO team_resource_scopes (resourceType, resourceId, ownerUserId, rootType, rootId, createdAt, updatedAt)
      VALUES ('project', ?, 'member', 'project', ?, ?, ?)`).run(id, id, now, now);
    db.prepare(`INSERT INTO image_assets (id, projectId, role, filename, path, mimeType)
      VALUES (?, ?, 'input', 'input.png', ?, 'image/png')`).run(`image-${id}`, id, inputPath);
    addJob(id, id);
  }
  function addJob(id: string, projectId: string): void {
    db.prepare(`INSERT INTO video_jobs (id, projectId, sourceImageId, providerId, model, prompt,
        durationSec, status, attempt, maxAttempts, createdAt)
      VALUES (?, ?, ?, 'vp', 'kling-2.5', ?, 5, 'pending', 0, 2, ?)`)
      .run(id, projectId, `image-${projectId}`, id, now);
    db.prepare(`INSERT INTO team_task_principals (module, taskId, actorUserId, scopeType, scopeId, creationSnapshot, createdAt)
      VALUES ('video', ?, 'member', 'project', ?, '{}', ?)`).run(id, projectId, now);
    db.prepare(`INSERT INTO team_resource_scopes (resourceType, resourceId, ownerUserId, parentType, parentId,
        rootType, rootId, createdAt, updatedAt)
      VALUES ('video_job', ?, 'member', 'project', ?, 'project', ?, ?, ?)`).run(id, projectId, projectId, now, now);
  }
  function run(id: string): Promise<void> {
    return queue.runVideoQueue({ projectId: id, concurrency: 1, timeoutMs: 20_000 });
  }
  function readJob(id: string) {
    return db.prepare(`SELECT status, providerStatus, providerTaskId, cancelRequestedAt, localVideoPath
      FROM video_jobs WHERE id = ?`).get(id) as {
        status: string; providerStatus: string | null; providerTaskId: string | null;
        cancelRequestedAt: string | null; localVideoPath: string | null;
      };
  }
  function assertSettled(id: string, status: 'succeeded' | 'failed'): void {
    assert.equal(db.prepare(`SELECT status FROM execution_operations
      WHERE module = 'video' AND taskId = ?`).pluck().get(id), status,
    '已提交任务必须在原执行记录结算');
    assert.equal(db.prepare(`SELECT COUNT(*) FROM execution_reservations r
      JOIN execution_operations o ON o.id = r.operationId
      WHERE o.taskId = ? AND r.kind = 'concurrency' AND r.state = 'held'`).pluck().get(id), 0,
    '远端终态必须释放并发名额');
  }
  async function test(name: string, body: () => Promise<void>): Promise<void> {
    try {
      await body();
      console.log(`PASS ${name}`);
    } catch (error) {
      failures.push(error);
      console.error(`FAIL ${name}`, error);
      await queue.drainVideoQueues();
    }
  }

  await test('取消发生于 markSubmitting 完成前，不再发送 POST', async () => {
    const id = 'cancel-before-transmit';
    fixture(id);
    let submits = 0;
    const entered = barrier();
    const resume = barrier();
    const markSubmitting = facade.markSubmitting;
    facade.markSubmitting = async (input) => {
      const intent = await markSubmitting(input);
      entered.release();
      await resume.promise;
      return intent;
    };
    providers.registerTestVideoAdapter('openai-video', {
      submit: async () => {
        submits += 1;
        return { providerTaskId: `remote-${id}`, rawResponse: null };
      },
      poll: async () => ({ status: 'failed', errorMessage: 'fixture terminal', rawResponse: null }),
      minimumPollingTimeoutMs: () => 0,
    });
    const running = run(id);
    try {
      await bounded(entered.promise, 'markSubmitting barrier');
      cancellation.applyLegacyVideoJobCancel(db, id);
      resume.release();
      await bounded(running, id);
      assert.equal(submits, 0, '取消意图必须在 markSubmitting 后、真实 POST 前复核');
      assert.equal(readJob(id).status, 'canceled');
      assertSettled(id, 'failed');
    } finally {
      facade.markSubmitting = markSubmitting;
      resume.release();
      await bounded(running, `${id} cleanup`);
    }
  });

  for (const outcome of ['succeeded', 'failed'] as const) {
    await test(`POST 在途取消，远端 ${outcome} 后自动收尾`, async () => {
      const id = `cancel-submit-${outcome}`;
      fixture(id);
      let submits = 0;
      const entered = barrier();
      const resume = barrier();
      providers.registerTestVideoAdapter('openai-video', {
        submit: async () => {
          submits += 1;
          entered.release();
          await resume.promise;
          return { providerTaskId: `remote-${id}`, rawResponse: null };
        },
        poll: async () => outcome === 'succeeded'
          ? { status: 'succeeded', videoUrl: `${baseUrl}/result.mp4`, rawResponse: null }
          : { status: 'failed', errorMessage: 'fixture terminal', rawResponse: null },
        minimumPollingTimeoutMs: () => 0,
      });
      const running = run(id);
      try {
        await bounded(entered.promise, 'submit barrier');
        assert.equal(readJob(id).providerTaskId, null, '请求在途尚无业务远端 ID');
        cancellation.applyLegacyVideoJobCancel(db, id);
        resume.release();
        await bounded(running, id);
        const job = readJob(id);
        assert.ok(job.cancelRequestedAt);
        assert.equal(submits, 1, '取消后只能沿原提交收尾，不能重复生成');
        assert.equal(job.providerStatus, outcome);
        assert.equal(job.status, outcome === 'failed' ? 'canceled' : 'succeeded');
        if (outcome === 'succeeded') assert.ok(job.localVideoPath && fs.existsSync(job.localVideoPath));
        assertSettled(id, outcome);
      } finally {
        resume.release();
        await bounded(running, `${id} cleanup`);
      }
    });
  }

  await test('项目停止后无需重启，已受理任务继续查询至失败终态', async () => {
    const id = 'cancel-project-accepted';
    fixture(id);
    let submits = 0;
    let polls = 0;
    let aborted = false;
    const entered = barrier();
    const resume = barrier();
    providers.registerTestVideoAdapter('openai-video', {
      submit: async () => {
        submits += 1;
        return { providerTaskId: `remote-${id}`, rawResponse: null };
      },
      poll: async (_taskId, _apiKey, _baseUrl, signal) => {
        polls += 1;
        if (polls === 1) {
          entered.release();
          await resume.promise;
          aborted = signal?.aborted ?? false;
          if (aborted) throw new DOMException('Aborted', 'AbortError');
          return { status: 'processing', rawResponse: null };
        }
        return { status: 'failed', errorMessage: 'fixture terminal', rawResponse: null };
      },
      minimumPollingTimeoutMs: () => 0,
    });
    const running = run(id);
    try {
      await bounded(entered.promise, 'first poll barrier');
      queue.cancelVideoQueue(id);
      resume.release();
      await bounded(running, id);
      assert.equal(aborted, false, '用户停止后续生成不得中断已受理任务的只读收尾');
      assert.equal(submits, 1);
      assert.ok(polls >= 2, '无需额外 runVideoQueue 或重启就应查到远端终态');
      assert.equal(readJob(id).status, 'canceled');
      assert.equal(readJob(id).providerStatus, 'failed');
      assertSettled(id, 'failed');
    } finally {
      resume.release();
      await bounded(running, `${id} cleanup`);
    }
  });
  await test('项目停止取消旧待提交任务，收尾期间显式新建任务仍会执行', async () => {
    const id = 'cancel-project-then-create';
    const pendingId = `${id}-old-pending`;
    const newId = `${id}-new`;
    fixture(id);
    const submitted: string[] = [];
    const entered = barrier();
    const resume = barrier();
    providers.registerTestVideoAdapter('openai-video', {
      submit: async (request) => {
        submitted.push(request.prompt);
        return { providerTaskId: `remote-${request.prompt}`, rawResponse: null };
      },
      poll: async (taskId) => {
        if (taskId === `remote-${id}`) {
          entered.release();
          await resume.promise;
        }
        return { status: 'failed', errorMessage: 'fixture terminal', rawResponse: null };
      },
      minimumPollingTimeoutMs: () => 0,
    });
    const running = run(id);
    try {
      await bounded(entered.promise, 'accepted task barrier');
      addJob(pendingId, id);
      queue.cancelVideoQueue(id);
      assert.equal(readJob(pendingId).status, 'canceled', '停止时已存在的未提交任务立即取消');
      assert.ok(readJob(pendingId).cancelRequestedAt);
      addJob(newId, id);
      assert.equal(queue.getVideoQueueStatus(id), 'running', '已有队列正在收尾，新建入口会复用该队列');
      resume.release();
      await bounded(running, id);
      assert.deepEqual(submitted, [id, newId], '取消旧任务后，显式新建任务仍应被普通 worker 领取');
      assert.equal(readJob(pendingId).providerTaskId, null, '旧待提交任务不得发送供应商请求');
      assert.equal(readJob(newId).status, 'failed', '新任务必须运行至模拟供应商终态，不能遗留 pending');
      assert.equal(readJob(newId).cancelRequestedAt, null, '新任务不得继承此前的取消意图');
      assertSettled(id, 'failed');
      assertSettled(newId, 'failed');
    } finally {
      resume.release();
      await bounded(running, `${id} cleanup`);
    }
  });
  if (failures.length) throw new AggregateError(failures, 'legacy video cancellation races failed');
  console.log('legacy video cancellation race tests passed');
} finally {
  await queue.drainVideoQueues();
  await runtimeModule.drainTeamRuntime(5_000);
  runtimeModule.releaseTeamRuntimeOwner();
  database.closeDb();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  process.env = previousEnv;
  fs.rmSync(root, { recursive: true, force: true });
}