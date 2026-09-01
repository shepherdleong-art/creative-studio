import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { closeDb, getDb } from '../lib/db.ts';
import { dataRoot } from '../lib/data-root.ts';
import { probeDurationSec, probeVideoMedia, runFfmpeg } from '../lib/ffmpeg.ts';
import { createFinalEditWorkspace } from '../lib/final-edit/workspace.ts';

const root = dataRoot();
assert.ok(process.env.CREATIVE_STUDIO_DATA_ROOT, 'fixture 必须在临时 CREATIVE_STUDIO_DATA_ROOT 中运行');
assert.equal(path.resolve(process.env.CREATIVE_STUDIO_DATA_ROOT), path.resolve(root));

const primaryMaterialCount = 7;
const ids = {
  projectId: 'mixcut-real-e2e-project',
  shotSetA: 'mixcut-real-shot-set-a',
  shotSetB: 'mixcut-real-shot-set-b',
  shotsA: Array.from({ length: primaryMaterialCount }, (_, index) => `mixcut-real-shot-a-${index + 1}`),
  shotB: 'mixcut-real-shot-b',
  videosA: Array.from({ length: primaryMaterialCount }, (_, index) => `mixcut-real-video-a-${index + 1}`),
  videoB: 'mixcut-real-video-b',
  scriptA: 'mixcut-real-script-a',
  scriptB: 'mixcut-real-script-b',
};

const storageRoot = path.join(root, 'storage');
const fixtureDir = path.join(storageRoot, 'fixtures', 'mixcut-real');
fs.mkdirSync(fixtureDir, { recursive: true });

const sourceImage = path.join(fixtureDir, 'source.png');
const videoAPaths = ids.videosA.map((_, index) => path.join(fixtureDir, `真实组A-素材${index + 1}.mp4`));
const videoBPath = path.join(fixtureDir, '真实组B-专属.mp4');
const narrationSource = path.join(fixtureDir, 'narration.wav');

await sharp({ create: { width: 96, height: 128, channels: 3, background: '#f4eee5' } }).png().toFile(sourceImage);
for (let index = 0; index < videoAPaths.length; index += 1) {
  await runFfmpeg([
    '-f', 'lavfi', '-i', 'testsrc2=size=360x480:rate=24:duration=5',
    '-vf', `hue=h=${index * 45}`,
    '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', videoAPaths[index],
  ], { timeoutMs: 60_000 });
}
await runFfmpeg([
  '-f', 'lavfi', '-i', 'color=c=0x8a4f43:s=360x480:r=24:d=3',
  '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', videoBPath,
], { timeoutMs: 60_000 });
await runFfmpeg([
  '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=15',
  '-ac', '1', '-c:a', 'pcm_s16le', '-y', narrationSource,
], { timeoutMs: 60_000 });

const db = getDb();
db.prepare(`INSERT INTO providers (id, name, baseUrl, apiKey, model, type, enabled) VALUES (?, ?, ?, ?, ?, ?, 1)`)
  .run('mixcut-real-image-provider', '真实 E2E 图片供应商', 'https://example.invalid', 'fixture-key', 'fixture-image', 'openai-compatible');
db.prepare(`INSERT INTO projects (id, name, providerId, model, prompt, workflowType, productName, productCode, createdAt) VALUES (?, ?, ?, ?, '', 'complex_product', ?, ?, ?)`)
  .run(ids.projectId, '真实 Mixcut E2E 项目', 'mixcut-real-image-provider', 'fixture-image', '真实测试产品', 'REAL-E2E', '2026-07-24 09:00:00');
db.prepare(`INSERT INTO image_assets (id, projectId, role, filename, path, mimeType, width, height) VALUES (?, ?, 'input', 'source.png', ?, 'image/png', 96, 128)`)
  .run('mixcut-real-source-image', ids.projectId, sourceImage);
db.prepare(`INSERT INTO shot_sets (id, projectId, name, productCode, status, createdAt) VALUES (?, ?, ?, 'REAL-E2E', 'video_ready', ?), (?, ?, ?, 'REAL-E2E', 'video_ready', ?)`)
  .run(ids.shotSetA, ids.projectId, '真实分镜组 A', '2026-07-24 09:01:00', ids.shotSetB, ids.projectId, '真实分镜组 B', '2026-07-24 09:02:00');
