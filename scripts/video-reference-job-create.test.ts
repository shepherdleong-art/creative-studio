import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'video-reference-job-create-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
const { getDb, closeDb } = await import('../lib/db.ts');
const { createVideoJobsForShot, parseVideoJobCreationItem } = await import('../lib/video-job-create.ts');

const db = getDb();
const sourcePath = path.join(root, 'source.png');
await sharp({ create: { width: 1600, height: 900, channels: 3, background: '#2468ac' } }).png().toFile(sourcePath);
db.prepare("INSERT INTO providers (id, name, baseUrl) VALUES ('images', 'images', 'http://local')").run();
db.prepare(`INSERT INTO projects (id, name, providerId, model, prompt) VALUES
  ('project', 'project', 'images', 'model', ''), ('other', 'other', 'images', 'model', '')`).run();
db.prepare(`INSERT INTO image_assets (id, projectId, role, filename, path, originalWidth, originalHeight)
  VALUES ('source', 'project', 'input', 'source.png', ?, 1600, 900)`).run(sourcePath);
db.prepare("INSERT INTO shot_sets (id, projectId, name) VALUES ('set', 'project', 'set')").run();
db.prepare("INSERT INTO shots (id, shotSetId, sourceImageId, indexNum) VALUES ('shot', 'set', 'source', 1)").run();
for (const [id, type, model] of [
  ['sd25', 'jimeng', 'doubao-seedance-2-5-260628'],
  ['sd20', 'jimeng', 'doubao-seedance-2-0-260128'],
  ['wan', 'openai-video', 'wan-3.0'],
  ['kling4', 'openai-video', 'qiniuyun/kling-4.0'],
] as const) {
  db.prepare(`INSERT INTO video_providers
    (id, name, type, defaultModel, baseUrlEnv, apiKeyEnv, modelEnv, baseUrl, apiKey, enabled)
    VALUES (?, ?, ?, ?, '', '', '', 'http://local', 'key', 1)`).run(id, id, type, model);
}
const insertAsset = db.prepare(`INSERT INTO video_reference_assets
  (id, projectId, kind, filename, path, mimeType, byteSize, durationSec) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
insertAsset.run('image', 'project', 'image', 'image.png', sourcePath, 'image/png', 100, null);
insertAsset.run('video', 'project', 'video', 'video.mp4', sourcePath, 'video/mp4', 100, 4);
insertAsset.run('audio', 'project', 'audio', 'audio.mp3', sourcePath, 'audio/mpeg', 100, 3);
insertAsset.run('long-video', 'project', 'video', 'long.mp4', sourcePath, 'video/mp4', 100, 15);
insertAsset.run('foreign', 'other', 'image', 'foreign.png', sourcePath, 'image/png', 100, null);

function item(overrides: Record<string, unknown> = {}) {
  const parsed = parseVideoJobCreationItem({
    providerId: 'sd25', prompt: 'reference', durationSec: 20,
    generationMode: 'reference-to-video', referenceAssetIds: ['video', 'image', 'audio'],
    ...overrides,
  });
  assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.error);
  return parsed.ok ? parsed.item : assert.fail('unreachable');
}
async function create(items = [item()], batch = false) {
  return createVideoJobsForShot({ db, shotSetId: 'set', shotId: 'shot', items, batch });
}
function stored() {
  return db.prepare(`SELECT id, generationMode, aspectRatio, resolution, sourceImageId FROM video_jobs ORDER BY rowid`).all() as Array<{
    id: string; generationMode: string; aspectRatio: string | null; resolution: string | null; sourceImageId: string;
  }>;
}
function links(jobId: string) {
  return (db.prepare('SELECT orderIndex, assetId FROM video_job_references WHERE jobId = ? ORDER BY orderIndex').all(jobId) as Array<{ orderIndex: number; assetId: string }>)
    .map((row) => row.assetId);
}

try {
  const single = await create();
  assert.equal(single.ok, true, single.ok ? '' : single.error);
  const singleRow = stored()[0];
  assert.deepEqual(singleRow, {
    id: singleRow.id, generationMode: 'reference-to-video', aspectRatio: '16:9', resolution: '1080p', sourceImageId: 'source',
  });
  assert.deepEqual(links(singleRow.id), ['video', 'image', 'audio'], '参考顺序必须按请求冻结');

  db.exec('DELETE FROM video_jobs');
  const batch = await create([item(), item()], true);
  assert.equal(batch.ok, true, batch.ok ? '' : batch.error);
  const batchRows = stored();
  assert.equal(batchRows.length, 2);
  for (const row of batchRows) {
    assert.equal(row.generationMode, singleRow.generationMode);
    assert.equal(row.aspectRatio, singleRow.aspectRatio);
    assert.equal(row.resolution, singleRow.resolution);
    assert.equal(row.sourceImageId, singleRow.sourceImageId);
    assert.deepEqual(links(row.id), ['video', 'image', 'audio']);
  }

  for (const [label, draft, pattern] of [
    ['重复参考', item({ referenceAssetIds: ['image', 'image'] }), /不能重复/],
    ['跨项目参考', item({ referenceAssetIds: ['foreign'] }), /不属于当前项目/],
    ['参考尾帧互斥', item({ tailImageId: 'tail' }), /不能携带尾帧图/],
    ['首尾帧不得带参考', item({ generationMode: 'image-to-video', durationSec: 5 }), /不得携带全能参考素材/],
    ['2.0 纯音频', item({ providerId: 'sd20', durationSec: 5, referenceAssetIds: ['audio'] }), /必须搭配图片或视频/],
    ['Wan 输入加输出', item({ providerId: 'wan', referenceAssetIds: ['long-video'] }), /输入视频加输出不能超过 30 秒/],
  ] as const) {
    db.exec('DELETE FROM video_jobs');
    const result = await create([draft]);
    assert.equal(result.ok, false, label);
    if (!result.ok) {
      assert.equal(result.status, 400, label);
      assert.match(result.error, pattern, label);
    }
    assert.equal(stored().length, 0, `${label} 不得落任务`);
  }

  db.exec('DELETE FROM video_jobs');
  const atomic = await create([item(), item({ referenceAssetIds: ['foreign'] })], true);
  assert.equal(atomic.ok, false);
  assert.equal(stored().length, 0, '批量任一参考非法必须整批回滚');

  db.exec('CREATE TABLE film_request_fixture (key TEXT PRIMARY KEY, videoJobId TEXT)');
  const submitSame = () => createVideoJobsForShot({
    db, shotSetId: 'set', shotId: 'shot', items: [item({ referenceAssetIds: [] })],
    replayJobIds() {
      const id = db.prepare('SELECT videoJobId FROM film_request_fixture WHERE key=?').pluck().get('request');
      return typeof id === 'string' ? [id] : undefined;
    },
    onJobsCreated([id]) { db.prepare('INSERT INTO film_request_fixture VALUES (?,?)').run('request', id); },
  });
  const [first, replay] = await Promise.all([submitSame(), submitSame()]);
  assert.ok(first.ok && replay.ok);
  assert.deepEqual(first.videoJobIds, replay.videoJobIds);
  assert.equal(stored().length, 1);
  await assert.rejects(createVideoJobsForShot({
    db, shotSetId: 'set', shotId: 'shot', items: [item()], onJobsCreated() { throw new Error('link failed'); },
  }), /link failed/);
  assert.equal(stored().length, 1, '登记失败必须回滚同一事务中的共享队列任务');
  db.exec('DELETE FROM video_jobs');
  const implicit = await create([item({ referenceAssetIds: [] })]);
  assert.equal(implicit.ok, true, '当前分镜直接提供参考图');
  const frozen = stored()[0];
  assert.equal(frozen.sourceImageId, 'source');
  assert.deepEqual(links(frozen.id), []);
  db.prepare(`INSERT INTO image_assets (id, projectId, role, filename, path) VALUES
    ('latest', 'project', 'input', 'latest.png', ?), ('foreign-image', 'other', 'input', 'foreign.png', ?)`).run(sourcePath, sourcePath);
  db.prepare("UPDATE shots SET latestGeneratedImageId = 'latest' WHERE id = 'shot'").run();
  const latest = await create([item({ referenceAssetIds: [] })]);
  assert.equal(latest.ok, true);
  assert.equal(stored()[1].sourceImageId, 'latest');
  assert.equal(stored()[0].sourceImageId, 'source', '切换分镜图不改变旧任务来源');
  const submitFrozen = (id: string) => createVideoJobsForShot({
    db, shotSetId: 'set', shotId: 'shot', frozenSourceImageId: id, items: [item({ referenceAssetIds: [] })],
  });
  assert.equal((await submitFrozen('source')).ok, true);
  assert.equal(stored().at(-1)!.sourceImageId, 'source', '返工任务沿用原片的首帧');
  assert.equal((await submitFrozen('foreign-image')).ok, false);
  db.prepare("UPDATE shots SET latestGeneratedImageId = 'foreign-image' WHERE id = 'shot'").run();
  assert.equal((await create([item({ referenceAssetIds: [] })])).ok, false, '不能借用另一项目图片');
  db.prepare("UPDATE shots SET latestGeneratedImageId = NULL WHERE id = 'shot'").run();
  fs.renameSync(sourcePath, sourcePath + '.hidden');
  assert.equal((await create([item({ referenceAssetIds: [] })])).ok, false, '缺失原图不能创建空参考任务');
  fs.renameSync(sourcePath + '.hidden', sourcePath);
  db.exec('DELETE FROM video_jobs');
  assert.equal((await create([item({ referenceAssetIds: [] }), item({ referenceAssetIds: [] })], true)).ok, true);
  assert.equal(stored().length, 2);
  db.exec('DELETE FROM video_jobs');

  db.prepare('UPDATE image_assets SET originalWidth = NULL, originalHeight = NULL WHERE id = ?').run('source');
  const probed = await create();
  assert.equal(probed.ok, true, '缺数据库尺寸时应安全 probing 原图');
  if (probed.ok) {
    assert.equal(stored()[0].aspectRatio, '16:9', '1600x900 来源图应吸附到 16:9');
  }
  db.exec('DELETE FROM video_jobs');
  db.prepare('UPDATE image_assets SET path = ?, originalPath = NULL, processedPath = NULL WHERE id = ?').run(path.join(root, 'missing.png'), 'source');
  const missingDimensions = await create();
  assert.equal(missingDimensions.ok, true, '尺寸读取失败不得阻断参考任务创建');
  if (missingDimensions.ok) {
    assert.equal(stored()[0].aspectRatio, '16:9', '尺寸读取失败按 16:9 兜底');
    assert.equal(stored()[0].resolution, '1080p', '未指定清晰度时使用模型默认值');
  }
  db.exec('DELETE FROM video_jobs');
  db.prepare('UPDATE image_assets SET path = ?, originalWidth = 1600, originalHeight = 900 WHERE id = ?').run(sourcePath, 'source');

  const explicit = await create([item({ aspectRatio: '9:16', resolution: '720p' })]);
  assert.equal(explicit.ok, true, explicit.ok ? '' : explicit.error);
  assert.equal(stored()[0].aspectRatio, '9:16', '显式比例必须原样持久化');
  assert.equal(stored()[0].resolution, '720p', '显式清晰度必须原样持久化');
  db.exec('DELETE FROM video_jobs');
  const unsupportedRatio = await create([item({ aspectRatio: '2:1' })]);
  assert.equal(unsupportedRatio.ok, false);
  if (!unsupportedRatio.ok) assert.match(unsupportedRatio.error, /输出比例 .* 不受支持/);
  const unsupportedResolution = await create([item({ resolution: '8k' })]);
  assert.equal(unsupportedResolution.ok, false);
  if (!unsupportedResolution.ok) assert.match(unsupportedResolution.error, /输出清晰度 .* 不受支持/);
  assert.equal(stored().length, 0, '非法比例或清晰度不得落任务');

  db.prepare('UPDATE image_assets SET originalWidth = 900, originalHeight = 1600 WHERE id = ?').run('source');
  const portrait = await create([item()]);
  assert.equal(portrait.ok, true, portrait.ok ? '' : portrait.error);
  assert.equal(stored()[0].aspectRatio, '9:16', '竖版来源图应吸附到 9:16');
  db.exec('DELETE FROM video_jobs');
  const wanUnsupported = await create([item({ providerId: 'wan', aspectRatio: '21:9', referenceAssetIds: ['image'] })]);
  assert.equal(wanUnsupported.ok, false, 'Wan 只有五种比例');
  if (!wanUnsupported.ok) assert.match(wanUnsupported.error, /输出比例 21:9 不受支持/);
  db.prepare('UPDATE image_assets SET originalWidth = 1600, originalHeight = 900 WHERE id = ?').run('source');

  const historical = await create([item({ generationMode: 'image-to-video', referenceAssetIds: [], durationSec: 5 })]);
  assert.equal(historical.ok, true, historical.ok ? '' : historical.error);
  const oldRow = stored()[0];
  assert.equal(oldRow.generationMode, 'image-to-video');
  assert.equal(oldRow.aspectRatio, null);
  assert.equal(oldRow.resolution, null);
  assert.deepEqual(links(oldRow.id), []);

  const klingFirstFrame = { providerId: 'kling4', generationMode: 'image-to-video', durationSec: 5, referenceAssetIds: [] };
  db.prepare(`INSERT INTO image_assets (id, projectId, role, usage, filename, path, mimeType)
    VALUES ('tail-kling4', 'project', 'input', 'video_tail_frame', 'tail.png', ?, 'image/png')`).run(sourcePath);
  const firstFrame = await create([item(klingFirstFrame)]);
  const firstAndLast = await create([item({ ...klingFirstFrame, tailImageId: 'tail-kling4', resolution: '1080p' })], true);
  assert.ok(firstFrame.ok && firstAndLast.ok);
  assert.equal(stored().find(row => row.id === firstFrame.videoJobIds[0])?.resolution, '1080p');
  assert.equal(stored().find(row => row.id === firstAndLast.videoJobIds[0])?.resolution, '1080p');
  assert.equal(db.prepare('SELECT tailImageId FROM video_jobs WHERE id = ?').pluck().get(firstAndLast.videoJobIds[0]), 'tail-kling4');
  const oversizedSource = path.join(root, 'large-source.png');
  await sharp({ create: { width: 1600, height: 2400, channels: 3, background: '#2468ac' } })
    .png({ compressionLevel: 0 }).toFile(oversizedSource);
  assert.ok(fs.statSync(oversizedSource).size > 10 * 1024 * 1024);
  db.prepare("UPDATE image_assets SET originalPath = ?, originalWidth = 1600, originalHeight = 2400 WHERE id = 'source'").run(oversizedSource);
  const autoReference = { ...klingFirstFrame, generationMode: 'reference-to-video' };
  const sourceReference = await create([item(autoReference), item({ ...autoReference, providerId: 'wan' })], true);
  assert.ok(sourceReference.ok, sourceReference.ok ? '' : sourceReference.error);
  const klingReference = stored().find(row => row.id === sourceReference.videoJobIds[0])!;
  assert.equal(klingReference.resolution, '1080p');
  assert.equal(klingReference.aspectRatio, '9:16');
  assert.deepEqual(links(klingReference.id), [], '当前分镜图由 sourceImageId 冻结');
  const invalidDrafts = [
    { ...klingFirstFrame, generationMode: 'frames-to-video', referenceAssetIds: ['image'] },
    { ...autoReference, tailImageId: 'tail-kling4' },
  ];
  for (const invalidDraft of invalidDrafts) {
    const invalid = item(invalidDraft);
    for (const result of [await create([invalid]), await create([item(klingFirstFrame), invalid], true)]) {
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.error, /不支持多关键帧|不能携带尾帧图/);
    }
  }
  for (const resolution of ['720p', '4K']) {
    const result = await create([item({ ...klingFirstFrame, resolution })]);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /固定使用 1080p/);
  }
  assert.equal(stored().length, 5, '非法批次不得写入部分任务');

  console.log('video reference job creation tests passed');
} finally {
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
}
