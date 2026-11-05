// 视频缩略图鉴权验收的夹具：在隔离数据根里造一个「第四步已完成视频」的项目。
//
// 为什么直接写库：server 模式下创建一个 succeeded 视频任务必须真的调付费供应商，
// 验收明确要求「真实付费调用 0」。这里只造读取侧的行与受管文件登记，等价于
// video-queue 下载完成后的落库结果（status/localVideoPath/filename/团队文件登记）。
//
// 用法（必须由 scripts/video-poster-auth.playwright.test.mjs 以相同环境变量调起）：
//   node scripts/team-server/seed-video-poster-fixture.mjs \
//     --mode server --owner-a <员工A userId> [--owner-b <员工B userId>]
//   node scripts/team-server/seed-video-poster-fixture.mjs --mode local
//
// 输出一行 `FIXTURE_RESULT <json>`，包含 projectId / shotSetId / 图片与视频地址。
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpegPath from 'ffmpeg-static';
import sharp from 'sharp';

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() : '';
}

const mode = argument('--mode') || (process.env.CREATIVE_STUDIO_DEPLOYMENT_MODE === 'server' ? 'server' : 'local');
const ownerA = argument('--owner-a');
const ownerB = argument('--owner-b');
if (!['server', 'local'].includes(mode)) throw new Error(`未知 mode: ${mode}`);
if (mode === 'server' && !ownerA) throw new Error('server 模式夹具必须提供 --owner-a');

const { dataRoot } = await import('../../lib/data-root.ts');
const root = dataRoot();
const { getDb } = await import('../../lib/db.ts');
const db = getDb();

const storageRoot = path.join(root, 'storage');
const inputsDir = path.join(storageRoot, 'inputs');
const videosDir = path.join(storageRoot, 'videos');
fs.mkdirSync(inputsDir, { recursive: true });
fs.mkdirSync(videosDir, { recursive: true });

function nowIso() {
  return new Date().toISOString();
}

async function writePosterImage() {
  const file = path.join(inputsDir, `poster-${randomUUID()}.png`);
  // 纯色 + 明确的像素尺寸：验收里断言 naturalWidth/naturalHeight 与真实文件一致，
  // 而不是只看 img 元素存在。
  await sharp({ create: { width: 640, height: 360, channels: 3, background: '#3f7fbf' } })
    .png()
    .toFile(file);
  return file;
}

function writeVideoFile() {
  if (!ffmpegPath) throw new Error('真实 FFmpeg 不可用');
  const file = path.join(videosDir, `clip-${randomUUID()}.mp4`);
  const generated = spawnSync(ffmpegPath, [
    '-f', 'lavfi', '-i', 'testsrc2=duration=3:size=480x270:rate=24',
    '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', file,
  ], { encoding: 'utf8', timeout: 120_000, windowsHide: true });
  if (generated.status !== 0) throw new Error(`生成测试视频失败：${generated.stderr?.slice(-2000)}`);
  return file;
}

const providerId = randomUUID();
const projectId = randomUUID();
const imageId = randomUUID();
const shotSetId = randomUUID();
const shotId = randomUUID();
const videoJobId = randomUUID();

const posterPath = await writePosterImage();
const videoPath = writeVideoFile();
const createdAt = nowIso();

const insertProvider = db.prepare(`
  INSERT INTO providers (id, name, baseUrl, apiKeyEnv, apiKey, model, type, enabled, defaultCostPerImage)
  VALUES (?, ?, ?, '', ?, ?, ?, 1, 0)
`);

