import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { probeVideoMedia, runFfmpeg } from '../lib/ffmpeg.ts';
import { ensureBatchSchemaReady } from '../lib/batch-production/schema.ts';
import { createAsset, createAnalysisVersion } from '../lib/batch-production/assets.ts';
import { computeFingerprintFromFile } from '../lib/batch-production/fingerprint.ts';
import { addAssetToPool, createBatchProduction, createBatchProductionVersion, updateBatchProductionStatus } from '../lib/batch-production/versions.ts';
import { createProjectScript, snapshotScriptIntoBatch } from '../lib/batch-production/scripts.ts';
import { createOutputPlansForSnapshot, createOutputVersion } from '../lib/batch-production/plans.ts';
import { renderBatchOutputVersion, type BatchRenderInput, type BatchRenderResult } from '../lib/batch-production/batch-renderer.ts';
import { parsePackagingConfig, type FinalEditPackagingConfig, type PackagingTemplateId } from '../lib/media-core/packaging-vars.ts';
import { planPackagingStickerAutoLayout, type PackagingStickerPlanningAsset } from '../lib/media-core/packaging-sticker-planner.ts';
import { STICKER_INTRO_FRAMES, validatePackagingStickers, type PackagingStickerInstance } from '../lib/media-core/packaging-stickers.ts';
import { resolvePackagingStickerAssets, type PackagingStickerAssetMap, type ResolvedPackagingStickerAsset } from '../lib/media-core/packaging-sticker-assets.ts';

// 运行：node scripts/batch-sticker-render.test.ts
// 真实临时 DB + FFmpeg 媒体 + HyperFrames 包装导出；不启动 Next，也不经过 API。

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-batch-sticker-render-'));
const storageRoot = path.join(root, 'storage');
const packagingDir = path.join(process.cwd(), 'packaging');
const previousDataRoot = process.env.CREATIVE_STUDIO_DATA_ROOT;
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
fs.mkdirSync(path.join(storageRoot, 'batch-narration', 'stickers'), { recursive: true });

const OUTPUT_SIZE = { width: 320, height: 240 };
const INTRO_SEC = STICKER_INTRO_FRAMES / 24;
const SOURCE_DURATION_SEC = 9;
const templates: Array<{ template: PackagingTemplateId; bodySec: 6 | 9 }> = [
  { template: 'overlay-poster', bodySec: 6 },
  { template: 'overlay-journal', bodySec: 9 },
  { template: 'overlay-minimal', bodySec: 6 },
  { template: 'overlay-variety', bodySec: 9 },
];

type Region = { left: number; top: number; width: number; height: number };
type FrameProbe = { id: string; frame: number; file: string; region: Region };
type PreparedOutput = {
  template: PackagingTemplateId;
  bodySec: number;
  planId: string;
  outputVersionId: string;
  config: FinalEditPackagingConfig;
  stickers: PackagingStickerInstance[];
  assets: PackagingStickerAssetMap;
  renderInput: BatchRenderInput;
};

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

function manualSticker(id: string, overrides: Partial<PackagingStickerInstance> = {}): PackagingStickerInstance {
  return {
    id,
    assetId: 'highlight',
    styleMode: 'follow-template',
    fixedStyle: null,
    startFrame: 24,
    endFrame: 68,
    centerXPct: 50,
    centerYPct: 78,
    visualWidthPct: 30,
    rotationDeg: 0,
    trackIndex: 0,
    animation: 'follow-template',
    ...overrides,
    origin: { kind: 'manual' },
  };
}

function stickerGeometry(sticker: PackagingStickerInstance, asset: ResolvedPackagingStickerAsset): number[] {
  const [left, top, right, bottom] = asset.alpha_gt8_bbox;
  const imageWidth = sticker.visualWidthPct / 100 * OUTPUT_SIZE.width * asset.width / (right - left);
  const imageHeight = imageWidth * asset.height / asset.width;
  const imageLeft = sticker.centerXPct / 100 * OUTPUT_SIZE.width - (left + right) / 2 / asset.width * imageWidth;
  const imageTop = sticker.centerYPct / 100 * OUTPUT_SIZE.height - (top + bottom) / 2 / asset.height * imageHeight;
  return [
    imageLeft + left / asset.width * imageWidth,
    imageTop + top / asset.height * imageHeight,
    imageLeft + right / asset.width * imageWidth,
    imageTop + bottom / asset.height * imageHeight,
  ];
}

