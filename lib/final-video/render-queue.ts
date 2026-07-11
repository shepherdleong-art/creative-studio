// lib/final-video/render-queue.ts
/**
 * 成片渲染队列：v2 job 只能消费写入 final_video_jobs 的不可变快照。
 * 队列恢复时只复用 job work 目录中的本地音轨，绝不重新调用 TTS、视觉或 LLM。
 */
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../db.ts';
import { dataRoot } from '../data-root.ts';
import { writeLog } from '../logger.ts';
import { runFfmpeg, probeDurationSec, supportsFilter } from '../ffmpeg.ts';
import { solveTimeline } from './solve-timeline.ts';
import { buildNarrationAss, resolveFontFile } from './subtitles.ts';
import { buildSolvedRenderArgs } from './ffmpeg-graph.ts';
import { buildCoverArgs } from './cover.ts';
import { buildNarrationTrack } from './tts.ts';
import {
  parseFinalVideoJobSnapshotJson,
  type FinalVideoJobRow,
  type FinalVideoJobSnapshot,
  type PackageConfig,
} from './types.ts';

const RENDER_TIMEOUT_MS = 20 * 60 * 1000;

let running = false;

export function getFinalVideoQueueStatus(): 'idle' | 'running' {
  return running ? 'running' : 'idle';
}

export function startFinalVideoQueue(): void {
  if (running) return;
  running = true;
  void (async () => {
    const db = getDb();
    try {
      db.prepare(
        `UPDATE final_video_jobs SET status = 'pending', errorMessage = 'Recovered from interrupted run'
         WHERE status = 'running' AND solverVersion = 2`
      ).run();
      for (;;) {
        const job = db
          .prepare(`SELECT * FROM final_video_jobs WHERE status = 'pending' AND solverVersion = 2 ORDER BY createdAt LIMIT 1`)
          .get() as FinalVideoJobRow | undefined;
        if (!job) break;
        db.prepare(
          `UPDATE final_video_jobs SET status = 'running', startedAt = datetime('now'), errorMessage = NULL WHERE id = ?`
        ).run(job.id);
        try {
          await runFinalVideoJob(job);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          writeLog({ jobId: job.id, projectId: job.projectId, level: 'error', message: `Final video job failed: ${msg}` });
          db.prepare(
            `UPDATE final_video_jobs SET status = 'failed', errorMessage = ?, finishedAt = datetime('now')
             WHERE id = ? AND status = 'running'`
          ).run(msg.slice(0, 2000), job.id);
        }
      }
    } finally {
      running = false;
    }
  })();
}

function setStep(jobId: string, step: string, progress: number) {
  getDb()
    .prepare(`UPDATE final_video_jobs SET currentStep = ?, progress = ? WHERE id = ? AND status = 'running'`)
    .run(step, progress, jobId);
}

function jobStillRunning(jobId: string): boolean {
  const row = getDb().prepare(`SELECT status FROM final_video_jobs WHERE id = ?`).get(jobId) as
    | { status: string }
    | undefined;
  return row?.status === 'running';
}

/** Runtime parser for the fields persisted by the submission route. */
function parseSnapshot(job: FinalVideoJobRow): FinalVideoJobSnapshot {
  return parseFinalVideoJobSnapshotJson(JSON.stringify({
    kind: job.kind,
    draftId: job.draftId,
    draftRevision: job.draftRevision,
    packageConfig: JSON.parse(job.packageJson),
    narrationBeats: JSON.parse(job.narrationBeatsJson),
    clipPool: JSON.parse(job.clipPoolJson),
    arrangement: JSON.parse(job.arrangementJson),
    issues: JSON.parse(job.issuesJson),
    solverVersion: job.solverVersion,
  }));
}

function previewDimensions(pkg: PackageConfig): { width: number; height: number } {
  if (pkg.width <= 540) return { width: pkg.width, height: pkg.height };
  const height = Math.max(2, Math.round((pkg.height * 540) / pkg.width / 2) * 2);
  return { width: 540, height };
}

function applyRenderProfile(args: string[], kind: FinalVideoJobSnapshot['kind']): string[] {
  if (kind !== 'preview') return args;
  const profile = [...args];
  const preset = profile.indexOf('-preset');
  const crf = profile.indexOf('-crf');
  if (preset < 0 || crf < 0) throw new Error('渲染参数缺少编码 profile');
  profile[preset + 1] = 'ultrafast';
  profile[crf + 1] = '28';
  return profile;
}

