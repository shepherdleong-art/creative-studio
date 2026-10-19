import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import { resolveFfmpegPath, runFfmpeg, probeVideoMedia } from '../lib/ffmpeg.ts';
import { ensureBatchSchemaReady } from '../lib/batch-production/schema.ts';
import { createAsset, createAnalysisVersion } from '../lib/batch-production/assets.ts';
import { computeFingerprintFromFile } from '../lib/batch-production/fingerprint.ts';
import { createBatchProduction, createBatchProductionVersion, updateBatchProductionStatus } from '../lib/batch-production/versions.ts';
import { createProjectScript, snapshotScriptIntoBatch } from '../lib/batch-production/scripts.ts';
import { createOutputPlansForSnapshot, createOutputVersion } from '../lib/batch-production/plans.ts';
import { addAssetToPool } from '../lib/batch-production/versions.ts';
import { renderBatchOutputVersion } from '../lib/batch-production/batch-renderer.ts';

/**
 * 渲染冒烟测试:不经过 API、不起 Next 服务,直接调用 batch-renderer 产出真实 mp4。
 * 用 FFmpeg 生成正弦波口播(440Hz,10s)与短 BGM(220Hz,6s,故意短于成片验证循环),
 * 断言:时长、有且仅有一条音轨、音频非静音、BGM 循环覆盖整段、同输入重跑字节一致。
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-batch-render-smoke-'));
const storageRoot = path.join(root, 'storage');
fs.mkdirSync(path.join(storageRoot, 'bgm'), { recursive: true });
fs.mkdirSync(path.join(storageRoot, 'batch-narration', 'smoke'), { recursive: true });
const previousDataRoot = process.env.CREATIVE_STUDIO_DATA_ROOT;
process.env.CREATIVE_STUDIO_DATA_ROOT = root;

const TARGET_DURATION_US = 10_000_000;
const OUTPUT_SIZE = { width: 320, height: 240 };

async function generateMedia(): Promise<{ videoPath: string; narrationPath: string; bgmPath: string }> {
  const videoPath = path.join(root, 'source.mp4');
  const narrationPath = path.join(storageRoot, 'batch-narration', 'smoke', 'narration.wav');
  const bgmPath = path.join(storageRoot, 'bgm', 'smoke-bgm.wav');
  await runFfmpeg([
    '-f', 'lavfi', '-i', 'testsrc2=duration=10:size=320x240:rate=24',
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-y', videoPath,
  ]);
  // 口播:440Hz 正弦波只响前 5s,后 5s 静音——成片目标仍为 10s,
  // 因此 5s 之后若有任何声音,只能是循环的 BGM(时间隔离,不依赖频率滤波)。
  await runFfmpeg([
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5',
    '-af', 'apad=pad_dur=5', '-t', '10',
    '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', '-y', narrationPath,
  ]);
  // BGM:220Hz 正弦波,只有 6s,短于成片 -> 必须循环才不出现后半段静音
  await runFfmpeg([
    '-f', 'lavfi', '-i', 'sine=frequency=220:duration=6',
    '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', '-y', bgmPath,
  ]);
  return { videoPath, narrationPath, bgmPath };
}

function sha256File(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

interface FfmpegLogResult {
  stdout: string;
  stderr: string;
}

function runFfmpegCapture(args: string[]): Promise<FfmpegLogResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveFfmpegPath(), args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (buf: Buffer) => { stdout += buf.toString(); });
    child.stderr.on('data', (buf: Buffer) => { stderr += buf.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-1200)}`));
    });
  });
}

/** 用 volumedetect 解析 mean_volume(dB);窗口与滤波器用于隔离 BGM 频段。 */
async function meanVolumeDb(inputPath: string, options: { startSec?: number; durationSec?: number; filter?: string } = {}): Promise<number> {
  const args: string[] = [];
  if (options.startSec != null) args.push('-ss', String(options.startSec));
  if (options.durationSec != null) args.push('-t', String(options.durationSec));
  args.push('-i', inputPath, '-af', options.filter ? `${options.filter},volumedetect` : 'volumedetect', '-f', 'null', '-');
  const { stderr } = await runFfmpegCapture(args);
  const match = stderr.match(/mean_volume:\s*(-?[\d.]+)\s*dB/);
  assert.ok(match, `volumedetect 输出缺少 mean_volume: ${stderr.slice(-600)}`);
  return Number(match[1]);
}

