// node scripts/unified-kling-queue.test.ts
// Real SQLite + execution facade + video queue; provider adapter and downloads are fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { register } from 'node:module';

register('./typescript-extension-loader.mjs', import.meta.url);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unified-kling-queue-'));
const previousEnv = { ...process.env };
Object.assign(process.env, {
  CREATIVE_STUDIO_DATA_ROOT: root,
  CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
  CREATIVE_STUDIO_DEPLOYMENT_ID: 'unified-kling-queue-test',
  CREATIVE_STUDIO_INSTANCE_ID: 'unified-kling-queue-test-instance',
  CREATIVE_STUDIO_PORT: '43142',
  CREATIVE_STUDIO_TRUSTED_ORIGIN: 'https://studio.example.test',
});

const { getDb, closeDb } = await import('../lib/db.ts');
const {
  startTeamServiceRuntime,
  drainTeamRuntime,
  releaseTeamRuntimeOwner,
} = await import('../lib/team-service/runtime/index.ts');
const videoQueue = await import('../lib/video-queue.ts');
const videoProviders = await import('../lib/video-providers/index.ts');
const { seedVideoProviders } = await import('../lib/seed.ts');
const { seedProviders } = await import('../lib/seed.ts');
const { configureLegacyMediaProviderPool } = await import('../lib/legacy-media-execution.ts');
const { updateActorPolicy } = await import('../lib/media-core/execution/pools.ts');
const {
  UNIFIED_KLING3_ANCHOR_ID,
  UNIFIED_KLING3_CHANNELS,
  UNIFIED_KLING3_MODEL_KEY,
  UNIFIED_MEDIA_RULE_VERSION,
} = await import('../lib/media-core/unified-media/catalog.ts');
const {
  freezeUnifiedKlingVideoRequest,
} = await import('../lib/media-core/unified-media/video-requests.ts');
const { listUnifiedReconcileTasks } = await import('../lib/team-service/unified-reconcile.ts');
const { listTeamTasks } = await import('../lib/team-service/tasks.ts');
const { queryTeamUsage } = await import('../lib/team-service/usage.ts');
const { providerHttpError } = await import('../lib/media-core/submission-evidence.ts');
const { requestUnifiedKlingCancellation } = await import('../lib/media-core/unified-media/video-execution.ts');

const originalFetch = globalThis.fetch;
const png = await sharp({
  create: { width: 32, height: 48, channels: 3, background: '#eeeeee' },
}).png().toBuffer();
const qiniuBase = 'https://qiniu-kling.test';
const tencentBase = 'https://tencent-kling.test';
const qiniuKey = 'qiniu-kling-key';
const tencentKey = 'tencent-kling-key';
const submitted: Array<{
  prompt: string;
  model: string;
  durationSec: number;
  multiShot?: boolean;
  tailImagePath?: string;
}> = [];
let downloadFailureRemaining = 0;
const failedPollTasks = new Set<string>();

globalThis.fetch = (async (input) => {
  const url = String(input);
  if (url.startsWith('https://download-kling.test/')) {
    if (downloadFailureRemaining > 0) {
      downloadFailureRemaining -= 1;
      return new Response('download failed', { status: 500 });
    }
    return new Response(Buffer.from('fixture-mp4'), {
      status: 200,
      headers: { 'Content-Type': 'video/mp4' },
    });
  }
  throw new Error(`unexpected fetch: ${url}`);
}) as typeof fetch;

videoProviders.registerTestVideoAdapter('openai-video', {
  tailFrameCapability: (model) => ({
    supported: true,
    protocol: model.startsWith('qiniuyun/')
      ? 'company-gateway-qiniuyun-kling'
      : 'company-gateway-kling',
  }),
  submit: async (request) => {
    submitted.push({
      prompt: request.prompt,
      model: request.model,
      durationSec: request.durationSec,
      multiShot: request.multiShot,
      tailImagePath: request.tailImagePath,
    });
    if (request.prompt.includes('unknown-submit')) {
      throw providerHttpError(503, 'upstream unavailable');
    }
    if (request.prompt.includes('qiniu-explicit-failure')
      && request.model === 'qiniuyun/kling-3.0') {
      throw providerHttpError(400, 'single material rejected');
    }
    if (request.prompt.includes('tencent-fails-back-qiniu')
      && request.model === 'kling-3.0') {
      throw providerHttpError(400, 'tencent rejected');
    }
    return {
      providerTaskId: `${request.model.includes('qiniuyun') ? 'qiniu' : 'tencent'}-${request.prompt}`,
      rawResponse: null,
    };
  },
  poll: async (taskId) => {
    if (taskId.startsWith('qiniu-')
      && taskId.includes('qiniu-poll-terminal-failure')
      && !failedPollTasks.has(taskId)) {
      failedPollTasks.add(taskId);
      return {
        status: 'failed',
        errorMessage: 'provider terminal rejection',
        rawResponse: null,
      };
    }
    return {
      status: 'succeeded',
      videoUrl: `https://download-kling.test/${encodeURIComponent(taskId)}.mp4`,
      rawResponse: null,
    };
  },
  minimumPollingTimeoutMs: () => 0,
});