async function runFinalVideoJob(job: FinalVideoJobRow): Promise<void> {
  const db = getDb();
  const snapshot = parseSnapshot(job);
  const pkg = snapshot.packageConfig;
  const dimensions = snapshot.kind === 'preview' ? previewDimensions(pkg) : { width: pkg.width, height: pkg.height };
  const logInfo = (message: string) =>
    writeLog({ jobId: job.id, projectId: job.projectId, level: 'info', message });

  setStep(job.id, 'preparing', 5);
  const introDurationSec = pkg.cover.introDurationSec > 0 ? pkg.cover.introDurationSec : 0;
  const timeline = solveTimeline({
    plan: snapshot.arrangement,
    beats: snapshot.narrationBeats,
    clips: snapshot.clipPool,
    introDurationSec,
    targetDurationSec: pkg.targetDurationSec,
    durationTolerancePct: pkg.durationTolerancePct,
    maxClipSeconds: pkg.maxClipSeconds,
    fps: pkg.fps,
  });
  if (timeline.segments.length === 0) throw new Error('不可变草稿快照没有可渲染的画面');
  db.prepare(`UPDATE final_video_jobs SET timelineJson = ? WHERE id = ?`).run(JSON.stringify(timeline.segments), job.id);
  for (const issue of [...snapshot.issues, ...timeline.issues]) {
    writeLog({ jobId: job.id, projectId: job.projectId, level: 'warn', message: issue.message });
  }
  logInfo(`Solved ${timeline.segments.length} snapshot segments for ${snapshot.narrationBeats.length} beats`);

  const jobDir = path.join(dataRoot(), 'storage', 'final-videos', job.id);
  const workDir = path.join(jobDir, 'work');
  fs.mkdirSync(workDir, { recursive: true });

  let narrationTrackPath: string | null = null;
  if (snapshot.narrationBeats.length > 0) {
    setStep(job.id, 'narration', 20);
    const cachedTrack = path.join(workDir, 'narration.m4a');
    narrationTrackPath = fs.existsSync(cachedTrack)
      ? cachedTrack
      : await buildNarrationTrack({ beats: snapshot.narrationBeats, introDurationSec, workDir });
  }

  setStep(job.id, 'cover', 28);
  const fontFile = resolveFontFile();
  const coverPath = path.join(jobDir, 'cover.jpg');
  await runFfmpeg(
    buildCoverArgs({
      sourceVideoPath: timeline.segments[0].clipPath,
      titleText: pkg.cover.titleText,
      titleSize: pkg.cover.titleSize,
      titleColor: pkg.cover.titleColor,
      width: dimensions.width,
      height: dimensions.height,
      fontFile,
      outJpgPath: coverPath,
      templateId: pkg.cover.templateId,
      sellingPoints: pkg.cover.sellingPoints,
    }),
    { timeoutMs: 60_000 }
  );

  setStep(job.id, 'subtitles', 30);
  let assPath: string | null = null;
  if (pkg.subtitle.enabled && snapshot.narrationBeats.some((beat) => beat.text.trim())) {
    assPath = path.join(workDir, 'subs.ass');
    fs.writeFileSync(
      assPath,
      buildNarrationAss(snapshot.narrationBeats, introDurationSec, pkg.subtitle, dimensions.width, dimensions.height),
      'utf-8'
    );
  }

  setStep(job.id, 'render', 32);
  const duckingSupported = await supportsFilter('sidechaincompress');
  const safeName = (pkg.outputName || `final-${Date.now()}`).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
  const outputPath = path.join(jobDir, `${safeName}.mp4`);
  let lastProgressWrite = 0;
  const renderArgs = applyRenderProfile(buildSolvedRenderArgs({
    segments: timeline.segments,
    width: dimensions.width,
    height: dimensions.height,
    fps: pkg.fps,
    totalDurationSec: timeline.totalDurationSec,
    introDurationSec,
    coverJpgPath: introDurationSec > 0 ? coverPath : null,
    narrationTrackPath,
    bgm: pkg.bgm && fs.existsSync(pkg.bgm.path) ? pkg.bgm : null,
    duckingSupported,
    assPath,
    fontsDir: fontFile ? path.dirname(fontFile) : '',
    outputPath,
  }), snapshot.kind);
  await runFfmpeg(renderArgs, {
    timeoutMs: RENDER_TIMEOUT_MS,
    onProgressSec: (sec) => {
      const now = Date.now();
      if (now - lastProgressWrite < 1000) return;
      lastProgressWrite = now;
      if (!jobStillRunning(job.id)) return;
      const pct = 32 + Math.min(63, (sec / Math.max(0.1, timeline.totalDurationSec)) * 63);
      setStep(job.id, 'render', Math.round(pct));
    },
  });

  setStep(job.id, 'finalize', 98);
  const actualDuration = await probeDurationSec(outputPath);
  const manifestPath = path.join(jobDir, 'manifest.json');
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      schemaVersion: 2,
      jobId: job.id,
      projectId: job.projectId,
      shotSetId: job.shotSetId,
      draftId: snapshot.draftId,
      draftRevision: snapshot.draftRevision,
      createdAt: new Date().toISOString(),
      package: pkg,
      beats: snapshot.narrationBeats,
      arrangement: snapshot.arrangement,
      issues: snapshot.issues,
      solverVersion: snapshot.solverVersion,
      timeline: timeline.segments,
      output: { video: outputPath, cover: coverPath, durationSec: actualDuration, ...dimensions },
    }, null, 2),
    'utf-8'
  );
  fs.rmSync(workDir, { recursive: true, force: true });

  db.prepare(
    `UPDATE final_video_jobs SET
       status = 'succeeded', currentStep = 'done', progress = 100,
       outputPath = ?, coverPath = ?, manifestPath = ?, durationSec = ?,
       finishedAt = datetime('now')
     WHERE id = ? AND status = 'running'`
  ).run(outputPath, coverPath, manifestPath, actualDuration, job.id);
  logInfo(`Final video rendered: ${outputPath} (${actualDuration.toFixed(1)}s)`);
}
