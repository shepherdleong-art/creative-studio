import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';

import { ensureBatchSchemaReady } from '../lib/batch-production/schema.ts';
import { computeFingerprintFromFile } from '../lib/batch-production/fingerprint.ts';
import { resolveFfmpegPath, probeVideoMedia, runFfmpeg } from '../lib/ffmpeg.ts';
import { FINAL_EDIT_INTRO_DURATION_US } from '../lib/final-edit/types.ts';
import {
  regenerateBatchOutputCover,
  renderBatchOutputVersion,
} from '../lib/batch-production/batch-renderer.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-batch-renderer-'));
const dataRoot = path.join(root, 'data-root');
const storageRoot = path.join(dataRoot, 'storage');
fs.mkdirSync(storageRoot, { recursive: true });

function insertProject(db: Database.Database): void {
  db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, productCode TEXT DEFAULT '');
    INSERT INTO projects (id, name, productCode) VALUES ('project-1', '渲染测试项目', 'PROD-01');
  `);
}

async function makeVideo(filePath: string, durationSec = 1.2): Promise<void> {
  await runFfmpeg([
    '-f', 'lavfi', '-i', `testsrc2=duration=${durationSec}:size=320x240:rate=24`,
    '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', filePath,
  ], { signal: new AbortController().signal });
}

async function makeNarration(filePath: string, durationSec = 1.2): Promise<void> {
  await runFfmpeg([
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${durationSec}`,
    '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '1', '-y', filePath,
  ], { signal: new AbortController().signal });
}

async function setupDatabase(videoPath: string, arrangement: unknown): Promise<{ db: Database.Database; ids: Record<string, string> }> {
  const db = new Database(path.join(root, `render-${randomUUID()}.db`));
  db.pragma('foreign_keys = ON');
  insertProject(db);
  await ensureBatchSchemaReady({
    db,
    backupRoot: path.join(root, 'backups'),
    now: () => new Date('2026-08-03T00:00:00.000Z'),
  });
  const batchId = 'batch-1';
  const batchVersionId = 'batch-version-1';
  const planId = 'plan-1';
  const outputVersionId = 'output-version-1';
  const assetId = 'asset-1';
  const scriptId = 'script-1';
  const snapshotId = 'snapshot-1';
  db.prepare(`INSERT INTO batch_productions (id, projectId, name, status, currentVersionId, progressJson, createdAt, updatedAt, deletedAt) VALUES (?, ?, ?, 'running', ?, '{}', ?, ?, NULL)`).run(batchId, 'project-1', '渲染批次', batchVersionId, new Date().toISOString(), new Date().toISOString());
  db.prepare(`INSERT INTO batch_production_versions (id, batchId, versionNumber, copyCount, defaultsJson, inputState, frozenAt, createdAt) VALUES (?, ?, 1, 1, '{}', 'frozen', ?, ?)`).run(batchVersionId, batchId, new Date().toISOString(), new Date().toISOString());
  db.prepare(`INSERT INTO batch_scripts (id, projectId, sourceKind, sourceId, title, bodyText, sourceVersion, createdAt, updatedAt) VALUES (?, ?, 'external', 'source-1', '脚本', '正文', 'v1', ?, ?)`).run(scriptId, 'project-1', new Date().toISOString(), new Date().toISOString());
  db.prepare(`INSERT INTO batch_script_snapshots (id, batchVersionId, sourceScriptId, title, bodyText, sourceVersion, copyCount, createdAt) VALUES (?, ?, ?, '脚本', '正文', 'v1', 1, ?)`).run(snapshotId, batchVersionId, scriptId, new Date().toISOString());
  db.prepare(`INSERT INTO batch_output_plans (id, batchVersionId, scriptSnapshotId, seq, planJson, currentVersionId, createdAt) VALUES (?, ?, ?, 1, '{}', ?, ?)`).run(planId, batchVersionId, snapshotId, outputVersionId, new Date().toISOString());
  db.prepare(`INSERT INTO batch_output_versions (id, planId, versionNumber, arrangementJson, createdAt) VALUES (?, ?, 1, ?, ?)`).run(outputVersionId, planId, JSON.stringify(arrangement), new Date().toISOString());
  return { db, ids: { batchId, batchVersionId, planId, outputVersionId, assetId, videoPath } };
}

