import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

const MIB = 1024 * 1024;
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

  // ══ 规格 §7：11 MiB 以上真实图片必须在创建阶段通过，且最终交付合规副本 ══
  // 真实 sharp 编码的大图（3200x3000 模糊噪声 PNG ≈ 13 MiB），不是短字符串冒充。
  async function writeLargePng(filePath: string): Promise<number> {
    const width = 3200;
    const height = 3000;
    await sharp(crypto.randomBytes(width * height * 3), { raw: { width, height, channels: 3 } })
      .blur(5)
      .png({ compressionLevel: 6 })
      .toFile(filePath);
    return fs.statSync(filePath).size;
  }
  function sha256File(filePath: string): string {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  }

  // H3 单图参考（无显式参考列表，走冻结的 sourceImageId）
  const largeSourcePath = path.join(root, 'large-source.png');
  const largeSourceBytes = await writeLargePng(largeSourcePath);
  assert.ok(largeSourceBytes > 11 * MIB, `创建阶段测试素材必须 >11 MiB，实得 ${largeSourceBytes}`);
  const largeSourceHash = sha256File(largeSourcePath);
  db.prepare(`INSERT INTO image_assets (id, projectId, role, filename, path, originalWidth, originalHeight, mimeType)
    VALUES ('large', 'project', 'input', 'large.png', ?, 3200, 3000, 'image/png')`).run(largeSourcePath);
  db.exec('DELETE FROM video_jobs');
  db.prepare("UPDATE shots SET latestGeneratedImageId = 'large' WHERE id = 'shot'").run();
  for (const [providerId, model] of [['h3', 'minimax-h3'], ['wan', 'wan-3.0']] as const) {
    if (!db.prepare('SELECT 1 FROM video_providers WHERE id = ?').get(providerId)) {
      db.prepare(`INSERT INTO video_providers
        (id, name, type, defaultModel, baseUrlEnv, apiKeyEnv, modelEnv, baseUrl, apiKey, enabled)
        VALUES (?, ?, 'openai-video', ?, '', '', '', 'http://127.0.0.1:4000', 'key', 1)`).run(providerId, providerId, model);
    }
    // H3 与 Wan 各一张 11 MiB+ 原图都必须能创建任务；Wan 需要显式比例。
    const created = await create([item({ providerId, referenceAssetIds: [], durationSec: 5, ...(model === 'wan-3.0' ? { aspectRatio: '4:3' } : {}) })]);
    assert.equal(created.ok, true, `${model} 11 MiB 以上原图必须能创建任务：${created.ok ? '' : created.error}`);
    assert.equal(stored().at(-1)!.sourceImageId, 'large', '来源图身份必须保持');
    db.exec('DELETE FROM video_jobs');
  }
  // 原图字节与身份不变
  assert.equal(sha256File(largeSourcePath), largeSourceHash, '创建阶段不得修改原图字节');
  assert.equal(fs.statSync(largeSourcePath).size, largeSourceBytes, '创建阶段不得重写原图');
  // byteSize 不得伪造：数据库里的来源图记录不能出现被改小的值。
  assert.deepEqual(
    db.prepare("SELECT originalSizeBytes FROM image_assets WHERE id = 'large'").get(),
    { originalSizeBytes: null },
    '不得为绕过检查篡改来源图字节记录',
  );

  // 首尾帧：两张都超上游预算时分别处理；角色与顺序正确，原图哈希不变。
  const largeTailPath = path.join(root, 'large-tail.png');
  const largeTailBytes = await writeLargePng(largeTailPath);
  assert.ok(largeTailBytes > 11 * MIB);
  const largeTailHash = sha256File(largeTailPath);
  db.prepare(`INSERT INTO image_assets (id, projectId, role, filename, path, usage, mimeType)
    VALUES ('large-tail', 'project', 'input', 'large-tail.png', ?, 'video_tail_frame', 'image/png')`).run(largeTailPath);
  db.exec('DELETE FROM video_jobs');
  for (const [providerId, model, extra] of [
    ['h3', 'minimax-h3', {}],
    ['wan', 'wan-3.0', { aspectRatio: '4:3' }],
  ] as const) {
    const created = await create([item({
      providerId, generationMode: 'image-to-video', referenceAssetIds: [], tailImageId: 'large-tail',
      durationSec: 4, ...extra,
    })]);
    assert.equal(created.ok, true, `${model} 首尾帧两张超预算图必须能创建任务：${created.ok ? '' : created.error}`);
    const row = db.prepare('SELECT sourceImageId, tailImageId FROM video_jobs WHERE id = ?')
      .get(stored()[0].id) as { sourceImageId: string; tailImageId: string };
    assert.equal(row.sourceImageId, 'large', '首帧角色必须保持来源图');
    assert.equal(row.tailImageId, 'large-tail', '尾帧角色必须保持尾帧图');
    db.exec('DELETE FROM video_jobs');
  }
  assert.equal(sha256File(largeTailPath), largeTailHash, '尾帧原图字节不得被修改');
  assert.equal(fs.statSync(largeTailPath).size, largeTailBytes, '尾帧原图不得被重写');

  // 无法压到预算 / 超出本机保护：创建阶段必须拒绝，且不落任务。
  db.exec('DELETE FROM video_jobs');
  db.prepare("UPDATE shots SET latestGeneratedImageId = 'large' WHERE id = 'shot'").run();
  process.env.CREATIVE_STUDIO_VIDEO_SOURCE_MAX_BYTES = '1024';
  try {
    const rejected = await create([item({ providerId: 'h3', referenceAssetIds: [], durationSec: 5 })]);
    assert.equal(rejected.ok, false, '超出本机保护上限的源图必须拒绝创建');
    if (!rejected.ok) {
      assert.equal(rejected.status, 400);
      assert.match(rejected.error, /本机可安全处理上限/);
    }
    assert.equal(stored().length, 0, '预处理失败不得落任务');
  } finally {
    delete process.env.CREATIVE_STUDIO_VIDEO_SOURCE_MAX_BYTES;
  }
  db.prepare("UPDATE shots SET latestGeneratedImageId = NULL WHERE id = 'shot'").run();
  db.exec('DELETE FROM video_jobs');

  console.log('video reference job creation tests passed');
} finally {
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
}
