// lib/final-video/render-queue.ts
/**
 * 成片渲染队列：单并发（本地 CPU 密集），仿 video-queue 的恢复/自启惯例。
 * 步骤与进度区间见 docs/superpowers/plans/2026-07-04-final-video-packaging.md §1.5
 */
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../db.ts';
import { dataRoot } from '../data-root.ts';
import { writeLog } from '../logger.ts';
import { runFfmpeg, probeDurationSec, supportsFilter } from '../ffmpeg.ts';
import { buildTimeline } from './timeline.ts';
import type { TimelineClipInput, TimelineShotInput } from './timeline.ts';
import { buildAss, resolveFontFile } from './subtitles.ts';
import { buildRenderArgs } from './ffmpeg-graph.ts';
import { buildCoverArgs } from './cover.ts';
import type { FinalVideoJobRow, PackageConfig } from './types.ts';
import { mergePackageConfig } from './types.ts';

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
         WHERE status = 'running'`
      ).run();
      for (;;) {
        const job = db
          .prepare(`SELECT * FROM final_video_jobs WHERE status = 'pending' ORDER BY createdAt LIMIT 1`)
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

async function runFinalVideoJob(job: FinalVideoJobRow): Promise<void> {
  const db = getDb();
  const pkg: PackageConfig = mergePackageConfig(JSON.parse(job.packageJson || '{}'));
  const logInfo = (message: string) =>
    writeLog({ jobId: job.id, projectId: job.projectId, level: 'info', message });

  // ── preparing：脚本分镜 + 片段 + 实际时长 ──
  setStep(job.id, 'preparing', 5);
  const draft = db
    .prepare(`SELECT outputJson FROM script_drafts WHERE id = ?`)
    .get(job.scriptDraftId) as { outputJson: string } | undefined;
  if (!draft) throw new Error('脚本草稿不存在，无法确定分镜顺序与字幕');
  const draftOutput = JSON.parse(draft.outputJson) as {
    shots?: Array<{ shotId: string; shotIndex: number; voiceover?: string; subtitle?: string }>;
  };
  const scriptShots: TimelineShotInput[] = (draftOutput.shots ?? []).map((s) => ({
    shotId: s.shotId,
    shotIndex: s.shotIndex,
    voiceover: String(s.voiceover ?? ''),
    subtitle: String(s.subtitle ?? ''),
  }));
  if (scriptShots.length === 0) throw new Error('脚本草稿中没有分镜');

  const clipRows = db
    .prepare(
      `SELECT shotId, id as videoJobId, localVideoPath FROM video_jobs
       WHERE shotSetId = ? AND status = 'succeeded' AND localVideoPath IS NOT NULL
       ORDER BY createdAt DESC`
    )
    .all(job.shotSetId) as Array<{ shotId: string | null; videoJobId: string; localVideoPath: string }>;
  const latestByShot = new Map<string, { videoJobId: string; localVideoPath: string }>();
  for (const row of clipRows) {
    if (row.shotId && !latestByShot.has(row.shotId) && fs.existsSync(row.localVideoPath)) {
      latestByShot.set(row.shotId, row);
    }
  }
  const clips: TimelineClipInput[] = [];
  for (const [shotId, row] of latestByShot) {
    clips.push({
      shotId,
      videoJobId: row.videoJobId,
      clipPath: row.localVideoPath,
      clipDurationSec: await probeDurationSec(row.localVideoPath),
    });
  }
  logInfo(`Prepared ${clips.length} clips for ${scriptShots.length} script shots`);

  // ── 工作目录 ──
  const jobDir = path.join(dataRoot(), 'storage', 'final-videos', job.id);
  const workDir = path.join(jobDir, 'work');
  fs.mkdirSync(workDir, { recursive: true });

  // ── tts（Phase 6 交付 lib/final-video/tts.ts；在那之前 create 路由拒绝 mode='tts'）──
  let narrationDurations: Record<string, number> = {};
  let narrationFiles: Record<string, string> = {};
  if (pkg.narration.mode === 'tts') {
    setStep(job.id, 'tts', 8);
    const tts = await import('./tts.ts');
    const synth = await tts.synthesizeNarrationSegments({
      segments: scriptShots.map((s) => ({ shotId: s.shotId, text: s.voiceover })),
      voice: pkg.narration.voice,
      speed: pkg.narration.speed,
      workDir,
      onProgress: (done, total) => setStep(job.id, 'tts', 8 + Math.round((done / Math.max(1, total)) * 12)),
    });
    narrationDurations = synth.durations;
    narrationFiles = synth.files;
  }

  // ── 时间线 ──
  const intro = pkg.cover.introDurationSec > 0 ? pkg.cover.introDurationSec : 0;
  const timeline = buildTimeline({ scriptShots, clips, narrationDurations, introDurationSec: intro });
  if (timeline.segments.length === 0) {
    throw new Error(`没有可用片段：${timeline.issues.map((i) => `分镜${i.shotIndex}${i.reason}`).join('；')}`);
  }
  db.prepare(`UPDATE final_video_jobs SET timelineJson = ? WHERE id = ?`).run(
    JSON.stringify(timeline.segments),
    job.id
  );
  for (const issue of timeline.issues) {
    writeLog({ jobId: job.id, projectId: job.projectId, level: 'warn', message: `分镜 ${issue.shotIndex} 被跳过：${issue.reason}` });
  }

  // ── 口播整轨 ──
  let narrationTrackPath: string | null = null;
  if (pkg.narration.mode === 'tts') {
    setStep(job.id, 'narration', 25);
    const tts = await import('./tts.ts');
    narrationTrackPath = await tts.buildNarrationTrack({
      timeline: timeline.segments,
      files: narrationFiles,
      introDurationSec: intro,
      workDir,
    });
  }

  // ── 封面（始终生成，intro>0 时兼作片头贴片）──
  setStep(job.id, 'cover', 28);
  const fontFile = resolveFontFile();
  const coverPath = path.join(jobDir, 'cover.jpg');
  await runFfmpeg(
    buildCoverArgs({
      sourceVideoPath: timeline.segments[0].clipPath,
      titleText: pkg.cover.titleText,
      titleSize: pkg.cover.titleSize,
      titleColor: pkg.cover.titleColor,
      width: pkg.width,
      height: pkg.height,
      fontFile,
      outJpgPath: coverPath,
    }),
    { timeoutMs: 60_000 }
  );

  // ── 字幕 ──
  setStep(job.id, 'subtitles', 30);
  let assPath: string | null = null;
  if (pkg.subtitle.enabled && timeline.segments.some((s) => s.subtitle.trim())) {
    assPath = path.join(workDir, 'subs.ass');
    fs.writeFileSync(assPath, buildAss(timeline.segments, pkg.subtitle, pkg.width, pkg.height), 'utf-8');
  }

  // ── 渲染 ──
  setStep(job.id, 'render', 32);
  const duckingSupported = await supportsFilter('sidechaincompress');
  const safeName = (pkg.outputName || `final-${Date.now()}`).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
  const outputPath = path.join(jobDir, `${safeName}.mp4`);
  let lastProgressWrite = 0;
  await runFfmpeg(
    buildRenderArgs({
      segments: timeline.segments,
      width: pkg.width,
      height: pkg.height,
      fps: pkg.fps,
      totalDurationSec: timeline.totalDurationSec,
      introDurationSec: intro,
      coverJpgPath: intro > 0 ? coverPath : null,
      narrationTrackPath,
      bgm: pkg.bgm && fs.existsSync(pkg.bgm.path) ? pkg.bgm : null,
      duckingSupported,
      assPath,
      fontsDir: fontFile ? path.dirname(fontFile) : '',
      outputPath,
    }),
    {
      timeoutMs: RENDER_TIMEOUT_MS,
      onProgressSec: (sec) => {
        const now = Date.now();
        if (now - lastProgressWrite < 1000) return;
        lastProgressWrite = now;
        if (!jobStillRunning(job.id)) return;
        const pct = 32 + Math.min(63, (sec / Math.max(0.1, timeline.totalDurationSec)) * 63);
        setStep(job.id, 'render', Math.round(pct));
      },
    }
  );

  // ── finalize ──
  setStep(job.id, 'finalize', 98);
  const actualDuration = await probeDurationSec(outputPath);
  const manifestPath = path.join(jobDir, 'manifest.json');
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        schemaVersion: 1,
        jobId: job.id,
        projectId: job.projectId,
        shotSetId: job.shotSetId,
        scriptDraftId: job.scriptDraftId,
        createdAt: new Date().toISOString(),
        package: pkg,
        timeline: timeline.segments,
        output: { video: outputPath, cover: coverPath, durationSec: actualDuration, width: pkg.width, height: pkg.height },
      },
      null,
      2
    ),
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