async function run(): Promise<void> {
  assert.ok(resolveFfmpegPath(), 'ffmpeg must be available for this behavior test');
  const videoPath = path.join(root, 'source.mp4');
  await makeVideo(videoPath);
  const fingerprint = await computeFingerprintFromFile(videoPath);
  const arrangement = {
    preset: '3:4',
    fps: 24,
    clips: [{
      clipId: 'clip-1',
      segmentId: 'segment-1',
      assetId: 'asset-1',
      sourceStartUs: 0,
      sourceEndUs: 500_000,
      timeline: { startUs: 0, endUs: 500_000 },
      preset: '3:4',
      fps: 24,
      contentFingerprint: fingerprint,
    }, {
      clipId: 'clip-2',
      segmentId: 'segment-2',
      assetId: 'asset-1',
      sourceStartUs: 500_000,
      sourceEndUs: 1_000_000,
      timeline: { startUs: 500_000, endUs: 1_000_000 },
      preset: '3:4',
      fps: 24,
      contentFingerprint: fingerprint,
    }],
    cover: { assetId: 'asset-1', timeUs: 1_100_000 },
    subtitle: {
      ready: true,
      productionReady: false,
      status: 'estimated',
      cues: [{
        id: 'estimated-1',
        sourceSegmentId: 'segment-1',
        text: '预计字幕',
        startUs: 0,
        endUs: 500_000,
        timingSource: 'estimated',
      }],
    },
  };
  const { db, ids } = await setupDatabase(videoPath, arrangement);
  db.prepare(`INSERT INTO batch_assets (id, projectId, sourceKind, locationJson, contentFingerprint, mediaKind, mediaJson, status, currentAnalysisId, createdAt, updatedAt) VALUES (?, 'project-1', 'linked', ?, ?, 'video', '{}', 'online', NULL, ?, ?)`).run(ids.assetId, JSON.stringify({ kind: 'linked', absolutePath: videoPath }), fingerprint, new Date().toISOString(), new Date().toISOString());
  db.prepare(`INSERT INTO batch_asset_sources (id, assetId, sourceKind, locationJson, health, createdAt) VALUES (?, ?, 'linked', ?, 'healthy', ?)`).run('source-row-1', ids.assetId, JSON.stringify({ kind: 'linked', absolutePath: videoPath }), new Date().toISOString());
  db.prepare(`INSERT INTO batch_asset_analysis (id, assetId, analyzerVersion, providerId, model, analysisJson, status, analyzedAt, createdAt) VALUES ('analysis-1', ?, 'test', 'test', 'test', '{}', 'ready', ?, ?)`).run(ids.assetId, new Date().toISOString(), new Date().toISOString());
  db.prepare(`INSERT INTO batch_asset_pool_items (id, batchVersionId, assetId, analysisId, selectionState, colorJson, createdAt) VALUES ('pool-1', ?, ?, 'analysis-1', 'selected', '{"lutId":null}', ?)`).run(ids.batchVersionId, ids.assetId, new Date().toISOString());

  const renderRoot = path.join(storageRoot, 'renders');
  const progress: number[] = [];
  const result = await renderBatchOutputVersion({
    db,
    projectId: 'project-1',
    batchId: ids.batchId,
    batchVersionId: ids.batchVersionId,
    planId: ids.planId,
    outputVersionId: ids.outputVersionId,
    storageRoot,
    dataRootPath: dataRoot,
    renderRoot,
    onProgress: (value) => progress.push(value.percent ?? 0),
  });
  assert.equal(result.width, 1080);
  assert.equal(result.height, 1440);
  assert.equal(result.fps, 24);
  assert.equal(result.audioMode, 'silent_placeholder');
  assert.equal(result.productionReady, false);
  assert.deepEqual(result.subtitleCues, [
    { id: 'estimated-1', sourceSegmentId: 'segment-1', text: '预计字幕', startUs: 0, endUs: 500_000 },
  ], '静音视觉候选也必须烧录并回报预计字幕，但不能因此变为 productionReady');
  assert.deepEqual(
    result.clips.map(({ clipId, sourceStartUs, sourceEndUs, timelineStartUs, timelineEndUs }) => (
      { clipId, sourceStartUs, sourceEndUs, timelineStartUs, timelineEndUs }
    )),
    [
      { clipId: 'clip-1', sourceStartUs: 0, sourceEndUs: 500_000, timelineStartUs: 0, timelineEndUs: 500_000 },
      { clipId: 'clip-2', sourceStartUs: 500_000, sourceEndUs: 1_000_000, timelineStartUs: 500_000, timelineEndUs: 1_000_000 },
    ],
    '同一素材的多个 clip 必须保留各自稳定身份与区间',
  );
  assert.ok(fs.statSync(result.videoAbsolutePath).size > 0);
  assert.ok(fs.statSync(result.coverAbsolutePath).size > 0);
  assert.ok(progress.some((value) => value > 0));
  const renderedProbe = await probeVideoMedia(result.videoAbsolutePath);
  assert.equal(renderedProbe.width, 1080);
  assert.equal(renderedProbe.height, 1440);
  assert.ok(Math.abs(renderedProbe.fps - 24) < 0.2);
  // 成片 = 20 帧片头封面 + 正文(与单条剪辑同一个契约)。脚本时长预算本来就为
  // 片头扣掉了这 20 帧,所以少了它成片会系统性短一个封面的长度。
  assert.ok(
    Math.abs(renderedProbe.durationUs / 1_000_000 - (FINAL_EDIT_INTRO_DURATION_US / 1_000_000 + 1)) < 0.1,
    `成片时长必须是片头 + 正文，实际 ${(renderedProbe.durationUs / 1_000_000).toFixed(3)}s`,
  );
  assert.equal(result.durationUs, renderedProbe.durationUs, '回报时长必须是含片头的实际成片时长');
  assert.equal(renderedProbe.hasAudio, true);
  assert.equal(renderedProbe.videoCodec, 'h264');
  assert.equal(renderedProbe.pixelFormat, 'yuv420p');
  assert.equal(renderedProbe.audioCodec, 'aac');
  assert.equal(renderedProbe.audioSampleRate, 48_000);
  assert.match(renderedProbe.format ?? '', /(?:^|,)mp4(?:,|$)/);
  assert.equal(await computeFingerprintFromFile(videoPath), fingerprint, 'formal rendering must not modify source');

  // The three production aspect-ratio contracts are exercised independently.
  for (const [suffix, preset, width, height] of [
    ['portrait', '9:16', 108, 192],
    ['landscape', '16:9', 192, 108],
  ] as const) {
    const planId = `plan-${suffix}`;
    const outputVersionId = `output-version-${suffix}`;
    const nextArrangement = {
      ...arrangement,
      preset,
      clips: [{ ...arrangement.clips[0], preset }],
      targetDurationUs: 1_000_000,
      cover: { clipId: 'clip-1', timeUs: 250_000 },
    };
    db.prepare(`INSERT INTO batch_output_plans (id, batchVersionId, scriptSnapshotId, seq, planJson, currentVersionId, createdAt) VALUES (?, ?, 'snapshot-1', ?, '{}', ?, ?)`).run(planId, ids.batchVersionId, suffix === 'portrait' ? 2 : 3, outputVersionId, new Date().toISOString());
    db.prepare(`INSERT INTO batch_output_versions (id, planId, versionNumber, arrangementJson, createdAt) VALUES (?, ?, 1, ?, ?)`).run(outputVersionId, planId, JSON.stringify(nextArrangement), new Date().toISOString());
    const ratioResult = await renderBatchOutputVersion({
      db, projectId: 'project-1', batchId: ids.batchId, batchVersionId: ids.batchVersionId,
      planId, outputVersionId, storageRoot, dataRootPath: dataRoot, renderRoot,
      outputSize: { width, height },
    });
    const ratioProbe = await probeVideoMedia(ratioResult.videoAbsolutePath);
    assert.deepEqual([ratioProbe.width, ratioProbe.height], [width, height]);
    assert.ok(Math.abs(ratioProbe.fps - 24) < 0.2);
    assert.ok(Math.abs(ratioProbe.durationUs / 1_000_000 - (FINAL_EDIT_INTRO_DURATION_US / 1_000_000 + 1)) < 0.1);
  }

  // A locally prepared narration path is accepted only with a matching full
  // fingerprint and drives the output duration/audio contract.
  const narrationPath = path.join(root, 'narration.wav');
  await makeNarration(narrationPath, 1.2);
  const narrationFingerprint = await computeFingerprintFromFile(narrationPath);
  const narrationResult = await renderBatchOutputVersion({
    db,
    projectId: 'project-1', batchId: ids.batchId, batchVersionId: ids.batchVersionId,
    planId: ids.planId, outputVersionId: ids.outputVersionId,
    storageRoot, dataRootPath: dataRoot, renderRoot,
    narration: { absolutePath: narrationPath, fingerprint: narrationFingerprint, durationUs: 1_200_000 },
  });
  assert.equal(narrationResult.audioMode, 'narration');
  assert.equal(narrationResult.productionReady, true);
  // 口播驱动的是「正文」时长；成片还要加上片头封面。
  assert.ok(Math.abs(narrationResult.durationUs / 1_000_000 - (FINAL_EDIT_INTRO_DURATION_US / 1_000_000 + 1.2)) < 0.1);

  // The persisted arrangement seam uses the project narration module's
  // storage-relative names and is accepted without any browser absolute path.
  const persistedNarration = path.join(storageRoot, 'batch-narration', 'narration.wav');
  fs.mkdirSync(path.dirname(persistedNarration), { recursive: true });
  fs.copyFileSync(narrationPath, persistedNarration);
  db.prepare(`UPDATE batch_output_versions SET arrangementJson = ? WHERE id = ?`).run(JSON.stringify({
    ...arrangement,
    narration: {
      mode: 'local_ready', productionReady: true,
      audioRelativePath: 'storage/batch-narration/narration.wav',
      audioFingerprint: narrationFingerprint,
      durationUs: 1_200_000,
      segments: [{ id: 'aligned-1', sourceSegmentId: 'source-1', text: '本地对齐字幕', startUs: 0, endUs: 1_200_000 }],
    },
  }), ids.outputVersionId);
  const persistedNarrationResult = await renderBatchOutputVersion({
    db, projectId: 'project-1', batchId: ids.batchId, batchVersionId: ids.batchVersionId,
    planId: ids.planId, outputVersionId: ids.outputVersionId,
    storageRoot, dataRootPath: dataRoot, renderRoot,
  });
  assert.equal(persistedNarrationResult.audioMode, 'narration');
  assert.deepEqual(persistedNarrationResult.subtitleCues, [
    { id: 'aligned-1:cue:1', sourceSegmentId: 'source-1', text: '本地对齐字幕', startUs: 0, endUs: 1_200_000 },
  ]);
  assert.equal(persistedNarrationResult.productionReady, true);

  // 换封面(问题 6/8):改写 arrangement.cover.timeUs 后从原片重新抽帧,
  // 同步渲染尝试的封面指纹;越界时间点必须拒绝且不产生半成品。
  {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO batch_tasks (id, projectId, batchId, workType, targetKind, targetId, status, progressJson, attemptCount, createdAt, updatedAt)
      VALUES ('render-task-cover', 'project-1', ?, 'render', 'output_version', ?, 'succeeded', '{}', 1, ?, ?)
    `).run(ids.batchId, ids.outputVersionId, now, now);
    db.prepare(`
      INSERT INTO batch_task_attempts (id, taskId, attemptNumber, status, progressJson, resultJson, startedAt, finishedAt, createdAt)
      VALUES ('attempt-cover', 'render-task-cover', 1, 'succeeded', '{}', ?, ?, ?, ?)
    `).run(JSON.stringify({
      projectId: 'project-1', batchId: ids.batchId, batchVersionId: ids.batchVersionId, planId: ids.planId,
      outputVersionId: ids.outputVersionId, planSeq: 1, outputVersionNumber: 1,
      videoRelativePath: persistedNarrationResult.videoRelativePath,
      coverRelativePath: persistedNarrationResult.coverRelativePath,
      videoChecksum: persistedNarrationResult.videoChecksum,
      coverChecksum: persistedNarrationResult.coverChecksum,
      durationUs: persistedNarrationResult.durationUs,
      audioMode: 'narration', productionReady: true,
    }), now, now, now);
    const coverBefore = await computeFingerprintFromFile(persistedNarrationResult.coverAbsolutePath);
    const regen = await regenerateBatchOutputCover({
      db, projectId: 'project-1', batchId: ids.batchId, planId: ids.planId,
      timeUs: 250_000, storageRoot, dataRootPath: dataRoot,
    });
    assert.equal(regen.coverRelativePath, persistedNarrationResult.coverRelativePath, '换封面必须原位更新候选封面产物');
    assert.equal(
      await computeFingerprintFromFile(persistedNarrationResult.coverAbsolutePath),
      regen.coverChecksum,
      '换封面后候选封面文件指纹必须与返回一致',
    );
    assert.notEqual(regen.coverChecksum, coverBefore, '换封面必须真的换成另一帧画面');
    const arrangementAfterCover = JSON.parse(
      (db.prepare(`SELECT arrangementJson FROM batch_output_versions WHERE id = ?`).get(ids.outputVersionId) as { arrangementJson: string }).arrangementJson,
    );
    assert.equal(arrangementAfterCover.cover.timeUs, 250_000, '换封面必须就地改写 cover.timeUs');
    const attemptAfterCover = JSON.parse(
      (db.prepare(`SELECT resultJson FROM batch_task_attempts WHERE id = 'attempt-cover'`).get() as { resultJson: string }).resultJson,
    );
    assert.equal(attemptAfterCover.coverChecksum, regen.coverChecksum, '渲染尝试的封面指纹必须同步,导出复核才能通过');
    await assert.rejects(
      regenerateBatchOutputCover({ db, projectId: 'project-1', batchId: ids.batchId, planId: ids.planId, timeUs: 1_500_000, storageRoot, dataRootPath: dataRoot }),
      /原片区间/,
      '越界封面时间点必须拒绝,不产生半成品',
    );
    await assert.rejects(
      regenerateBatchOutputCover({ db, projectId: 'project-1', batchId: ids.batchId, planId: ids.planId, timeUs: 250_250.5, storageRoot, dataRootPath: dataRoot }),
      /安全整数/,
      '非整数时间点必须拒绝',
    );
  }

  // A changed source is rejected against the frozen content identity.
  fs.appendFileSync(videoPath, Buffer.from('changed'));
  await assert.rejects(
    renderBatchOutputVersion({
      db, projectId: 'project-1', batchId: ids.batchId, batchVersionId: ids.batchVersionId,
      planId: ids.planId, outputVersionId: ids.outputVersionId,
      storageRoot, dataRootPath: dataRoot, renderRoot,
    }),
    /指纹|内容|原片|source/i,
  );

  // Abort must not leave a formal video or cover in the render directory.
  const abortVideo = path.join(root, 'abort-source.mp4');
  await makeVideo(abortVideo, 4);
  const abortFingerprint = await computeFingerprintFromFile(abortVideo);
  db.prepare(`UPDATE batch_assets SET contentFingerprint = ? WHERE id = ?`).run(abortFingerprint, ids.assetId);
  db.prepare(`UPDATE batch_asset_sources SET locationJson = ? WHERE assetId = ?`).run(JSON.stringify({ kind: 'linked', absolutePath: abortVideo }), ids.assetId);
  db.prepare(`UPDATE batch_output_versions SET arrangementJson = ? WHERE id = ?`).run(JSON.stringify({
    ...arrangement,
    clips: [{ ...arrangement.clips[0], sourceEndUs: 4_000_000, timeline: { startUs: 0, endUs: 4_000_000 }, contentFingerprint: abortFingerprint }],
    cover: { clipId: 'clip-1', timeUs: 250_000 },
  }), ids.outputVersionId);
  const controller = new AbortController();
  const renderJobsBeforeAbort = new Set(fs.existsSync(renderRoot) ? fs.readdirSync(renderRoot) : []);
  const aborted = renderBatchOutputVersion({
    db, projectId: 'project-1', batchId: ids.batchId, batchVersionId: ids.batchVersionId,
    planId: ids.planId, outputVersionId: ids.outputVersionId,
    storageRoot, dataRootPath: dataRoot, renderRoot, signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(aborted, /abort|中止/i);
  const leakedFormalFiles: string[] = [];
  if (fs.existsSync(renderRoot)) {
    for (const job of fs.readdirSync(renderRoot)) {
      if (renderJobsBeforeAbort.has(job)) continue;
      const jobPath = path.join(renderRoot, job);
      if (!fs.statSync(jobPath).isDirectory()) continue;
      for (const file of fs.readdirSync(jobPath)) if (file === 'video.mp4' || file === 'cover.jpg') leakedFormalFiles.push(path.join(jobPath, file));
    }
  }
  assert.deepEqual(leakedFormalFiles, [], 'abort must not leave formal render files');

  db.close();
  console.log('batch-renderer tests passed');
}

run().finally(() => fs.rmSync(root, { recursive: true, force: true }));
