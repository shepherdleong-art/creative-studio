import { getDb } from './db';
import { getVideoAdapter } from './video-providers/index';
import { writeLog } from './logger';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';

export interface VideoQueueOptions {
  projectId: string;
  concurrency: number;
  timeoutMs: number;
}

// Number of video jobs to run concurrently per project. Override with the
// VIDEO_CONCURRENCY env var; clamped to 1–6 to respect provider rate limits.
export const DEFAULT_VIDEO_CONCURRENCY = Math.max(1, Math.min(6, Number(process.env.VIDEO_CONCURRENCY) || 3));

interface VideoJobRecord {
  id: string;
  projectId: string;
  shotSetId: string | null;
  shotId: string | null;
  sourceImageId: string;
  providerId: string;
  model: string;
  prompt: string;
  durationSec: number;
  status: string;
  attempt: number;
  maxAttempts: number;
}

type QueueStatus = 'idle' | 'running' | 'paused';

const runningQueues = new Map<string, { abort: AbortController; status: QueueStatus }>();

export function getVideoQueueStatus(projectId: string): QueueStatus {
  return runningQueues.get(projectId)?.status ?? 'idle';
}

export function pauseVideoQueue(projectId: string) {
  const entry = runningQueues.get(projectId);
  if (entry) entry.status = 'paused';
}