/** 音轨数量:用 ffmpeg 的流列表统计(与项目的 ffprobe→ffmpeg 回退策略一致)。 */
async function countAudioStreams(filePath: string): Promise<number> {
  const { stderr } = await runFfmpegCapture(['-i', filePath, '-f', 'null', '-']);
  const matches = stderr.match(/Stream #\d+:\d+(?:\([^)]*\))?:\s*Audio:/gu);
  return matches?.length ?? 0;
}

try {
  const { videoPath, narrationPath, bgmPath } = await generateMedia();

  const db = new Database(path.join(root, 'workbench.db'));
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL); INSERT INTO projects (id, name) VALUES ('project-1', '冒烟项目');`);
  const ready = await ensureBatchSchemaReady({ db, backupRoot: path.join(root, 'backups') });
  assert.notEqual(ready.state, 'compatibility_only');

  const videoFingerprint = await computeFingerprintFromFile(videoPath);
  const narrationFingerprint = await computeFingerprintFromFile(narrationPath);
  const bgmFingerprint = await computeFingerprintFromFile(bgmPath);
  const bgmRelativePath = 'bgm/smoke-bgm.wav';

  const defaultsJson = {
    outputPreset: '3:4',
    preset: '3:4',
    fps: 24,
    targetDurationSec: 15,
    batchMusicPool: [{ trackId: 'bgm-1', relativePath: bgmRelativePath, fileFingerprint: bgmFingerprint }],
    batchBgmParams: { gainDb: -18, fadeInSec: 1.0, fadeOutSec: 1.5 },
  };

  const batchId = createBatchProduction(db, 'project-1', '冒烟批次');
  const versionId = createBatchProductionVersion(db, batchId, { copyCount: 1, defaultsJson });
  const scriptId = createProjectScript(db, 'project-1', {
    sourceKind: 'script_draft',
    sourceId: 'smoke-script-source',
    title: '冒烟脚本',
    bodyText: '第一句冒烟文案。第二句验证时长。',
    sourceVersion: 'v1',
  });
  const snapshotId = snapshotScriptIntoBatch(db, versionId, { scriptId, copyCount: 1 });
  const [planId] = createOutputPlansForSnapshot(db, versionId, snapshotId);

  const assetId = createAsset(db, {
    projectId: 'project-1',
    sourceKind: 'linked',
    locationJson: { kind: 'linked', absolutePath: videoPath },
    contentFingerprint: videoFingerprint,
    mediaKind: 'video',
  });
  db.prepare(`
    INSERT INTO batch_asset_sources (id, assetId, sourceKind, locationJson, health, createdAt)
    VALUES (?, ?, 'linked', ?, 'healthy', ?)
  `).run(randomUUID(), assetId, JSON.stringify({ kind: 'linked', absolutePath: videoPath }), new Date().toISOString());
  const analysisId = createAnalysisVersion(db, {
    assetId,
    analyzerVersion: 'smoke',
    providerId: 'ffprobe',
    model: 'ffprobe',
    analysisJson: { durationUs: TARGET_DURATION_US, usableRanges: [{ startUs: 0, endUs: TARGET_DURATION_US, qualityScore: 1 }] },
  });
  addAssetToPool(db, versionId, { assetId, analysisId });

  const arrangementJson = {
    schemaVersion: 'batch-allocation-v1',
    preset: '3:4',
    fps: 24,
    targetDurationUs: TARGET_DURATION_US,
    clips: [{
      clipId: `${planId}:clip:seg-1`,
      segmentId: 'seg-1',
      sourceSegmentId: 'seg-1',
      assetId,
      contentFingerprint: videoFingerprint,
      sourceStartUs: 0,
      sourceEndUs: TARGET_DURATION_US,
      timelineStartUs: 0,
      timelineEndUs: TARGET_DURATION_US,
    }],
    cover: { assetId, timeUs: 0 },
    music: { trackId: 'bgm-1' },
    narration: {
      schemaVersion: 'batch-narration-v1',
      mode: 'local_ready',
      productionReady: true,
      audioRelativePath: 'batch-narration/smoke/narration.wav',
      audioFingerprint: narrationFingerprint,
      durationUs: TARGET_DURATION_US,
      segments: [],
    },
    subtitle: { cues: [] },
    warnings: [],
    blockers: [],
  };
  const outputVersionId = createOutputVersion(db, planId, { arrangementJson });
  updateBatchProductionStatus(db, 'project-1', batchId, 'running');
  assert.equal(
    (db.prepare(`SELECT inputState FROM batch_production_versions WHERE id = ?`).get(versionId) as { inputState: string }).inputState,
    'frozen',
  );

  const renderInput = {
    db,
    projectId: 'project-1',
    batchId,
    batchVersionId: versionId,
    planId,
    outputVersionId,
    storageRoot,
    outputSize: OUTPUT_SIZE,
    signal: new AbortController().signal,
  };

  // ---- 第一次渲染:默认 BGM 参数 -18dB / 淡入 1.0 / 淡出 1.5 ----
  const first = await renderBatchOutputVersion(renderInput);
  assert.equal(first.audioMode, 'narration');
  assert.equal(first.productionReady, true);
  assert.ok(Math.abs(first.durationUs - TARGET_DURATION_US) < 100_000, `成片时长应接近目标 10s，实际 ${first.durationUs / 1e6}s`);
  assert.ok(fs.existsSync(first.videoAbsolutePath) && fs.existsSync(first.coverAbsolutePath));
  assert.equal(path.basename(first.videoAbsolutePath), 'video.mp4');
  assert.equal(path.basename(first.coverAbsolutePath), 'cover.jpg');

  const probe = await probeVideoMedia(first.videoAbsolutePath);
  assert.ok(!probe.errorMessage, `ffprobe 不应报错：${probe.errorMessage ?? ''}`);
  assert.equal(await countAudioStreams(first.videoAbsolutePath), 1, '输出必须有且仅有一条音轨');
  assert.equal(probe.hasAudio, true, '输出必须有音轨');
  assert.equal(probe.audioCodec, 'aac');
  assert.equal(probe.audioSampleRate, 48_000);
  assert.equal(probe.videoCodec, 'h264');
  assert.ok(Math.abs(probe.durationUs / 1e6 - 10) < 0.12, `ffprobe 时长应 ≈10s，实际 ${probe.durationUs / 1e6}s`);

  // 音频非静音:全片 mean_volume 必须远高于静音(约 -91dB)
  const fullMean = await meanVolumeDb(first.videoAbsolutePath);
  assert.ok(fullMean > -40, `成片音频不应是静音,mean_volume=${fullMean}dB`);

  // BGM 循环:口播只响前 5s,成片目标 10s;7.5–8.5s(淡出 8.5s 之前)
  // 若有声音,只能是 6s 的 BGM 循环覆盖到了后半段。
  const tailMean = await meanVolumeDb(first.videoAbsolutePath, { startSec: 7.5, durationSec: 1 });
  assert.ok(tailMean > -55, `BGM 必须循环覆盖后半段,7.5–8.5s mean_volume=${tailMean}dB`);

  // 确定性:同输入重跑,产物字节必须完全一致
  const second = await renderBatchOutputVersion(renderInput);
  assert.equal(sha256File(second.videoAbsolutePath), sha256File(first.videoAbsolutePath), '同输入重跑视频字节必须一致');
  assert.equal(sha256File(second.coverAbsolutePath), sha256File(first.coverAbsolutePath), '同输入重跑封面字节必须一致');

  // BGM 参数生效:把锁定快照的 batchBgmParams 改为 -6dB / 无淡入淡出,
  // 同一 arrangement 重渲染后 6–7s(口播已静音)音量应显著高于 -18dB 版本。
  db.prepare(`
    UPDATE batch_production_versions
    SET defaultsJson = json_set(json_set(json_set(defaultsJson,
      '$.batchBgmParams.gainDb', -6),
      '$.batchBgmParams.fadeInSec', 0),
      '$.batchBgmParams.fadeOutSec', 0)
    WHERE id = ?
  `).run(versionId);
  const louder = await renderBatchOutputVersion(renderInput);
  const louderBgmMean = await meanVolumeDb(louder.videoAbsolutePath, { startSec: 6, durationSec: 1 });
  const defaultBgmMean = await meanVolumeDb(first.videoAbsolutePath, { startSec: 6, durationSec: 1 });
  assert.ok(
    louderBgmMean > defaultBgmMean + 8,
    `BGM 增益必须从锁定快照读取:-6dB 版本(${louderBgmMean}dB)应显著高于 -18dB 版本(${defaultBgmMean}dB)`,
  );

  db.close();
  console.log('batch render smoke tests passed');
} finally {
  if (previousDataRoot === undefined) delete process.env.CREATIVE_STUDIO_DATA_ROOT;
  else process.env.CREATIVE_STUDIO_DATA_ROOT = previousDataRoot;
  fs.rmSync(root, { recursive: true, force: true });
}