function expectedRegion(sticker: PackagingStickerInstance, asset: ResolvedPackagingStickerAsset, padding = 8): Region {
  const bbox = stickerGeometry(sticker, asset);
  const left = Math.max(0, Math.floor(bbox[0]) - padding);
  const top = Math.max(0, Math.floor(bbox[1]) - padding);
  const right = Math.min(OUTPUT_SIZE.width, Math.ceil(bbox[2]) + padding);
  const bottom = Math.min(OUTPUT_SIZE.height, Math.ceil(bbox[3]) + padding);
  assert.ok(right > left && bottom > top, `${sticker.id} 的验收区域越界`);
  return { left, top, width: right - left, height: bottom - top };
}

async function extractFrame(videoPath: string, frame: number, output: string): Promise<void> {
  await runFfmpeg([
    '-y', '-v', 'error', '-i', videoPath,
    '-vf', `select=eq(n\\,${frame})`, '-frames:v', '1', output,
  ], { timeoutMs: 60_000 });
}

async function brightPixelCount(file: string, region: Region): Promise<number> {
  const { data, info } = await sharp(file).extract(region).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let count = 0;
  for (let index = 0; index < data.length; index += info.channels) {
    if (Math.max(data[index], data[index + 1], data[index + 2]) > 80) count += 1;
  }
  return count;
}