const insertShot = db.prepare(`INSERT INTO shots (id, shotSetId, indexNum, sourceImageId, latestGeneratedImageId, createdAt) VALUES (?, ?, ?, 'mixcut-real-source-image', 'mixcut-real-source-image', ?)`);
ids.shotsA.forEach((shotId, index) => insertShot.run(shotId, ids.shotSetA, index + 1, `2026-07-24 09:${String(index + 3).padStart(2, '0')}:00`));
insertShot.run(ids.shotB, ids.shotSetB, 1, '2026-07-24 09:11:00');
db.prepare(`INSERT OR IGNORE INTO video_providers (id, name, type, baseUrlEnv, apiKeyEnv, modelEnv, defaultModel, enabled) VALUES ('mixcut-real-video-provider', '真实 E2E 视频供应商', 'kling', '', '', '', 'fixture-video', 1)`).run();
// C5（D5）：这些 fixture 任务按「新任务」语义直接持久化 displayName（与 filename
// 同值），E2E 素材卡显示持久化名；派生路径由 video-output-filenames /
// mixcut-flow 测试覆盖。物理 filename 与 localVideoPath 保持不变。
const insertVideoJob = db.prepare(`INSERT INTO video_jobs (id, projectId, shotSetId, shotId, sourceImageId, providerId, model, prompt, durationSec, status, localVideoPath, filename, displayName, createdAt) VALUES (?, ?, ?, ?, 'mixcut-real-source-image', 'mixcut-real-video-provider', 'fixture-video', '', ?, 'succeeded', ?, ?, ?, ?)`);
ids.videosA.forEach((videoId, index) => insertVideoJob.run(videoId, ids.projectId, ids.shotSetA, ids.shotsA[index], 5, videoAPaths[index], `真实组A-素材${index + 1}.mp4`, `真实组A-素材${index + 1}.mp4`, `2026-07-24 09:${String(index + 12).padStart(2, '0')}:00`));
insertVideoJob.run(ids.videoB, ids.projectId, ids.shotSetB, ids.shotB, 3, videoBPath, '真实组B-专属.mp4', '真实组B-专属.mp4', '2026-07-24 09:19:00');

const makeScript = (shotSetId: string, shotIds: string[], title: string, narrations: string[]) => ({
  version: 2 as const,
  title,
  coverTitleParts: { primary: '真实导出', secondary: 'E2E 验收' },
  platform: '通用',
  tone: '真实测试',
  targetDurationSec: narrations.length > 1 ? 15 : 3,
  template: '真实 E2E',
  shotSetId,
  sellingPointMap: shotIds.map((shotId) => ({ shotId, sellingPoint: '真实链路' })),
  segments: narrations.map((narration, index) => ({
    shotId: shotIds[index],
    imageAssetId: 'mixcut-real-source-image',
    narration,
    subtitle: Array.from(narration).slice(0, 10).join(''),
    rationale: '验证真实端到端链路',
  })),
  droppedShots: [],
  fullScript: narrations.join(''),
});
const narrationSegments = [
  '从第一眼看到产品开始，清晰画面就把核心优势完整呈现出来。',
  '第二段继续展示真实使用细节，让材质触感和精致做工一目了然。',
  '随后切换到生活化场景，直观看见它如何融入每天的使用习惯。',
  '关键功能通过近景逐项说明，不夸大效果，也不省略重要操作步骤。',
  '不同角度的连续画面保持节奏自然，帮助快速理解设计上的巧思。',
  '实际体验中的便利与舒适都被如实记录，选购判断因此更加轻松。',
  '最后回到产品全貌，总结适用人群和价值，让这次介绍完整收束。',
];
assert.ok(Array.from(narrationSegments.join('')).length >= 150, '最终验收口播必须不少于 150 字');
const scriptA = makeScript(ids.shotSetA, ids.shotsA, '真实组 A 脚本', narrationSegments);
const scriptB = makeScript(ids.shotSetB, [ids.shotB], '真实组 B 脚本', ['另一组素材必须保持隔离。']);
db.prepare(`INSERT INTO script_drafts (id, projectId, provider, model, inputSnapshot, outputJson, createdAt) VALUES (?, ?, 'fixture', 'fixture-script', '{}', ?, ?), (?, ?, 'fixture', 'fixture-script', '{}', ?, ?)`)
  .run(ids.scriptA, ids.projectId, JSON.stringify(scriptA), '2026-07-24 09:07:00', ids.scriptB, ids.projectId, JSON.stringify(scriptB), '2026-07-24 09:08:00');
