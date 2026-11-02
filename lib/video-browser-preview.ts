/**
 * 浏览器预览衍生物（HEVC/10bit → H.264 副本）。原件与下载始终不变。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { probeVideoMedia, runFfmpeg } from './ffmpeg.ts';
import { authorizeManagedFileRead } from './media-core/access-context.ts';
import { getExecutionModuleRuntime } from './media-core/execution/module-runtime.ts';
import { MediaResourceDeferredError, withMediaResource } from './media-core/media-resource-gate.ts';

const PREVIEW_TRANSCODE_TIMEOUT_MS = 120_000;
const PREVIEW_LEASE_MS = PREVIEW_TRANSCODE_TIMEOUT_MS + 10_000;
const PREVIEW_FAILURE_RETRY_MS = 5_000;

export function browserPreviewPath(videoPath: string): string {
  const ext = path.extname(videoPath);
  return `${videoPath.slice(0, videoPath.length - ext.length)}.preview.mp4`;
}

export class BrowserPreviewPendingError extends Error {
  readonly code = 'browser_preview_pending';
  readonly retryAfterMs = 1000;
  readonly jobKey: string;

  constructor(jobKey: string) {
    super('浏览器预览尚未就绪，请稍后重试');
    this.name = 'BrowserPreviewPendingError';
    this.jobKey = jobKey;
  }
}

function isBrowserPlayable(codec: string, pixelFormat: string): boolean {
  return codec === 'h264' && pixelFormat === 'yuv420p';
}

function previewJobKey(videoPath: string): string {
  return createHash('sha256').update(path.resolve(videoPath)).digest('hex');
}

interface PreviewJobRow {
  jobKey: string;
  status: 'pending' | 'running' | 'ready' | 'failed';
  leaseUntil: number | null;
  retryAfter: number | null;
}

async function database(): Promise<Database.Database> {
  const { getDb } = await import('./db.ts');
  return getDb();
}

async function readJob(jobKey: string): Promise<PreviewJobRow | undefined> {
  const db = await database();
  return db.prepare('SELECT jobKey, status, leaseUntil, retryAfter FROM media_derivative_jobs WHERE jobKey = ?')
    .get(jobKey) as PreviewJobRow | undefined;
}

function jobPending(job: PreviewJobRow | undefined, now: number): boolean {
  return Boolean(
    (job?.status === 'running' && (job.leaseUntil ?? 0) > now)
    || (job?.status === 'failed' && (job.retryAfter ?? 0) > now),
  );
}

async function claimJob(videoPath: string, previewPath: string, jobKey: string): Promise<{ owner: string } | null> {
  const db = await database();
  const now = Date.now();
  const owner = randomUUID();
  return db.transaction(() => {
    const existing = readJobSync(db, jobKey);
    if (jobPending(existing, now)) return null;
    const at = Date.now();
    if (!existing) {
      db.prepare(`INSERT INTO media_derivative_jobs
        (jobKey, sourcePath, derivativePath, status, createdAt, updatedAt)
        VALUES (?, ?, ?, 'pending', ?, ?)`)
        .run(jobKey, path.resolve(videoPath), path.resolve(previewPath), at, at);
    }
    const claimed = db.prepare(`
      UPDATE media_derivative_jobs
      SET status = 'running', leaseOwner = ?, leaseUntil = ?, retryAfter = NULL,
          error = NULL, updatedAt = ?
      WHERE jobKey = ?
    `).run(owner, at + PREVIEW_LEASE_MS, at, jobKey);
    return claimed.changes === 1 ? { owner } : null;
  }).immediate();
}

function readJobSync(db: Database.Database, jobKey: string): PreviewJobRow | undefined {
  return db.prepare('SELECT jobKey, status, leaseUntil, retryAfter FROM media_derivative_jobs WHERE jobKey = ?')
    .get(jobKey) as PreviewJobRow | undefined;
}

async function finishJob(
  jobKey: string,
  owner: string,
  outcome: { status: 'ready' } | { status: 'failed'; error: string },
): Promise<void> {
  const db = await database();
  const now = Date.now();
  db.prepare(`
    UPDATE media_derivative_jobs
    SET status = ?, leaseOwner = NULL, leaseUntil = NULL, retryAfter = ?, error = ?, updatedAt = ?
    WHERE jobKey = ? AND leaseOwner = ?
  `).run(
    outcome.status,
    outcome.status === 'failed' ? now + PREVIEW_FAILURE_RETRY_MS : null,
    outcome.status === 'failed' ? outcome.error.slice(0, 500) : null,
    now,
    jobKey,
    owner,
  );
}

const inflight = new Map<string, Promise<string>>();

export function ensureBrowserPreview(
  videoPath: string,
  options: { waitForCompletion?: boolean } = {},
): Promise<string> {
  const existing = inflight.get(videoPath);
  if (existing) return existing;
  const task = doEnsureBrowserPreview(videoPath, options).finally(() => {
    inflight.delete(videoPath);
  });
  inflight.set(videoPath, task);
  return task;
}

async function doEnsureBrowserPreview(
  videoPath: string,
  options: { waitForCompletion?: boolean },
): Promise<string> {
  const jobKey = previewJobKey(videoPath);
  const previewPath = browserPreviewPath(videoPath);
  authorizeManagedFileRead(videoPath);
  try {
    if (fs.existsSync(previewPath) && fs.statSync(previewPath).size > 0) return previewPath;
    if (jobPending(await readJob(jobKey), Date.now())) throw new BrowserPreviewPendingError(jobKey);
    return await withMediaResource({
      taskId: `browser-preview:${jobKey}`,
      step: 'preview-transcode',
      wait: options.waitForCompletion === true || !getExecutionModuleRuntime(),
    }, async () => {
      const probe = await probeVideoMedia(videoPath);
      const codec = (probe.videoCodec || '').toLowerCase();
      const pixelFormat = (probe.pixelFormat || '').toLowerCase();
      const safeAudio = !probe.hasAudio || ['aac', 'mp3'].includes(probe.audioCodec ?? '');
      if (isBrowserPlayable(codec, pixelFormat) && safeAudio && path.extname(videoPath).toLowerCase() !== '.mov') return videoPath;
      if (!probe.width || !probe.height) return videoPath;
      if (fs.existsSync(previewPath) && fs.statSync(previewPath).size > 0) return previewPath;

      const claim = await claimJob(videoPath, previewPath, jobKey);
      if (!claim) throw new BrowserPreviewPendingError(jobKey);
      try {
        await runFfmpeg([
          '-y', '-i', videoPath,
          '-map', '0:v:0', '-map', '0:a?',
          '-c:v', 'libx264', '-crf', '19', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
          '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', previewPath,
        ], { timeoutMs: PREVIEW_TRANSCODE_TIMEOUT_MS });
        await finishJob(jobKey, claim.owner, { status: 'ready' });
        return previewPath;
      } catch (error) {
        await finishJob(jobKey, claim.owner, {
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    });
  } catch (error) {
    if (error instanceof BrowserPreviewPendingError) throw error;
    if (error instanceof MediaResourceDeferredError) throw new BrowserPreviewPendingError(jobKey);
    console.warn(
      `[video-browser-preview] 预览衍生物生成失败，回退原件：${path.basename(videoPath)}：`,
      error instanceof Error ? error.message : error,
    );
    return videoPath;
  }
}