async function compareRegion(leftFile: string, rightFile: string, region: Region): Promise<{ mean: number; strongRatio: number }> {
  const [left, right] = await Promise.all([
    sharp(leftFile).extract(region).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(rightFile).extract(region).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);
  assert.equal(left.info.width, right.info.width);
  assert.equal(left.info.height, right.info.height);
  assert.equal(left.info.channels, right.info.channels);
  let sum = 0;
  let strong = 0;
  const pixels = left.info.width * left.info.height;
  for (let index = 0; index < left.data.length; index += left.info.channels) {
    const distance = (Math.abs(left.data[index] - right.data[index])
      + Math.abs(left.data[index + 1] - right.data[index + 1])
      + Math.abs(left.data[index + 2] - right.data[index + 2])) / 3;
    sum += distance;
    if (distance > 45) strong += 1;
  }
  return { mean: sum / pixels, strongRatio: strong / pixels };
}

async function rawPixels(file: string): Promise<Buffer> {
  return sharp(file).removeAlpha().raw().toBuffer();
}

async function generateMedia(): Promise<{ videoPath: string; narrations: Map<number, { relativePath: string; fingerprint: string }> }> {
  const videoPath = path.join(root, 'source.mp4');
  await runFfmpeg([
    '-f', 'lavfi', '-i', `color=c=0x101018:s=${OUTPUT_SIZE.width}x${OUTPUT_SIZE.height}:r=24:d=${SOURCE_DURATION_SEC}`,
    '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-y', videoPath,
  ]);
  const narrations = new Map<number, { relativePath: string; fingerprint: string }>();
  for (const durationSec of [6, 9]) {
    const relativePath = `batch-narration/stickers/narration-${durationSec}.wav`;
    const absolutePath = path.join(storageRoot, relativePath);
    await runFfmpeg([
      '-f', 'lavfi', '-i', `sine=frequency=${durationSec === 6 ? 440 : 550}:duration=${durationSec}`,
      '-t', String(durationSec), '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', '-y', absolutePath,
    ]);
    narrations.set(durationSec, { relativePath, fingerprint: await computeFingerprintFromFile(absolutePath) });
  }
  return { videoPath, narrations };
}

function savedPackaging(db: Database.Database, outputVersionId: string): FinalEditPackagingConfig {
  const row = db.prepare('SELECT arrangementJson FROM batch_output_versions WHERE id = ?').get(outputVersionId) as { arrangementJson: string };
  return parsePackagingConfig(JSON.parse(row.arrangementJson).packaging);
}

async function verifyRenderedOutput(output: PreparedOutput, result: BatchRenderResult, frameRoot: string): Promise<FrameProbe[]> {
  const expectedTotalSec = output.bodySec + INTRO_SEC;
  assert.equal(result.audioMode, 'narration');
  assert.equal(result.productionReady, true);
  assert.ok(Math.abs(result.durationUs / 1e6 - expectedTotalSec) < 0.12, `${output.template} 返回时长错误`);
  const probe = await probeVideoMedia(result.videoAbsolutePath);
  assert.ok(!probe.errorMessage, `${output.template} ffprobe 失败：${probe.errorMessage ?? ''}`);
  assert.equal(probe.width, OUTPUT_SIZE.width);
  assert.equal(probe.height, OUTPUT_SIZE.height);
  assert.equal(probe.videoCodec, 'h264');
  assert.equal(probe.pixelFormat, 'yuv420p');
  assert.ok(Math.abs(probe.fps - 24) < 0.01);
  assert.ok(Math.abs(probe.durationUs / 1e6 - expectedTotalSec) < 0.12, `${output.template} ffprobe 时长应约为 ${expectedTotalSec}s，实际 ${probe.durationUs / 1e6}s`);
  assert.ok(/(?:^|,)mp4(?:,|$)/u.test(probe.format ?? ''), `${output.template} 不是 MP4：${probe.format ?? ''}`);
  assert.equal(probe.hasAudio, true);
  assert.equal(probe.audioCodec, 'aac');
  assert.equal(probe.audioSampleRate, 48_000);
  const cover = await sharp(result.coverAbsolutePath).metadata();
  assert.equal(cover.format, 'jpeg');
  assert.equal(cover.width, OUTPUT_SIZE.width);
  assert.equal(cover.height, OUTPUT_SIZE.height);

  fs.mkdirSync(frameRoot, { recursive: true });
  const introFrame = path.join(frameRoot, 'intro-10.png');
  await extractFrame(result.videoAbsolutePath, 10, introFrame);
  const probes: FrameProbe[] = [];
  for (const sticker of output.stickers) {
    const asset = output.assets[sticker.id];
    assert.ok(asset, `${sticker.id} 缺少已解析贴纸资源`);
    const frame = Math.floor((sticker.startFrame + sticker.endFrame) / 2);
    assert.ok(frame >= STICKER_INTRO_FRAMES && frame < STICKER_INTRO_FRAMES + output.bodySec * 24);
    const region = expectedRegion(sticker, asset);
    const file = path.join(frameRoot, `${sticker.id}-${frame}.png`);
    await extractFrame(result.videoAbsolutePath, frame, file);
    const bright = await brightPixelCount(file, region);
    assert.ok(bright >= 20, `${output.template}/${sticker.id} 正文稳定帧 ${frame} 的贴纸区域只有 ${bright} 个非底色像素`);

    // cover.jpg 由同一包装层在片头第 10 帧合成；逐贴纸区域比较可检出片头多出的贴纸层，允许视频/JPEG 编码噪声。
    const introDelta = await compareRegion(introFrame, result.coverAbsolutePath, region);
    assert.ok(
      introDelta.mean <= 12 && introDelta.strongRatio <= 0.08,
      `${output.template}/${sticker.id} 片头对应安全区域出现额外像素：mean=${introDelta.mean.toFixed(2)} strong=${(introDelta.strongRatio * 100).toFixed(1)}%`,
    );
    probes.push({ id: sticker.id, frame, file, region });
  }
  return probes;
}

let db: Database.Database | undefined;
try {
  const { videoPath, narrations } = await generateMedia();
  const catalog = JSON.parse(fs.readFileSync(path.join(packagingDir, 'stickers', 'catalog.json'), 'utf8')) as { assets: PackagingStickerPlanningAsset[] };

  db = new Database(path.join(root, 'workbench.db'));
  db.pragma('foreign_keys = ON');
  db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL); INSERT INTO projects (id, name) VALUES ('project-1', '批量贴纸验收');");
  const ready = await ensureBatchSchemaReady({ db, backupRoot: path.join(root, 'backups') });
  assert.notEqual(ready.state, 'compatibility_only');

  const videoFingerprint = await computeFingerprintFromFile(videoPath);
  const assetId = createAsset(db, {
    projectId: 'project-1',
    sourceKind: 'linked',
    locationJson: { kind: 'linked', absolutePath: videoPath },
    contentFingerprint: videoFingerprint,
    mediaKind: 'video',
  });
  db.prepare(`INSERT INTO batch_asset_sources (id, assetId, sourceKind, locationJson, health, createdAt)
    VALUES (?, ?, 'linked', ?, 'healthy', ?)`).run(
    randomUUID(), assetId, JSON.stringify({ kind: 'linked', absolutePath: videoPath }), new Date().toISOString(),
  );
  const analysisId = createAnalysisVersion(db, {
    assetId,
    analyzerVersion: 'batch-sticker-test',
    providerId: 'ffprobe',
    model: 'ffprobe',
    analysisJson: {
      durationUs: SOURCE_DURATION_SEC * 1_000_000,
      usableRanges: [{ startUs: 0, endUs: SOURCE_DURATION_SEC * 1_000_000, qualityScore: 1 }],
    },
  });

  const batchId = createBatchProduction(db, 'project-1', '批量贴纸真实导出验收');
  const versionId = createBatchProductionVersion(db, batchId, {
    copyCount: 1,
    defaultsJson: { outputPreset: '3:4', preset: '3:4', fps: 24, targetDurationSec: SOURCE_DURATION_SEC },
  });
  addAssetToPool(db, versionId, { assetId, analysisId });

  const prepared: PreparedOutput[] = [];
  for (const [index, spec] of templates.entries()) {
    const scriptId = createProjectScript(db, 'project-1', {
      sourceKind: 'script_draft',
      sourceId: `batch-sticker-${spec.template}`,
      title: `贴纸验收 ${spec.template}`,
      bodyText: `${spec.bodySec} 秒口播与七类贴纸真实导出验收。`,
      sourceVersion: 'v1',
      metadata: { targetDurationSec: spec.bodySec },
    });
    const snapshotId = snapshotScriptIntoBatch(db, versionId, { scriptId, copyCount: 1 });
    const [planId] = createOutputPlansForSnapshot(db, versionId, snapshotId);
    const automatic = planPackagingStickerAutoLayout({
      bodyFrames: spec.bodySec * 24,
      template: spec.template,
      assets: catalog.assets,
      animation: 'follow-template',
      autoGroupId: `auto_group_${index}`,
      random: seededRandom(index + 1),
      createId: (slotIndex) => `auto_${index}_${slotIndex}`,
    });
    assert.ok(automatic, `${spec.template} 应生成六张自动贴纸`);
    assert.equal(automatic.length, 6);
    assert.ok(automatic.every((sticker) => sticker.origin.kind === 'auto' && !sticker.origin.autoEdited));
    const manual = manualSticker(`manual_${index}`);
    const stickers = index === 0
      ? [
          manual,
          manualSticker('manual_fixed_cross', {
            assetId: 'like',
            styleMode: 'fixed',
            fixedStyle: 'show',
            startFrame: 80,
            endFrame: 124,
            centerYPct: 45,
            visualWidthPct: 26,
            animation: 'none',
          }),
          ...automatic,
        ]
      : [manual, ...automatic];
    validatePackagingStickers(stickers, spec.bodySec * 24);
    assert.ok(stickers.every((sticker) => sticker.startFrame >= STICKER_INTRO_FRAMES && sticker.endFrame <= STICKER_INTRO_FRAMES + spec.bodySec * 24));
    const config: FinalEditPackagingConfig = {
      enabled: true,
      template: spec.template,
      varsOverrides: { title: '', subtitle: '', point1: '', point2: '', point3: '', accent1: '', accent2: '', accent3: '' },
      pointCues: [],
      pointCuesMode: 'none',
      stickers,
      stickerDefaults: { animation: 'follow-template' },
    };
    assert.deepEqual(parsePackagingConfig(config).stickers, stickers, '完整贴纸快照必须能经 parsePackagingConfig 无损保存');
    const narration = narrations.get(spec.bodySec)!;
    const targetDurationUs = spec.bodySec * 1_000_000;
    const arrangementJson = {
      schemaVersion: 'batch-allocation-v1',
      preset: '3:4',
      fps: 24,
      targetDurationUs,
      packaging: config,
      clips: [{
        clipId: `${planId}:clip:seg-1`,
        segmentId: 'seg-1',
        sourceSegmentId: 'seg-1',
        assetId,
        contentFingerprint: videoFingerprint,
        sourceStartUs: 0,
        sourceEndUs: targetDurationUs,
        timelineStartUs: 0,
        timelineEndUs: targetDurationUs,
      }],
      cover: { assetId, timeUs: 0 },
      narration: {
        schemaVersion: 'batch-narration-v1',
        mode: 'local_ready',
        productionReady: true,
        audioRelativePath: narration.relativePath,
        audioFingerprint: narration.fingerprint,
        durationUs: targetDurationUs,
        segments: [],
      },
      subtitle: { cues: [] },
      warnings: [],
      blockers: [],
    };
    const outputVersionId = createOutputVersion(db, planId, { arrangementJson });
    prepared.push({
      ...spec,
      planId,
      outputVersionId,
      config,
      stickers,
      assets: resolvePackagingStickerAssets({ packagingDir, template: spec.template, stickers }),
      renderInput: {
        db,
        projectId: 'project-1',
        batchId,
        batchVersionId: versionId,
        planId,
        outputVersionId,
        storageRoot,
        outputSize: OUTPUT_SIZE,
        signal: new AbortController().signal,
      },
    });
  }
  assert.equal(new Set(prepared.map((item) => item.bodySec)).size, 2, '必须覆盖两种正文时长');
  assert.equal(new Set(prepared.map((item) => item.template)).size, 4, '必须覆盖四套 overlay 模板');
  assert.ok(prepared[0].stickers.some((sticker) => sticker.origin.kind === 'manual' && sticker.styleMode === 'follow-template'));
  assert.ok(prepared[0].stickers.some((sticker) => sticker.origin.kind === 'manual' && sticker.styleMode === 'fixed' && sticker.fixedStyle === 'show' && prepared[0].template !== 'overlay-variety'));

  updateBatchProductionStatus(db, 'project-1', batchId, 'running');
  assert.equal((db.prepare('SELECT inputState FROM batch_production_versions WHERE id = ?').get(versionId) as { inputState: string }).inputState, 'frozen');

  const rendered: Array<{ output: PreparedOutput; result: BatchRenderResult; probes: FrameProbe[] }> = [];
  for (const output of prepared) {
    console.log(`开始真实导出：${output.template}，正文 ${output.bodySec}s，${output.stickers.length} 张贴纸`);
    const before = savedPackaging(db, output.outputVersionId).stickers;
    const result = await renderBatchOutputVersion(output.renderInput);
    assert.deepEqual(savedPackaging(db, output.outputVersionId).stickers, before, '正式导出不得改写已保存贴纸');
    const probes = await verifyRenderedOutput(output, result, path.join(root, 'frames', output.template));
    rendered.push({ output, result, probes });
    console.log(`通过：${output.template}，MP4/封面/时长格式、${probes.length} 个正文贴纸区域与片头安全区域均通过`);
  }

  const first = rendered[0];
  console.log(`开始同快照重渲染：${first.output.template}`);
  const second = await renderBatchOutputVersion(first.output.renderInput);
  assert.deepEqual(savedPackaging(db, first.output.outputVersionId).stickers, first.output.stickers, '重渲染不得重新随机或改写自动贴纸');
  let determinismMode = 'MP4 字节一致';
  if (second.videoChecksum !== first.result.videoChecksum) {
    determinismMode = '全部贴纸稳定关键帧像素一致';
    for (const probe of first.probes) {
      const rerunFrame = path.join(root, 'frames', 'rerender', `${probe.id}-${probe.frame}.png`);
      fs.mkdirSync(path.dirname(rerunFrame), { recursive: true });
      await extractFrame(second.videoAbsolutePath, probe.frame, rerunFrame);
      assert.ok((await rawPixels(rerunFrame)).equals(await rawPixels(probe.file)), `${probe.id} 重渲染关键帧像素发生变化`);
    }
  }
  assert.equal(second.coverChecksum, first.result.coverChecksum, '同贴纸快照重渲染封面必须一致');
  console.log(`批量贴纸真实导出验收通过：四模板、6s/9s 正文、手动与六张未编辑自动贴纸、正文/片头像素、${determinismMode}。`);
} finally {
  if (db?.open) db.close();
  if (previousDataRoot === undefined) delete process.env.CREATIVE_STUDIO_DATA_ROOT;
  else process.env.CREATIVE_STUDIO_DATA_ROOT = previousDataRoot;
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