db.prepare(`UPDATE final_edit_tts_providers SET apiKey='fixture-key', enabled=1 WHERE id='vapi-qwen3-tts'`).run();
db.prepare(`INSERT INTO script_providers (id, name, type, apiStyle, baseUrl, apiKey, model, defaultBaseUrl, defaultModel, maxTokens, enabled, isBuiltin, supportsVision, visionCostPerRequest) VALUES ('mixcut-real-vision', '真实 E2E 视觉分析', 'openai-compatible', 'openai-compatible', 'https://example.invalid/v1', 'fixture-key', 'fixture-vision', 'https://example.invalid/v1', 'fixture-vision', 1024, 1, 0, 1, 0)`).run();

const narrationDurationUs = Math.round(await probeDurationSec(narrationSource) * 1_000_000);
const workspace = createFinalEditWorkspace({
  db,
  storageRoot,
  runJobsInline: true,
  probeVideo: async ({ filePath }) => {
    const media = await probeVideoMedia(filePath);
    return { durationUs: media.durationUs, width: media.width, height: media.height, fps: media.fps };
  },
  analyzeVideo: async ({ videoJobId }) => ({
    summary: `${videoJobId} 真实本地视频`,
    sellingPoints: ['真实链路'],
    semanticTags: ['产品', '真实'],
    usableRanges: [{ startUs: 0, endUs: 2_900_000, qualityScore: 1 }],
    qualityIssues: [],
    coverFrameTimesUs: [500_000],
    scenes: [{ startUs: 0, endUs: 2_900_000, description: '真实本地视频画面', labels: ['产品', '真实'], qualityScore: 1 }],
  }),
  scoreSemanticMatrix: async () => ({
    score_matrix: Array.from({ length: primaryMaterialCount }, (_, sentenceIndex) => Array.from({ length: primaryMaterialCount }, (_, sceneIndex) => sentenceIndex === sceneIndex ? 0.98 : 0.4)),
    hook_scores: Array.from({ length: primaryMaterialCount }, (_, index) => index === 0 ? 0.9 : 0.2),
  }),
  detectBeatPoints: async () => ({ pointsUs: [], fallback: true }),
  synthesize: async ({ segments, narrationHash, onSegmentComplete }) => {
    const relativePath = path.join('final-edits', 'narration', narrationHash, 'narration.wav');
    const absolutePath = path.join(storageRoot, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.copyFileSync(narrationSource, absolutePath);
    const segmentTimings = segments.map((segment, index) => ({
      segmentId: segment.segmentId,
      startUs: Math.round(index * narrationDurationUs / segments.length),
      endUs: Math.round((index + 1) * narrationDurationUs / segments.length),
    }));
    onSegmentComplete?.(segments.length, segments.length);
    return {
      relativePath,
      durationUs: narrationDurationUs,
      segmentTimings,
      wordTimings: segments.map((segment, index) => ({ text: segment.narration, startUs: segmentTimings[index].startUs, endUs: segmentTimings[index].endUs })),
    };
  },
});

const prepareJob = await workspace.start({
  projectId: ids.projectId,
  scriptDraftId: ids.scriptA,
  shotSetId: ids.shotSetA,
  selectedMaterialKeys: ids.videosA.map((videoId) => `module4:${videoId}`),
  count: 1,
  outputPreset: '3x4',
  providerId: 'vapi-qwen3-tts',
  voice: 'Cherry',
  speed: 1,
  analysisProviderId: 'mixcut-real-vision',
});
assert.equal(prepareJob.status, 'succeeded');
const preparedGroup = workspace.load(prepareJob.groupId);
workspace.apply({
  scope: 'group',
  groupId: preparedGroup.id,
  expectedRevision: preparedGroup.revision,
  type: 'set_text_style',
  preset: '3x4',
  target: 'subtitle',
  style: { ...preparedGroup.textStyles['3x4'].subtitle, fontSizePx: 32 },
});
const group = workspace.load(prepareJob.groupId);
assert.equal(group.status, 'ready');
assert.equal(group.variants.length, 1);
assert.equal(group.variants[0].issues.some((issue) => issue.severity === 'blocking'), false);
assert.equal(group.variants[0].timeline.clips.length, primaryMaterialCount);
assert.ok((group.variants[0].matchDiagnostics?.usedMaterials.length || 0) >= 5, '最终验收至少使用 5/7 个素材');
assert.ok(Math.abs(group.variants[0].timeline.bodyFrames / group.variants[0].timeline.fps - 15) <= 0.04, '时间线必须与 15 秒口播主轴一致');

closeDb();
console.log(JSON.stringify({
  ...ids,
  groupId: group.id,
  variantId: group.variants[0].id,
  narrationDurationSec: narrationDurationUs / 1_000_000,
  primaryMaterialCount,
  dataRoot: root,
  dbPath: path.join(root, 'data', 'workbench.db'),
}));