db.transaction(() => {
  insertProvider.run(providerId, '缩略图验收夹具供应商', 'http://127.0.0.1:9', 'fixture-not-a-real-key', 'gpt-image-2', 'openai-compatible');
  db.prepare(`
    INSERT INTO projects (id, name, createdAt, providerId, model, prompt, size, status, storeCode, productCode, productionType, editorName)
    VALUES (?, ?, ?, ?, 'gpt-image-2', '缩略图鉴权验收夹具：不调用任何真实供应商。', '1024x1024', 'draft', 'B店', 'POSTER-FIXTURE', 'AI种草', '缩略图验收')
  `).run(projectId, `缩略图验收-${projectId.slice(0, 8)}`, createdAt, providerId);
  db.prepare(`
    INSERT INTO image_assets (id, projectId, role, filename, path, originalPath, processedPath, mimeType, width, height, usage, createdAt)
    VALUES (?, ?, 'input', ?, ?, ?, NULL, 'image/png', 640, 360, 'shot_source', ?)
  `).run(imageId, projectId, path.basename(posterPath), posterPath, posterPath, createdAt);
  db.prepare(`
    INSERT INTO shot_sets (id, projectId, name, kind, status, createdAt)
    VALUES (?, ?, '缩略图验收分镜组', 'storyboard', 'approved', ?)
  `).run(shotSetId, projectId, createdAt);
  db.prepare(`INSERT INTO shots (id, shotSetId, indexNum, sourceImageId, createdAt) VALUES (?, ?, 1, ?, ?)`)
    .run(shotId, shotSetId, imageId, createdAt);
  // 等价于 video-queue 下载成功后的落库结果：既有成功视频，不经过重新提交或抽帧。
  db.prepare(`
    INSERT INTO video_jobs (
      id, projectId, shotSetId, shotId, sourceImageId, providerId, model, templateId, prompt,
      durationSec, generationMode, status, localVideoPath, filename, displayName, createdAt,
      startedAt, finishedAt, attempt, maxAttempts, executionRevision
    ) VALUES (?, ?, ?, ?, ?, 'kling-3', 'kling-v3', NULL, '夹具：已完成视频，不重新提交。',
      3, 'image-to-video', 'succeeded', ?, ?, ?, ?, ?, ?, 1, 2, 0)
  `).run(
    videoJobId, projectId, shotSetId, shotId, imageId,
    videoPath, path.basename(videoPath), '01-海报验收-自定义-V01.mp4', createdAt, createdAt, createdAt,
  );
}).immediate();

let teamFiles = null;
if (mode === 'server') {
  // 团队模式：实体 scope 与受管文件登记必须真实存在，否则 /api/images 与
  // /api/videos 会按「未登记」返回 404 —— 那会把夹具问题和鉴权问题混在一起。
  const { registerReadyTeamFile } = await import('../../lib/team-service/files/registry.ts');
  const scope = db.prepare(`
    INSERT INTO team_resource_scopes (
      resourceType, resourceId, ownerUserId, visibility, parentType, parentId, rootType, rootId, createdAt, updatedAt
    ) VALUES (?, ?, ?, 'private', ?, ?, 'project', ?, ?, ?)
  `);
  db.transaction(() => {
    scope.run('project', projectId, ownerA, null, null, projectId, createdAt, createdAt);
    scope.run('image', imageId, ownerA, 'project', projectId, projectId, createdAt, createdAt);
    scope.run('shot_set', shotSetId, ownerA, 'project', projectId, projectId, createdAt, createdAt);
    scope.run('shot', shotId, ownerA, 'shot_set', shotSetId, projectId, createdAt, createdAt);
    scope.run('video_job', videoJobId, ownerA, 'project', projectId, projectId, createdAt, createdAt);
  }).immediate();

  teamFiles = {
    poster: registerReadyTeamFile(db, {
      storageRoot, absolutePath: posterPath, mimeType: 'image/png', ownerUserId: ownerA,
      references: [{ resourceType: 'image', resourceId: imageId, role: 'input' }],
    }),
    video: registerReadyTeamFile(db, {
      storageRoot, absolutePath: videoPath, mimeType: 'video/mp4', ownerUserId: ownerA,
      references: [{ resourceType: 'video_job', resourceId: videoJobId, role: 'output' }],
    }),
  };
  if (ownerB) {
    // 其他员工持有自己的项目：他既不该看到 A 的项目，也不该取到 A 的图片。
    db.transaction(() => {
      scope.run('project', `bystander-${projectId}`, ownerB, null, null, `bystander-${projectId}`, createdAt, createdAt);
    }).immediate();
  }
}

db.close();

const posterRelative = path.relative(storageRoot, posterPath).split(path.sep).join('/');
const videoRelative = path.relative(storageRoot, videoPath).split(path.sep).join('/');
const payload = {
  mode,
  dataRoot: root,
  projectId,
  shotSetId,
  shotId,
  imageId,
  videoJobId,
  posterAbsolutePath: posterPath,
  videoAbsolutePath: videoPath,
  posterUrl: `/api/images/${posterRelative.split('/').map(encodeURIComponent).join('/')}`,
  videoUrl: `/api/videos/${videoRelative.split('/').map(encodeURIComponent).join('/')}`,
  posterSha256: createHash('sha256').update(fs.readFileSync(posterPath)).digest('hex'),
  videoBytes: fs.statSync(videoPath).size,
  teamFiles: teamFiles ? { posterFileId: teamFiles.poster.id, videoFileId: teamFiles.video.id } : null,
  repoRoot,
};
console.log(`FIXTURE_RESULT ${JSON.stringify(payload)}`);
