// node scripts/unified-kling-create.test.ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unified-kling-create-'));
const previousEnv = { ...process.env };
Object.assign(process.env, {
  CREATIVE_STUDIO_DATA_ROOT: root,
  CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
  CREATIVE_STUDIO_DEPLOYMENT_ID: 'unified-kling-create-test',
  CREATIVE_STUDIO_INSTANCE_ID: 'unified-kling-create-test-instance',
  CREATIVE_STUDIO_PORT: '43126',
  CREATIVE_STUDIO_TRUSTED_ORIGIN: 'https://studio.example.test',
});
fs.mkdirSync(path.join(root, 'data'), { recursive: true });
fs.writeFileSync(path.join(root, 'data', 'deployment.json'), JSON.stringify({
  version: 1,
  mode: 'server',
  deploymentId: 'unified-kling-create-test',
}));

const { getDb, closeDb } = await import('../lib/db.ts');
const { seedProviders, seedVideoProviders } = await import('../lib/seed.ts');
const { createVideoJobsForShot } = await import('../lib/video-job-create.ts');
const { runWithAccessContext } = await import('../lib/media-core/access-context.ts');
const {
  UNIFIED_KLING3_ANCHOR_ID,
  UNIFIED_KLING3_CHANNELS,
  UNIFIED_KLING3_MODEL_KEY,
} = await import('../lib/media-core/unified-media/catalog.ts');

const db = getDb();
seedProviders();
seedVideoProviders();
const teamContext = {
  kind: 'team' as const,
  actor: { userId: 'member', role: 'employee' as const },
  assertAccess() {},
  resolveOwner() { return 'member'; },
  registerRootScope() {},
  registerInheritedScope() {},
  registerTaskPrincipal() {},
};
db.prepare(`INSERT INTO providers (id, name, type, baseUrl, apiKey, model, enabled)
  VALUES ('image-provider', '图片', 'openai-compatible', 'https://image.test', 'image-key', 'image2-medium', 1)`)
  .run();
const png = await sharp({
  create: { width: 32, height: 48, channels: 3, background: '#eeeeee' },
}).png().toBuffer();
const imagePath = path.join(root, 'source.png');
const tailPath = path.join(root, 'tail.png');
fs.writeFileSync(imagePath, png);
fs.writeFileSync(tailPath, png);

db.prepare(`INSERT INTO projects (id, name, providerId, model, prompt)
  VALUES ('project-create', '项目', 'image-provider', 'image2-medium', 'prompt')`).run();
db.prepare(`INSERT INTO image_assets
  (id, projectId, role, filename, path, mimeType, usage)
  VALUES ('source-create', 'project-create', 'input', 'source.png', ?, 'image/png', 'scene_seed')`)
  .run(imagePath);
db.prepare(`INSERT INTO image_assets
  (id, projectId, role, filename, path, mimeType, usage)
  VALUES ('tail-create', 'project-create', 'input', 'tail.png', ?, 'image/png', 'video_tail_frame')`)
  .run(tailPath);
db.prepare(`INSERT INTO shot_sets (id, projectId, name)
  VALUES ('set-create', 'project-create', '分镜组')`).run();
db.prepare(`INSERT INTO shots (id, shotSetId, indexNum, sourceImageId)
  VALUES ('shot-create', 'set-create', 1, 'source-create')`).run();

for (const channel of UNIFIED_KLING3_CHANNELS) {
  db.prepare(`UPDATE video_providers SET baseUrl = ?, apiKey = ?, enabled = 1 WHERE id = ?`)
    .run(`https://${channel.channelKey}-configured.test`, `${channel.channelKey}-key`, channel.providerId);
}

async function create(items: Parameters<typeof createVideoJobsForShot>[0]['items']) {
  return runWithAccessContext(teamContext, () => createVideoJobsForShot({
    shotSetId: 'set-create',
    shotId: 'shot-create',
    items,
    batch: true,
    db,
  }));
}