function insertMemberAndProject(
  db: ReturnType<typeof getDb>,
  projectId: string,
): { projectId: string; imageId: string; shotSetId: string; shotId: string } {
  const now = new Date().toISOString();
  const imagePath = path.join(root, `${projectId}.png`);
  fs.writeFileSync(imagePath, png);
  db.prepare(`INSERT INTO projects (id, name, providerId, model, prompt)
    VALUES (?, ?, 'company-gateway-image2-medium', 'image2-medium', 'prompt')`)
    .run(projectId, projectId);
  db.prepare(`INSERT INTO team_resource_scopes
    (resourceType, resourceId, ownerUserId, rootType, rootId, createdAt, updatedAt)
    VALUES ('project', ?, 'member', 'project', ?, ?, ?)`)
    .run(projectId, projectId, now, now);
  const imageId = `image-${projectId}`;
  db.prepare(`INSERT INTO image_assets (id, projectId, role, filename, path, mimeType, usage)
    VALUES (?, ?, 'input', ?, ?, 'image/png', 'scene_seed')`)
    .run(imageId, projectId, `${projectId}.png`, imagePath);
  const shotSetId = `shot-set-${projectId}`;
  const shotId = `shot-${projectId}`;
  db.prepare(`INSERT INTO shot_sets (id, projectId, name) VALUES (?, ?, ?)`)
    .run(shotSetId, projectId, projectId);
  db.prepare(`INSERT INTO shots (id, shotSetId, indexNum, sourceImageId)
    VALUES (?, ?, 1, ?)`).run(shotId, shotSetId, imageId);
  return { projectId, imageId, shotSetId, shotId };
}