export function resumeVideoQueue(projectId: string, options: VideoQueueOptions) {
  const entry = runningQueues.get(projectId);
  if (entry) {
    entry.status = 'running';
  } else {
    runVideoQueue(options).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[VideoQueue] Fatal error for project ${projectId}: ${msg}`);
      writeLog({ jobId: '', projectId, level: 'error', message: `Video queue fatal error: ${msg}` });
    });
  }
}

export function cancelVideoQueue(projectId: string) {
  const entry = runningQueues.get(projectId);
  if (entry) {
    entry.abort.abort();
    runningQueues.delete(projectId);
    const db = getDb();
    db.prepare(
      `UPDATE video_jobs SET status = 'canceled', errorMessage = 'Canceled by user'
       WHERE projectId = ? AND status IN ('pending', 'running')`
    ).run(projectId);
  }
}

export async function runVideoQueue(options: VideoQueueOptions): Promise<void> {
  const { projectId, concurrency, timeoutMs } = options;

  const existingStatus = getVideoQueueStatus(projectId);
  if (existingStatus !== 'idle') {
    throw new Error(`Video queue is already ${existingStatus} for project ${projectId}`);
  }

  const abort = new AbortController();
  runningQueues.set(projectId, { abort, status: 'running' });

  const db = getDb();

  // Recover stuck running jobs from a previous crash
  db.prepare(
    `UPDATE video_jobs SET status = 'pending', errorMessage = 'Recovered from interrupted run'
     WHERE projectId = ? AND status = 'running'`
  ).run(projectId);

  try {
    async function worker(workerId: number) {
      while (!abort.signal.aborted) {
        const entry = runningQueues.get(projectId);
        if (entry?.status === 'paused') {
          await sleep(500);
          continue;
        }

        const job = claimNextVideoJob(projectId);
        if (!job) {
          const runningCount = db
            .prepare(`SELECT COUNT(*) as count FROM video_jobs WHERE projectId = ? AND status = 'running'`)
            .get(projectId) as { count: number };
          if (runningCount.count === 0) break;
          await sleep(500);
          continue;
        }

        await runVideoJob(job, { timeoutMs, abort: abort.signal });
      }
    }

    await Promise.allSettled(
      Array.from({ length: concurrency }, (_, i) => worker(i + 1))
    );
  } finally {
    if (!abort.signal.aborted) {
      runningQueues.delete(projectId);
    }
  }
}

async function runVideoJob(
  job: VideoJobRecord,
  options: { timeoutMs: number; abort: AbortSignal }
): Promise<void> {
  const db = getDb();
  const { timeoutMs, abort } = options;

  if (abort.aborted) return;

  const attempt = job.attempt;
  const logInfo = (msg: string) =>
    writeLog({ jobId: job.id, projectId: job.projectId, level: 'info', message: msg, attempt });
  const logError = (msg: string) =>
    writeLog({ jobId: job.id, projectId: job.projectId, level: 'error', message: msg, attempt });
  const logWarn = (msg: string) =>
    writeLog({ jobId: job.id, projectId: job.projectId, level: 'warn', message: msg, attempt });

  logInfo(`Video job started (attempt ${attempt}/${job.maxAttempts})`);

  try {
    // Load provider
    const provider = db
      .prepare(`SELECT * FROM video_providers WHERE id = ?`)
      .get(job.providerId) as {
      id: string;
      name: string;
      type: string;
      baseUrlEnv: string;
      apiKeyEnv: string;
      modelEnv: string;
      defaultModel: string;
    } | undefined;

    if (!provider) throw new Error('Video provider not found');

    const baseUrl = process.env[provider.baseUrlEnv];
    const apiKeyEnvName = provider.apiKeyEnv;
    let apiKey = process.env[apiKeyEnvName];
    if (!baseUrl || !apiKey) {
      throw new Error(`Video provider not configured. Set ${provider.baseUrlEnv} and ${apiKeyEnvName}`);
    }

    // Kling uses access_key:secret_key format — generate JWT
    if (provider.type === 'kling') {
      const [accessKey, secretKey] = apiKey.split(':');
      if (accessKey && secretKey) {
        const { getKlingToken } = await import('./video-providers/kling');
        apiKey = getKlingToken(accessKey, secretKey);
      }
    }

    const adapter = getVideoAdapter(provider.type);
    if (!adapter) throw new Error(`Unknown video provider type: ${provider.type}`);

    // Load source image
    const sourceImage = db
      .prepare(`SELECT * FROM image_assets WHERE id = ?`)
      .get(job.sourceImageId) as {
      path: string;
      processedPath: string | null;
      mimeType: string;
    } | undefined;

    if (!sourceImage) throw new Error('Source image not found');

    const imagePath = sourceImage.processedPath || sourceImage.path;
    const mimeType = (sourceImage.mimeType || 'image/png') as 'image/png' | 'image/jpeg' | 'image/webp';

    logInfo(`Calling video API: ${baseUrl} (type=${provider.type}, model=${job.model}, duration=${job.durationSec}s)`);

    const reqAbort = new AbortController();
    const onAbort = () => reqAbort.abort();
    abort.addEventListener('abort', onAbort, { once: true });

    // Step 1: Submit
    const startedAt = Date.now();
    logInfo('Submitting video generation task...');
    const submitResult = await adapter.submit(
      {
        model: job.model,
        prompt: job.prompt,
        sourceImagePath: imagePath,
        sourceMimeType: mimeType,
        durationSec: job.durationSec,
      },
      apiKey,
      baseUrl,
      reqAbort.signal
    );

    if (!submitResult.providerTaskId) {
      throw new Error('Video provider did not return a task_id');
    }

    const taskId = submitResult.providerTaskId;
    db.prepare(
      `UPDATE video_jobs SET providerTaskId = ?, providerStatus = 'submitted', providerRawResponse = ?, startedAt = datetime('now')
       WHERE id = ?`
    ).run(taskId, safeJson(submitResult.rawResponse), job.id);
    logInfo(`Video task submitted, task_id=${taskId}`);

    // Step 2: Poll with graduated intervals
    let polled = false;
    const maxPollMs = timeoutMs || 600_000;

    while (Date.now() - startedAt < maxPollMs) {
      if (reqAbort.signal.aborted) throw new DOMException('Aborted', 'AbortError');

      await sleep(5000); // poll every 5 seconds

      const pollResult = await adapter.poll(taskId, apiKey, baseUrl, reqAbort.signal);

      const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
      db.prepare(
        `UPDATE video_jobs SET providerStatus = ?, providerRawResponse = ?, lastPolledAt = datetime('now'), pollCount = pollCount + 1
         WHERE id = ?`
      ).run(pollResult.status, safeJson(pollResult.rawResponse), job.id);
      logInfo(`Video poll status=${pollResult.status} (${elapsedSec}s elapsed)`);

      if (pollResult.status === 'succeeded' && pollResult.videoUrl) {
        // Step 3: Download video
        logInfo(`Video generation succeeded, downloading: ${pollResult.videoUrl}`);
        const videoBuffer = await downloadVideo(pollResult.videoUrl);

        if (!videoBuffer) {
          logError(`Remote video ready but local download failed: ${pollResult.videoUrl}`);
          db.prepare(
            `UPDATE video_jobs SET status = 'failed', errorMessage = ?, providerStatus = 'download_failed', remoteVideoUrl = ?
             WHERE id = ? AND status = 'running'`
          ).run(`Remote video ready but download failed. URL: ${pollResult.videoUrl}`, pollResult.videoUrl, job.id);
          return;
        }

        // Save video to storage/videos/
        const videosDir = path.join(process.cwd(), 'storage', 'videos');
        if (!fs.existsSync(videosDir)) fs.mkdirSync(videosDir, { recursive: true });

        const videoFilename = `video-${job.id.slice(0, 8)}-${Date.now()}.mp4`;
        const videoPath = path.join(videosDir, videoFilename);
        fs.writeFileSync(videoPath, videoBuffer);

        db.prepare(
          `UPDATE video_jobs SET
            status = 'succeeded',
            providerStatus = 'succeeded',
            remoteVideoUrl = ?,
            localVideoPath = ?,
            filename = ?,
            finishedAt = datetime('now')
           WHERE id = ? AND status = 'running'`
        ).run(pollResult.videoUrl, videoPath, videoFilename, job.id);

        logInfo(`Video job completed, saved as ${videoFilename}`);
        polled = true;
        break;
      }

      if (pollResult.status === 'failed') {
        throw new Error(`Video generation failed: ${pollResult.errorMessage || 'unknown'}`);
      }
    }

    if (!polled) {
      // Polling timeout with task_id → needs_check
      logWarn(`Video polling timeout (task_id=${taskId}) → needs_check`);
      db.prepare(
        `UPDATE video_jobs SET status = 'needs_check', errorMessage = ?, providerStatus = 'needs_check', finishedAt = datetime('now')
         WHERE id = ? AND status = 'running'`
      ).run(`Polling timeout (${Math.round((Date.now() - startedAt) / 1000)}s). task_id=${taskId} may still be running.`, job.id);
    }
  } catch (err: unknown) {
    if (abort.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
      db.prepare(
        `UPDATE video_jobs SET status = 'canceled', errorMessage = 'Canceled by user'
         WHERE id = ? AND status = 'running'`
      ).run(job.id);
      return;
    }

    const errorMessage = (err instanceof Error ? err.message : String(err)).slice(0, 2000);
    logError(`Video job failed: ${errorMessage}`);

    if (attempt >= job.maxAttempts) {
      db.prepare(
        `UPDATE video_jobs SET status = 'failed', finishedAt = datetime('now'), errorMessage = ?
         WHERE id = ? AND status = 'running'`
      ).run(errorMessage, job.id);
    } else {
      db.prepare(
        `UPDATE video_jobs SET status = 'pending', errorMessage = ?
         WHERE id = ? AND status = 'running'`
      ).run(errorMessage, job.id);
    }
  }
}

function claimNextVideoJob(projectId: string): (VideoJobRecord & { attempt: number }) | null {
  const db = getDb();
  const job = db.prepare(`
    SELECT * FROM video_jobs
    WHERE projectId = ? AND status = 'pending'
    ORDER BY id LIMIT 1
  `).get(projectId) as VideoJobRecord | undefined;

  if (!job) return null;

  const nextAttempt = job.attempt + 1;
  const result = db.prepare(`
    UPDATE video_jobs SET status = 'running', attempt = ?, startedAt = datetime('now'), errorMessage = NULL
    WHERE id = ? AND status = 'pending'
  `).run(nextAttempt, job.id);

  if (result.changes !== 1) return null;
  return { ...job, status: 'running', attempt: nextAttempt };
}

async function downloadVideo(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

function safeJson(obj: unknown, maxLen = 4000): string {
  if (obj === null || obj === undefined) return '';
  try {
    const s = JSON.stringify(obj);
    return s.length > maxLen ? s.slice(0, maxLen) + '...[truncated]' : s;
  } catch {
    return '[unserializable]';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { runningQueues as runningVideoQueues };