try {
  const first = await create([
    {
      prompt: '首尾帧推进',
      templateId: null,
      providerId: UNIFIED_KLING3_ANCHOR_ID,
      durationSec: 10,
      tailImageId: 'tail-create',
      multiShot: true,
      generationMode: 'image-to-video',
      referenceAssetIds: [],
      aspectRatio: '3:4',
      resolution: '1K',
    },
    {
      prompt: '4K 腾讯单通道',
      templateId: null,
      providerId: UNIFIED_KLING3_ANCHOR_ID,
      durationSec: 5,
      tailImageId: null,
      multiShot: false,
      generationMode: 'image-to-video',
      referenceAssetIds: [],
      aspectRatio: '16:9',
      resolution: '4K',
    },
  ]);
  if (!first.ok) throw new Error(first.error);
  assert.equal(first.ok, true);
  assert.equal(first.videoJobIds.length, 2);
  const jobs = db.prepare(`SELECT * FROM video_jobs WHERE id IN (?, ?) ORDER BY createdAt, rowid`)
    .all(...first.videoJobIds) as Array<Record<string, unknown>>;
  assert.equal(jobs.length, 2);
  for (const job of jobs) {
    assert.equal(job.providerId, UNIFIED_KLING3_ANCHOR_ID);
    assert.equal(job.model, UNIFIED_KLING3_MODEL_KEY);
    assert.equal(job.unifiedModel, UNIFIED_KLING3_MODEL_KEY);
    assert.equal(job.maxAttempts, 1);
    assert.ok(job.unifiedRequestJson);
  }
  const firstRequest = JSON.parse(String(jobs[0].unifiedRequestJson)) as Record<string, unknown>;
  assert.equal(firstRequest.tailImageId, 'tail-create');
  assert.equal(firstRequest.durationSec, 10);
  assert.equal(firstRequest.multiShot, true);
  const secondRequest = JSON.parse(String(jobs[1].unifiedRequestJson)) as Record<string, unknown>;
  assert.equal(secondRequest.resolution, '4K');
  assert.equal(secondRequest.tailImageId, null);
  assert.equal(secondRequest.multiShot, false);

  const omittedItem = {
    prompt: '省略智能分镜',
    templateId: null,
    providerId: UNIFIED_KLING3_ANCHOR_ID,
    durationSec: 5,
    tailImageId: null,
    generationMode: 'image-to-video',
    referenceAssetIds: [],
    aspectRatio: '3:4',
    resolution: '1K',
  } as unknown as Parameters<typeof createVideoJobsForShot>[0]['items'][number];
  const omittedMultiShot = await create([omittedItem]);
  if (!omittedMultiShot.ok) throw new Error(omittedMultiShot.error);
  const omittedJob = db.prepare('SELECT * FROM video_jobs WHERE id = ?')
    .get(omittedMultiShot.videoJobIds[0]) as Record<string, unknown>;
  assert.equal(omittedJob.multiShot, null, 'omitted storyboard flag stays nullable');
  assert.equal(
    (JSON.parse(String(omittedJob.unifiedRequestJson)) as Record<string, unknown>).multiShot,
    null,
    'frozen request must match the nullable business field on recovery',
  );

  const countBeforeInvalid = db.prepare('SELECT COUNT(*) FROM video_jobs').pluck().get() as number;
  const unsupported = await create([{
    prompt: '非法时长',
    templateId: null,
    providerId: UNIFIED_KLING3_ANCHOR_ID,
    durationSec: 16,
    tailImageId: null,
    multiShot: true,
    generationMode: 'image-to-video',
    referenceAssetIds: [],
    aspectRatio: '3:4',
    resolution: '1K',
  }]);
  assert.equal(unsupported.ok, false);
  if (!unsupported.ok) assert.match(unsupported.error, /3–15|时长/);

  const referenceMode = await create([{
    prompt: '参考模式',
    templateId: null,
    providerId: UNIFIED_KLING3_ANCHOR_ID,
    durationSec: 5,
    tailImageId: null,
    multiShot: true,
    generationMode: 'reference-to-video',
    referenceAssetIds: [],
    aspectRatio: '3:4',
    resolution: '1K',
  }]);
  assert.equal(referenceMode.ok, false);
  if (!referenceMode.ok) assert.match(referenceMode.error, /只开放图生视频|图生视频/);
  assert.equal(
    db.prepare('SELECT COUNT(*) FROM video_jobs').pluck().get(),
    countBeforeInvalid,
    '非法组合和未开放模式必须在创建前拒绝',
  );

  const directChannel = await runWithAccessContext(teamContext, () => createVideoJobsForShot({
    shotSetId: 'set-create',
    shotId: 'shot-create',
    items: [{
      prompt: '直接真实通道',
      templateId: null,
      providerId: UNIFIED_KLING3_CHANNELS[0].providerId,
      durationSec: 5,
      tailImageId: null,
      multiShot: true,
      generationMode: 'image-to-video',
      referenceAssetIds: [],
      aspectRatio: '3:4',
      resolution: '1K',
    }],
    batch: true,
    db,
  }));
  assert.equal(directChannel.ok, false);
  if (!directChannel.ok) assert.match(directChannel.error, /统一模型|真实通道/);
  assert.equal(db.prepare('SELECT COUNT(*) FROM video_jobs').pluck().get(), countBeforeInvalid);

  db.prepare(`UPDATE video_providers SET enabled = 0 WHERE id IN (?, ?)`)
    .run(UNIFIED_KLING3_CHANNELS[0].providerId, UNIFIED_KLING3_CHANNELS[1].providerId);
  const unavailable = await create([{
    prompt: '无通道',
    templateId: null,
    providerId: UNIFIED_KLING3_ANCHOR_ID,
    durationSec: 5,
    tailImageId: null,
    multiShot: true,
    generationMode: 'image-to-video',
    referenceAssetIds: [],
    aspectRatio: '3:4',
    resolution: '1K',
  }]);
  assert.equal(unavailable.ok, false);
  if (!unavailable.ok) assert.match(unavailable.error, /通道/);
  assert.equal(db.prepare('SELECT COUNT(*) FROM video_jobs').pluck().get(), countBeforeInvalid);

  process.env.CREATIVE_STUDIO_DEPLOYMENT_MODE = 'local';
  const localUnified = await create([{
    prompt: '本地版不得启用统一可灵',
    templateId: null,
    providerId: UNIFIED_KLING3_ANCHOR_ID,
    durationSec: 5,
    tailImageId: null,
    multiShot: true,
    generationMode: 'image-to-video',
    referenceAssetIds: [],
    aspectRatio: '3:4',
    resolution: '1K',
  }]);
  assert.equal(localUnified.ok, false);
  if (!localUnified.ok) assert.match(localUnified.error, /团队版/);

  console.log('unified Kling creation tests passed');
} finally {
  closeDb();
  process.env = previousEnv;
  fs.rmSync(root, { recursive: true, force: true });
}