function insertUnifiedJob(
  db: ReturnType<typeof getDb>,
  input: {
    id: string;
    projectId: string;
    imageId: string;
    shotSetId: string;
    shotId: string;
    prompt: string;
    resolution?: string;
    tailImageId?: string | null;
    multiShot?: boolean;
    durationSec?: number;
  },
) {
  const frozen = freezeUnifiedKlingVideoRequest({
    sourceImageId: input.imageId,
    tailImageId: input.tailImageId ?? null,
    referenceAssetIds: [],
    prompt: input.prompt,
    durationSec: input.durationSec ?? 5,
    generationMode: 'image-to-video',
    multiShot: input.multiShot ?? true,
    aspectRatio: '3:4',
    resolution: input.resolution ?? '1K',
  });
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO video_jobs (
      id, projectId, shotSetId, shotId, sourceImageId, tailImageId, providerId, model,
      prompt, durationSec, generationMode, aspectRatio, resolution, multiShot, status,
      attempt, maxAttempts, createdAt, unifiedModel, unifiedRuleVersion, unifiedRequestJson
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, 1, ?, ?, ?, ?)`)
    .run(
      input.id,
      input.projectId,
      input.shotSetId,
      input.shotId,
      input.imageId,
      frozen.tailImageId,
      UNIFIED_KLING3_ANCHOR_ID,
      UNIFIED_KLING3_MODEL_KEY,
      frozen.prompt,
      frozen.durationSec,
      frozen.generationMode,
      frozen.aspectRatio,
      frozen.resolution,
      frozen.multiShot === null ? null : frozen.multiShot ? 1 : 0,
      now,
      UNIFIED_KLING3_MODEL_KEY,
      UNIFIED_MEDIA_RULE_VERSION,
      JSON.stringify(frozen),
    );
  db.prepare(`INSERT INTO team_resource_scopes
    (resourceType, resourceId, ownerUserId, parentType, parentId, rootType, rootId, createdAt, updatedAt)
    VALUES ('video_job', ?, 'member', 'project', ?, 'project', ?, ?, ?)`)
    .run(input.id, input.projectId, input.projectId, now, now);
  db.prepare(`INSERT INTO team_task_principals
    (module, taskId, actorUserId, scopeType, scopeId, creationSnapshot, createdAt)
    VALUES ('video', ?, 'member', 'project', ?, ?, ?)`)
    .run(input.id, input.projectId, JSON.stringify(frozen), now);
  return frozen;
}

function submittedFor(prompt: string) {
  return submitted.filter((entry) => entry.prompt === prompt);
}

function videoStatus(id: string): string {
  return getDb().prepare('SELECT status FROM video_jobs WHERE id = ?').pluck().get(id) as string;
}

function unifiedChannel(jobId: string, channelKey: string) {
  return getDb().prepare(`
    SELECT c.* FROM execution_media_channels c
    JOIN video_jobs j ON j.unifiedTaskId = c.mediaTaskId
    WHERE j.id = ? AND c.channelKey = ?
  `).get(jobId, channelKey) as Record<string, unknown> | undefined;
}

try {
  const runtime = await startTeamServiceRuntime();
  assert.equal(runtime.ready, true, runtime.code);
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO team_users
    (id, employeeId, displayName, role, status, passwordHash, createdAt, updatedAt)
    VALUES ('member', 'member', 'Member', 'employee', 'active', 'hash', ?, ?)`).run(now, now);
  updateActorPolicy(db, {
    actorId: 'member',
    monthlyLimitMinor: null,
    personalConcurrency: 10,
    paused: false,
    expectedVersion: 0,
  });
  seedProviders();
  seedVideoProviders();
  const qiniu = UNIFIED_KLING3_CHANNELS.find((channel) => channel.channelKey === 'qiniu')!;
  const tencent = UNIFIED_KLING3_CHANNELS.find((channel) => channel.channelKey === 'tencent')!;
  db.prepare('UPDATE video_providers SET baseUrl = ?, apiKey = ?, enabled = 1 WHERE id = ?')
    .run(qiniuBase, qiniuKey, qiniu.providerId);
  db.prepare('UPDATE video_providers SET baseUrl = ?, apiKey = ?, enabled = 1 WHERE id = ?')
    .run(tencentBase, tencentKey, tencent.providerId);
  const qiniuPool = configureLegacyMediaProviderPool({
    baseUrl: qiniuBase, apiKey: qiniuKey, capacity: 10,
  });
  configureLegacyMediaProviderPool({
    baseUrl: tencentBase, apiKey: tencentKey, capacity: 4,
  });

  const tailPath = path.join(root, 'tail.png');
  fs.writeFileSync(tailPath, png);

  const first = insertMemberAndProject(db, 'project-qiniu-priority');
  db.prepare(`INSERT INTO image_assets (id, projectId, role, filename, path, mimeType, usage)
    VALUES ('tail-priority', ?, 'input', 'tail.png', ?, 'image/png', 'video_tail_frame')`)
    .run(first.projectId, tailPath);
  insertUnifiedJob(db, {
    id: 'job-qiniu-priority',
    projectId: first.projectId,
    imageId: first.imageId,
    shotSetId: first.shotSetId,
    shotId: first.shotId,
    prompt: 'qiniu-priority',
    tailImageId: 'tail-priority',
    durationSec: 10,
    multiShot: true,
  });
  insertUnifiedJob(db, {
    id: 'job-batch-row-two',
    projectId: first.projectId,
    imageId: first.imageId,
    shotSetId: first.shotSetId,
    shotId: first.shotId,
    prompt: 'batch-row-two',
    multiShot: false,
  });

  const fallback = insertMemberAndProject(db, 'project-fallback');
  insertUnifiedJob(db, {
    id: 'job-fallback',
    projectId: fallback.projectId,
    imageId: fallback.imageId,
    shotSetId: fallback.shotSetId,
    shotId: fallback.shotId,
    prompt: 'qiniu-explicit-failure',
  });

  const pollFailure = insertMemberAndProject(db, 'project-poll-failure');
  insertUnifiedJob(db, {
    id: 'job-poll-failure',
    projectId: pollFailure.projectId,
    imageId: pollFailure.imageId,
    shotSetId: pollFailure.shotSetId,
    shotId: pollFailure.shotId,
    prompt: 'qiniu-poll-terminal-failure',
  });

  const unknown = insertMemberAndProject(db, 'project-unknown');
  insertUnifiedJob(db, {
    id: 'job-unknown',
    projectId: unknown.projectId,
    imageId: unknown.imageId,
    shotSetId: unknown.shotSetId,
    shotId: unknown.shotId,
    prompt: 'unknown-submit',
  });

  const fourK = insertMemberAndProject(db, 'project-four-k');
  insertUnifiedJob(db, {
    id: 'job-four-k',
    projectId: fourK.projectId,
    imageId: fourK.imageId,
    shotSetId: fourK.shotSetId,
    shotId: fourK.shotId,
    prompt: 'four-k-tencent-only',
    resolution: '4K',
  });

  await Promise.all([
    videoQueue.runVideoQueue({
      projectId: first.projectId, concurrency: 2, timeoutMs: 30_000,
    }),
    videoQueue.runVideoQueue({
      projectId: fallback.projectId, concurrency: 2, timeoutMs: 30_000,
    }),
    videoQueue.runVideoQueue({
      projectId: pollFailure.projectId, concurrency: 2, timeoutMs: 30_000,
    }),
    videoQueue.runVideoQueue({
      projectId: unknown.projectId, concurrency: 2, timeoutMs: 30_000,
    }),
    videoQueue.runVideoQueue({
      projectId: fourK.projectId, concurrency: 2, timeoutMs: 30_000,
    }),
  ]);

  assert.equal(
    videoStatus('job-qiniu-priority'),
    'succeeded',
    String(db.prepare(`SELECT errorMessage FROM video_jobs WHERE id = 'job-qiniu-priority'`).pluck().get() ?? ''),
  );
  assert.equal(submittedFor('qiniu-priority').length, 1);
  assert.equal(submittedFor('qiniu-priority')[0].model, 'qiniuyun/kling-3.0');
  assert.equal(submittedFor('qiniu-priority')[0].durationSec, 10);
  assert.equal(submittedFor('qiniu-priority')[0].multiShot, true);
  assert.equal(submittedFor('qiniu-priority')[0].tailImagePath, tailPath);
  const firstJob = db.prepare(`SELECT providerId, model, localVideoPath, unifiedTaskId
    FROM video_jobs WHERE id = 'job-qiniu-priority'`).get() as Record<string, unknown>;
  assert.equal(firstJob.providerId, UNIFIED_KLING3_ANCHOR_ID);
  assert.equal(firstJob.model, UNIFIED_KLING3_MODEL_KEY);
  assert.ok(firstJob.localVideoPath);
  assert.ok(firstJob.unifiedTaskId);
  assert.equal(unifiedChannel('job-qiniu-priority', 'qiniu')?.state, 'succeeded');
  assert.equal(unifiedChannel('job-qiniu-priority', 'tencent')?.state, 'candidate');
  assert.equal(videoStatus('job-batch-row-two'), 'succeeded');
  assert.equal(submittedFor('batch-row-two').length, 1);
  assert.equal(submittedFor('batch-row-two')[0].multiShot, false);

  assert.equal(
    videoStatus('job-fallback'),
    'succeeded',
    JSON.stringify(db.prepare(`SELECT status, providerStatus, providerTaskId, errorMessage
      FROM video_jobs WHERE id = 'job-fallback'`).get()),
  );
  assert.deepEqual(
    submittedFor('qiniu-explicit-failure').map((entry) => entry.model),
    ['qiniuyun/kling-3.0', 'kling-3.0'],
  );
  assert.equal(unifiedChannel('job-fallback', 'qiniu')?.state, 'not_created');
  assert.equal(unifiedChannel('job-fallback', 'tencent')?.state, 'succeeded');
  const fallbackAttempts = db.prepare(`
    SELECT a.providerSnapshotJson, a.terminalState, a.remoteId, a.reservedMinor, a.actualMinor, a.costState,
      o.channelKey
    FROM execution_attempts a
    JOIN execution_operations o ON o.id = a.operationId
    JOIN video_jobs j ON j.unifiedTaskId = o.mediaTaskId
    WHERE j.id = 'job-fallback'
    ORDER BY a.createdAt, a.transportSeq
  `).all() as Array<{
    providerSnapshotJson: string;
    terminalState: string | null;
    remoteId: string | null;
    reservedMinor: number;
    actualMinor: number | null;
    costState: string;
    channelKey: string;
  }>;
  assert.equal(fallbackAttempts.length, 2);
  assert.equal(fallbackAttempts[0].channelKey, 'qiniu');
  assert.equal(fallbackAttempts[0].terminalState, 'not_created');
  assert.equal(fallbackAttempts[0].costState, 'released');
  assert.equal(fallbackAttempts[1].channelKey, 'tencent');
  assert.equal(fallbackAttempts[1].terminalState, 'succeeded');
  assert.equal(fallbackAttempts[1].costState, 'settled');
  assert.equal(JSON.parse(fallbackAttempts[1].providerSnapshotJson).model, 'kling-3.0');
  assert.equal(
    db.prepare(`SELECT COUNT(*) FROM video_jobs
      WHERE projectId = ? AND localVideoPath IS NOT NULL`).pluck().get(fallback.projectId),
    1,
    '两次通道尝试只登记一份成片',
  );
  assert.equal(videoStatus('job-poll-failure'), 'succeeded');
  assert.deepEqual(
    submittedFor('qiniu-poll-terminal-failure').map((entry) => entry.model),
    ['qiniuyun/kling-3.0', 'kling-3.0'],
  );
  assert.equal(unifiedChannel('job-poll-failure', 'qiniu')?.state, 'failed');
  assert.equal(unifiedChannel('job-poll-failure', 'tencent')?.state, 'succeeded');
  const fallbackTask = listTeamTasks(db, { userId: 'member', role: 'employee' }).items
    .find((item) => item.taskId === 'job-fallback');
  assert.equal(fallbackTask?.unifiedModel, UNIFIED_KLING3_MODEL_KEY);
  assert.equal(fallbackTask?.model, '可灵 3.0');
  const fallbackUsage = queryTeamUsage(db, { userId: 'member', role: 'employee' }, { module: 'video' })
    .items.filter((item) => item.taskId === 'job-fallback');
  assert.equal(fallbackUsage.length, 2);
  assert.equal(fallbackUsage.every((item) => item.unifiedModel === UNIFIED_KLING3_MODEL_KEY), true);

  assert.equal(videoStatus('job-unknown'), 'needs_check');
  assert.equal(submittedFor('unknown-submit').length, 1);
  assert.equal(submittedFor('unknown-submit')[0].model, 'qiniuyun/kling-3.0');
  assert.equal(unifiedChannel('job-unknown', 'qiniu')?.state, 'unknown');
  assert.equal(unifiedChannel('job-unknown', 'tencent')?.state, 'candidate');

  assert.equal(videoStatus('job-four-k'), 'succeeded');
  assert.equal(submittedFor('four-k-tencent-only').length, 1);
  assert.equal(submittedFor('four-k-tencent-only')[0].model, 'kling-3.0');
  assert.equal(unifiedChannel('job-four-k', 'tencent')?.state, 'succeeded');

  db.prepare('UPDATE execution_pools SET capacity = 0 WHERE poolKey = ?').run(qiniuPool);
  const capacity = insertMemberAndProject(db, 'project-capacity');
  insertUnifiedJob(db, {
    id: 'job-capacity',
    projectId: capacity.projectId,
    imageId: capacity.imageId,
    shotSetId: capacity.shotSetId,
    shotId: capacity.shotId,
    prompt: 'qiniu-full-immediate-tencent',
  });
  await videoQueue.runVideoQueue({
    projectId: capacity.projectId, concurrency: 2, timeoutMs: 30_000,
  });
  assert.equal(videoStatus('job-capacity'), 'succeeded');
  assert.equal(submittedFor('qiniu-full-immediate-tencent').length, 1);
  assert.equal(submittedFor('qiniu-full-immediate-tencent')[0].model, 'kling-3.0');
  assert.equal(unifiedChannel('job-capacity', 'qiniu')?.state, 'overflowed');
  assert.equal(unifiedChannel('job-capacity', 'tencent')?.state, 'succeeded');

  updateActorPolicy(db, {
    actorId: 'member',
    monthlyLimitMinor: 1,
    personalConcurrency: 10,
    paused: false,
    expectedVersion: 1,
  });
  const budgetCapacity = insertMemberAndProject(db, 'project-budget-capacity');
  insertUnifiedJob(db, {
    id: 'job-budget-capacity',
    projectId: budgetCapacity.projectId,
    imageId: budgetCapacity.imageId,
    shotSetId: budgetCapacity.shotSetId,
    shotId: budgetCapacity.shotId,
    prompt: 'qiniu-full-but-budget-blocked',
  });
  insertUnifiedJob(db, {
    id: 'job-budget-history',
    projectId: budgetCapacity.projectId,
    imageId: budgetCapacity.imageId,
    shotSetId: budgetCapacity.shotSetId,
    shotId: budgetCapacity.shotId,
    prompt: 'historical-success',
  });
  db.prepare(`UPDATE video_jobs SET status = 'succeeded', providerStatus = 'succeeded',
    providerTaskId = 'historical-remote' WHERE id = 'job-budget-history'`).run();
  const budgetCapacityRun = videoQueue.runVideoQueue({
    projectId: budgetCapacity.projectId, concurrency: 2, timeoutMs: 30_000,
  });
  const budgetDeadline = Date.now() + 5_000;
  while (Date.now() < budgetDeadline && videoStatus('job-budget-capacity') !== 'deferred') {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(videoStatus('job-budget-capacity'), 'deferred');
  assert.equal(submittedFor('qiniu-full-but-budget-blocked').length, 0,
    'budget-blocked requests must not be treated as qiniu capacity spillover');
  assert.equal(unifiedChannel('job-budget-capacity', 'qiniu')?.state, 'selected');
  assert.equal(unifiedChannel('job-budget-capacity', 'tencent')?.state, 'candidate');
  videoQueue.cancelVideoQueue(budgetCapacity.projectId);
  assert.equal(
    db.prepare(`SELECT cancelRequestedAt FROM video_jobs WHERE id = 'job-budget-history'`).pluck().get(),
    null,
    'project-level cancellation must not pollute terminal history',
  );
  await budgetCapacityRun;
  updateActorPolicy(db, {
    actorId: 'member',
    monthlyLimitMinor: null,
    personalConcurrency: 10,
    paused: false,
    expectedVersion: 2,
  });

  const reverse = insertMemberAndProject(db, 'project-reverse');
  insertUnifiedJob(db, {
    id: 'job-reverse',
    projectId: reverse.projectId,
    imageId: reverse.imageId,
    shotSetId: reverse.shotSetId,
    shotId: reverse.shotId,
    prompt: 'tencent-fails-back-qiniu',
  });
  const reverseRun = videoQueue.runVideoQueue({
    projectId: reverse.projectId, concurrency: 2, timeoutMs: 30_000,
  });
  const reverseDeadline = Date.now() + 12_000;
  while (Date.now() < reverseDeadline) {
    const tencentState = unifiedChannel('job-reverse', 'tencent')?.state;
    if (videoStatus('job-reverse') === 'deferred' && tencentState === 'not_created') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(unifiedChannel('job-reverse', 'tencent')?.state, 'not_created');
  assert.equal(unifiedChannel('job-reverse', 'qiniu')?.state, 'waiting_capacity');
  db.prepare('UPDATE execution_pools SET capacity = 10 WHERE poolKey = ?').run(qiniuPool);
  await reverseRun;
  if (videoStatus('job-reverse') !== 'succeeded') {
    await videoQueue.runVideoQueue({
      projectId: reverse.projectId, concurrency: 2, timeoutMs: 30_000,
    });
  }
  assert.equal(videoStatus('job-reverse'), 'succeeded');
  assert.deepEqual(
    submittedFor('tencent-fails-back-qiniu').map((entry) => entry.model),
    ['kling-3.0', 'qiniuyun/kling-3.0'],
    '腾讯溢出后明确失败可回到尚未提交过的七牛，且总提交仍为两次',
  );
  assert.equal(unifiedChannel('job-reverse', 'tencent')?.state, 'not_created');
  assert.equal(unifiedChannel('job-reverse', 'qiniu')?.state, 'succeeded');
  db.prepare('UPDATE execution_pools SET capacity = 10 WHERE poolKey = ?').run(qiniuPool);

  const download = insertMemberAndProject(db, 'project-download');
  insertUnifiedJob(db, {
    id: 'job-download',
    projectId: download.projectId,
    imageId: download.imageId,
    shotSetId: download.shotSetId,
    shotId: download.shotId,
    prompt: 'download-refetch-no-fallback',
  });
  downloadFailureRemaining = 1;
  await videoQueue.runVideoQueue({
    projectId: download.projectId, concurrency: 2, timeoutMs: 30_000,
  });
  assert.equal(videoStatus('job-download'), 'succeeded');
  assert.equal(submittedFor('download-refetch-no-fallback').length, 1);
  assert.equal(unifiedChannel('job-download', 'qiniu')?.state, 'succeeded');
  assert.equal(unifiedChannel('job-download', 'tencent')?.state, 'candidate');
  assert.equal(submittedFor('download-refetch-no-fallback').length, 1);

  const canceled = insertMemberAndProject(db, 'project-canceled-before-submit');
  insertUnifiedJob(db, {
    id: 'job-canceled-before-submit',
    projectId: canceled.projectId,
    imageId: canceled.imageId,
    shotSetId: canceled.shotSetId,
    shotId: canceled.shotId,
    prompt: 'cancel-before-submit',
  });
  db.prepare('UPDATE video_jobs SET cancelRequestedAt = ? WHERE id = ?')
    .run(new Date().toISOString(), 'job-canceled-before-submit');
  await videoQueue.runVideoQueue({
    projectId: canceled.projectId, concurrency: 2, timeoutMs: 30_000,
  });
  assert.equal(videoStatus('job-canceled-before-submit'), 'canceled');
  assert.equal(submittedFor('cancel-before-submit').length, 0);

  const lateCanceled = insertMemberAndProject(db, 'project-canceled-late-result');
  insertUnifiedJob(db, {
    id: 'job-canceled-late-result',
    projectId: lateCanceled.projectId,
    imageId: lateCanceled.imageId,
    shotSetId: lateCanceled.shotSetId,
    shotId: lateCanceled.shotId,
    prompt: 'cancel-after-accepted',
  });
  const lateRun = videoQueue.runVideoQueue({
    projectId: lateCanceled.projectId, concurrency: 2, timeoutMs: 30_000,
  });
  const acceptedDeadline = Date.now() + 2_000;
  while (Date.now() < acceptedDeadline
    && db.prepare('SELECT providerTaskId FROM video_jobs WHERE id = ?').pluck().get('job-canceled-late-result')
      !== 'qiniu-cancel-after-accepted') {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(
    db.prepare('SELECT providerTaskId FROM video_jobs WHERE id = ?').pluck().get('job-canceled-late-result'),
    'qiniu-cancel-after-accepted',
  );
  requestUnifiedKlingCancellation(db, 'job-canceled-late-result');
  await lateRun;
  const lateJob = db.prepare(`SELECT status, providerStatus, cancelRequestedAt,
      localVideoPath, filename, errorMessage
    FROM video_jobs WHERE id = ?`).get('job-canceled-late-result') as {
      status: string; providerStatus: string | null; cancelRequestedAt: string | null;
      localVideoPath: string | null; filename: string | null; errorMessage: string | null;
    };
  assert.equal(lateJob.status, 'canceled');
  assert.equal(lateJob.providerStatus, 'succeeded');
  assert.ok(lateJob.cancelRequestedAt);
  assert.ok(lateJob.localVideoPath, 'late video is retained on the canceled task');
  assert.ok(lateJob.filename);
  assert.match(lateJob.errorMessage ?? '', /晚到|收尾/);
  const lateParent = db.prepare(`SELECT id, status, resultJson FROM execution_media_tasks
    WHERE module = 'video' AND taskId = 'job-canceled-late-result'`).get() as {
      id: string; status: string; resultJson: string;
    };
  assert.equal(lateParent.status, 'canceled');
  const lateResult = JSON.parse(lateParent.resultJson) as Record<string, unknown>;
  assert.equal(lateResult.lateResult, true);
  assert.equal(lateResult.filename, lateJob.filename);
  assert.equal(
    db.prepare(`SELECT state FROM execution_media_channels
      WHERE mediaTaskId = ? AND channelKey = 'qiniu'`).pluck().get(lateParent.id),
    'succeeded',
  );
  assert.equal(submittedFor('cancel-after-accepted').length, 1, 'late result is downloaded without another submit');

  const reconcile = listUnifiedReconcileTasks(db, { userId: 'admin', role: 'admin' });
  assert.equal(
    reconcile.items.some((item) => item.taskId === 'job-fallback' && item.module === 'video'),
    true,
    '视频统一任务进入同一管理员核对投影',
  );

  console.log('unified Kling queue tests passed (paid calls: 0)');
} finally {
  globalThis.fetch = originalFetch;
  await drainTeamRuntime(5_000);
  await releaseTeamRuntimeOwner();
  closeDb();
  process.env = previousEnv;
  fs.rmSync(root, { recursive: true, force: true });
}
