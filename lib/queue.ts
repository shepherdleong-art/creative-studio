import { getDb } from './db';
import { editImage as editImageOpenAI, EditImageRequest } from './providers/openai-compatible';
import { submitGeekAITask, pollGeekAITask, downloadGeekAIImage, summarizeGeekAIResponse } from './providers/geekai-json';
import { calculateEstimatedCost } from './cost';
import { writeLog } from './logger';
import path from 'path';
import fs from 'fs';

export interface QueueOptions {
  projectId: string;
  concurrency: number;
  maxAttempts: number;
  timeoutMs: number;
}

interface JobRecord {
  id: string;
  projectId: string;
  inputImageId: string;
  referenceImageIds: string;
  providerId: string;
  model: string;
  prompt: string;
  size: string;
  quality: string;
  status: string;
  attempt: number;
  maxAttempts: number;
  revision?: number;
}

type QueueStatus = 'idle' | 'running' | 'paused';

const runningQueues = new Map<string, { abort: AbortController; status: QueueStatus }>();

export function getQueueStatus(projectId: string): QueueStatus {
  return runningQueues.get(projectId)?.status ?? 'idle';
}

export function pauseQueue(projectId: string) {
  const entry = runningQueues.get(projectId);
  if (entry) {
    entry.status = 'paused';
  }
}

export function resumeQueue(projectId: string, options: QueueOptions) {
  const entry = runningQueues.get(projectId);
  if (entry) {
    entry.status = 'running';
  } else {
    runQueue(options).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Queue] Fatal queue error for project ${projectId}: ${msg}`);
      writeLog({
        jobId: '',
        projectId,
        level: 'error',
        message: `Queue fatal error: ${msg}`,
      });
    });
  }
}

export function cancelQueue(projectId: string) {
  const entry = runningQueues.get(projectId);
  if (entry) {
    entry.abort.abort();
    runningQueues.delete(projectId);

    // Only cancel jobs that haven't been claimed as running — running ones
    // will be handled by the abort signal in-flight
    const db = getDb();
    db.prepare(
      `UPDATE jobs SET status = 'canceled', errorMessage = 'Canceled by user'
       WHERE projectId = ? AND status IN ('pending', 'retrying', 'running')`
    ).run(projectId);
    db.prepare(
      `UPDATE projects SET status = 'canceled' WHERE id = ?`
    ).run(projectId);
  }
}

/**
 * Start running the queue for a project. Throws if a queue is already active.
 */
export async function runQueue(options: QueueOptions): Promise<void> {
  const { projectId, concurrency, maxAttempts, timeoutMs } = options;

  // Guard: prevent duplicate start
  const existingStatus = getQueueStatus(projectId);
  if (existingStatus !== 'idle') {
    throw new Error(`Queue is already ${existingStatus} for project ${projectId}`);
  }

  const abort = new AbortController();
  runningQueues.set(projectId, { abort, status: 'running' });

  const db = getDb();

  // Recover any stuck "running" jobs from a previous crash
  db.prepare(
    `UPDATE jobs SET status = 'retrying', errorMessage = 'Recovered from interrupted run'
     WHERE projectId = ? AND status = 'running'`
  ).run(projectId);

  try {
    db.prepare(`UPDATE projects SET status = 'running' WHERE id = ?`).run(projectId);

    // ── Worker pool: each worker independently claims and runs jobs ──
    // This prevents a single slow job from blocking the rest of the batch.
    async function worker(workerId: number) {
      while (!abort.signal.aborted) {
        const entry = runningQueues.get(projectId);
        if (entry?.status === 'paused') {
          await sleep(500);
          continue;
        }

        // Atomically claim next pending/retrying job
        const job = claimNextJob(projectId);
        if (!job) {
          // No pending jobs. Check if any are still running.
          const runningCount = db
            .prepare(`SELECT COUNT(*) as count FROM jobs WHERE projectId = ? AND status = 'running'`)
            .get(projectId) as { count: number };
          if (runningCount.count === 0) break;
          await sleep(500);
          continue;
        }

        await runJob(job, { timeoutMs, maxAttempts, abort: abort.signal });
      }
    }

    await Promise.allSettled(
      Array.from({ length: concurrency }, (_, i) => worker(i + 1))
    );

    if (!abort.signal.aborted) {
      const failedCount = db
        .prepare(`SELECT COUNT(*) as count FROM jobs WHERE projectId = ? AND status = 'failed'`)
        .get(projectId) as { count: number };

      db.prepare(
        `UPDATE projects SET status = ? WHERE id = ?`
      ).run(failedCount.count > 0 ? 'partial_failed' : 'completed', projectId);
    }
  } finally {
    if (!abort.signal.aborted) {
      runningQueues.delete(projectId);
    }
  }
}

/**
 * Run a single job with atomic claiming, abort support, and post-request validation.
 */
async function runJob(
  job: JobRecord,
  options: { timeoutMs: number; maxAttempts: number; abort: AbortSignal }
): Promise<void> {
  const db = getDb();
  const { timeoutMs, maxAttempts, abort } = options;

  if (abort.aborted) return;

  // Job was already claimed atomically by the worker pool.
  // attempt and startedAt were set during claimNextJob().
  const attempt = job.attempt;
  const startedAt = new Date().toISOString();

  const logInfo = (msg: string) =>
    writeLog({ jobId: job.id, projectId: job.projectId, level: 'info', message: msg, attempt });
  const logError = (msg: string) =>
    writeLog({ jobId: job.id, projectId: job.projectId, level: 'error', message: msg, attempt });
  const logWarn = (msg: string) =>
    writeLog({ jobId: job.id, projectId: job.projectId, level: 'warn', message: msg, attempt });

  logInfo(`Job started (attempt ${attempt}/${job.maxAttempts || maxAttempts})`);

  try {
    // Load input image (prefer processedPath for API calls)
    const inputImage = db
      .prepare(`SELECT * FROM image_assets WHERE id = ?`)
      .get(job.inputImageId) as {
      filename: string;
      path: string;
      processedPath: string | null;
      mimeType: string;
      originalWidth: number | null;
      originalHeight: number | null;
      originalSizeBytes: number | null;
      processedWidth: number | null;
      processedHeight: number | null;
      processedSizeBytes: number | null;
    } | undefined;

    if (!inputImage) {
      throw new Error('Input image not found');
    }

    const inputApiPath = inputImage.processedPath || inputImage.path;
    // MIME from processed file if available, otherwise original
    const inputMimeType = (inputImage.mimeType || 'image/png') as 'image/png' | 'image/jpeg' | 'image/webp';

    // Load reference images
    const refIds: string[] = JSON.parse(job.referenceImageIds);
    const rawRefImages = refIds.length > 0
      ? db.prepare(
          `SELECT * FROM image_assets WHERE id IN (${refIds.map(() => '?').join(',')})`
        ).all(...refIds) as Array<{
        path: string;
        processedPath: string | null;
        mimeType: string;
      }>
      : [];

    const refApiPaths = rawRefImages.map((r) => r.processedPath || r.path);
    const refMimeTypes = rawRefImages.map((r) => (r.mimeType || 'image/png') as 'image/png' | 'image/jpeg' | 'image/webp');

    // Load provider
    const provider = db
      .prepare(`SELECT * FROM providers WHERE id = ?`)
      .get(job.providerId) as {
      id: string;
      baseUrl: string;
      apiKeyEnv: string;
      apiKey: string;
      model: string;
      type: string;
      defaultCostPerImage?: number;
    } | undefined;

    if (!provider) {
      throw new Error('Provider not found');
    }

    const apiKey = provider.apiKey || process.env[provider.apiKeyEnv];
    if (!apiKey) {
      throw new Error('API key not configured. Please set it in Settings.');
    }

    const providerType = provider.type || 'openai-compatible';

    logInfo(`Calling API: ${provider.baseUrl} (type=${providerType}, model=${job.model}, size=${job.size})`);

    // Create a per-request AbortController linked to the queue's abort signal
    const reqAbort = new AbortController();
    const onAbort = () => reqAbort.abort();
    abort.addEventListener('abort', onAbort, { once: true });

    // ── Route to correct adapter ──
    let result: { imageBuffer: Buffer; latencyMs: number; rawResponse?: unknown } | undefined;

    if (providerType === 'geekai-json') {
      // ── GeekAI async flow: submit → poll → download ──
      const geekaiStart = Date.now();

      // Step 1: Submit task
      logInfo('提交任务到 GeekAI...');
      const submitResult = await submitGeekAITask(
        {
          model: job.model,
          prompt: job.prompt,
          inputImagePath: inputApiPath,
          inputMimeType,
          referenceImagePaths: refApiPaths,
          referenceMimeTypes: refMimeTypes,
          size: job.size,
          quality: job.quality,
        },
        apiKey,
        provider.baseUrl
      );

      // Handle sync response (immediate result, no taskId)
      if (submitResult.immediateImageUrl || submitResult.immediateImageBase64) {
        let buf: Buffer;
        if (submitResult.immediateImageBase64) {
          buf = Buffer.from(submitResult.immediateImageBase64, 'base64');
        } else {
          const imgRes = await fetch(submitResult.immediateImageUrl!);
          buf = Buffer.from(await imgRes.arrayBuffer());
        }
        result = {
          imageBuffer: buf,
          latencyMs: Date.now() - geekaiStart,
          rawResponse: submitResult.rawResponse,
        };
        logInfo('GeekAI 同步返回结果');
      } else if (submitResult.taskId) {
        // Step 2: Save taskId and raw response, start polling
        const taskId = submitResult.taskId;
        db.prepare(
          `UPDATE jobs SET providerTaskId = ?, providerStatus = 'submitted', providerRawResponse = ?, submittedAt = datetime('now')
           WHERE id = ?`
        ).run(taskId, safeJsonForDB(submitResult.rawResponse), job.id);
        logInfo(`任务已提交, task_id=${taskId} raw=${summarizeGeekAIResponse(submitResult.rawResponse)}`);

        // Step 3: Poll with graduated intervals
        let polled = false;
        const maxPollMs = timeoutMs || 300_000; // default 5 minutes, no forced minimum

        while (Date.now() - geekaiStart < maxPollMs) {
          if (reqAbort.signal.aborted) throw new DOMException('Aborted', 'AbortError');

          const pollResult = await pollGeekAITask(
            taskId,
            apiKey,
            provider.baseUrl,
            geekaiStart,
            reqAbort.signal
          );

          const elapsedSec = Math.round((Date.now() - geekaiStart) / 1000);
          db.prepare(
            `UPDATE jobs SET providerStatus = ?, providerRawResponse = ?, lastPolledAt = datetime('now'), pollCount = pollCount + 1 WHERE id = ?`
          ).run(pollResult.status, safeJsonForDB(pollResult.rawResponse), job.id);
          logInfo(`轮询 task_id=${taskId} raw=${summarizeGeekAIResponse(pollResult.rawResponse)} (${elapsedSec}s)`);

          if (pollResult.status === 'succeeded' && pollResult.imageUrl) {
            // Step 4: Download image
            logInfo(`远端生成成功，下载图片: ${pollResult.imageUrl}`);
            const imgBuffer = await downloadGeekAIImage(pollResult.imageUrl);

            if (imgBuffer) {
              db.prepare(
                `UPDATE jobs SET providerStatus = 'succeeded', remoteImageUrl = ? WHERE id = ?`
              ).run(pollResult.imageUrl, job.id);
              result = {
                imageBuffer: imgBuffer,
                latencyMs: Date.now() - geekaiStart,
                rawResponse: pollResult.rawResponse,
              };
              polled = true;
              break;
            } else {
              // Remote success, local download failed
              logError(`远端成功但本地下载失败: ${pollResult.imageUrl}`);
              db.prepare(
                `UPDATE jobs SET status = 'failed', errorMessage = ?, providerStatus = 'download_failed', remoteImageUrl = ?
                 WHERE id = ? AND status = 'running'`
              ).run(`远端图片已生成但本地下载失败。远端URL: ${pollResult.imageUrl}`, pollResult.imageUrl, job.id);
              return; // Don't retry — the money was already spent
            }
          }

          if (pollResult.status === 'failed') {
            throw new Error(`GeekAI task failed: ${pollResult.errorMessage || 'unknown'}`);
          }
        }

        if (!polled) {
          // Polling timed out but we have a taskId — mark needs_check, don't retry
          logWarn(`轮询超时，进入 needs_check (task_id=${taskId})`);
          db.prepare(
            `UPDATE jobs SET status = 'needs_check', errorMessage = ?, providerStatus = 'needs_check', finishedAt = datetime('now')
             WHERE id = ? AND status = 'running'`
          ).run(
            `轮询超时 (${Math.round((Date.now() - geekaiStart) / 1000)}s)。远端 task_id=${taskId} 可能仍在执行，请点"补抓结果"继续查询。`,
            job.id
          );
          return;
        }
      } else {
        throw new Error('GeekAI 未返回 task_id 或图片结果');
      }
    } else {
      // OpenAI-compatible uses multipart/form-data
      result = await withTimeout(
        editImageOpenAI(
          {
            provider: {
              id: provider.id,
              name: '',
              baseUrl: provider.baseUrl,
              apiKeyEnv: provider.apiKeyEnv,
              model: provider.model,
              type: 'openai-compatible',
              enabled: true,
              defaultCostPerImage: provider.defaultCostPerImage,
            },
            model: job.model,
            prompt: job.prompt,
            inputImagePath: inputApiPath,
            inputMimeType,
            referenceImagePaths: refApiPaths,
            referenceMimeTypes: refMimeTypes,
            size: job.size,
            quality: job.quality,
          },
          apiKey,
          provider.baseUrl,
          reqAbort.signal
        ),
        timeoutMs,
        reqAbort
      );
    }

    // Clean up the abort listener
    abort.removeEventListener('abort', onAbort);

    // If GeekAI branch returned early (download_failed / needs_check), skip the rest
    if (!result) return;

    logInfo(`API call succeeded (latency: ${result.latencyMs}ms)`);

    // ── Post-request check: is the job still running? ──
    // The user may have canceled while the request was in-flight.
    // Only save output if the job is still in 'running' state.
    const currentJob = db.prepare(`SELECT status FROM jobs WHERE id = ?`).get(job.id) as { status: string } | undefined;

    if (!currentJob || currentJob.status !== 'running') {
      logWarn(`Job state changed to "${currentJob?.status}" during API call, discarding result`);
      return;
    }

    if (abort.aborted) {
      logWarn('Queue aborted, discarding result');
      // Mark as canceled since the queue was aborted
      db.prepare(`UPDATE jobs SET status = 'canceled', errorMessage = 'Queue canceled' WHERE id = ? AND status = 'running'`).run(job.id);
      return;
    }

    // Save output image
    const outputsDir = path.join(process.cwd(), 'storage', 'outputs');
    if (!fs.existsSync(outputsDir)) {
      fs.mkdirSync(outputsDir, { recursive: true });
    }

    // Output filename based on input image name + revision
    const inputBase = sanitizeFilenameBase(inputImage.filename || inputImage.path);
    const revSuffix = (job.revision && job.revision > 0) ? `-r${job.revision}` : '';
    const preferredOutputName = `output-${inputBase}${revSuffix}.png`;
    const outputFilename = ensureUniqueFilename(outputsDir, preferredOutputName, job.id.slice(0, 6));
    let outputPath = path.join(outputsDir, outputFilename);
    fs.writeFileSync(outputPath, result.imageBuffer);

    // Save output image asset
    const { v4: uuidv4 } = require('uuid');
    const outputImageId = uuidv4();
    db.prepare(
      `INSERT INTO image_assets (id, projectId, role, filename, path, mimeType, createdAt)
       VALUES (?, ?, 'output', ?, ?, 'image/png', datetime('now'))`
    ).run(outputImageId, job.projectId, outputFilename, outputPath);

    const finishedAt = new Date().toISOString();
    const estimatedCost = calculateEstimatedCost(provider.defaultCostPerImage, attempt - 1);

    // ── Atomic completion: only mark succeeded if still running ──
    const completeResult = db.prepare(
      `UPDATE jobs SET
        status = 'succeeded',
        finishedAt = ?,
        latencyMs = ?,
        estimatedCost = ?,
        outputImageId = ?
       WHERE id = ? AND status = 'running'`
    ).run(finishedAt, result.latencyMs, estimatedCost, outputImageId, job.id);

    if (completeResult.changes === 1) {
      logInfo(`任务完成 (成本: ¥${estimatedCost.toFixed(4)})`);
    } else {
      logWarn('Job was no longer running when trying to mark succeeded, discarding');
    }
  } catch (err: unknown) {
    let errorMessage = err instanceof Error ? err.message : String(err);

    // If aborted by user, mark as canceled — never retry
    if (abort.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
      errorMessage = 'Canceled by user';
      db.prepare(
        `UPDATE jobs SET status = 'canceled', errorMessage = ?
         WHERE id = ? AND status = 'running'`
      ).run(errorMessage, job.id);
      logWarn('Job canceled by user');
      return;
    }

    errorMessage = sanitizeErrorMessage(errorMessage);

    logError(`Job failed: ${errorMessage}`);

    const effectiveMaxAttempts = job.maxAttempts || maxAttempts || 2;

    if (attempt >= effectiveMaxAttempts) {
      db.prepare(
        `UPDATE jobs SET status = 'failed', finishedAt = datetime('now'), errorMessage = ?
         WHERE id = ? AND status = 'running'`
      ).run(errorMessage, job.id);
      logError(`Job permanently failed after ${attempt} attempts`);
    } else {
      db.prepare(
        `UPDATE jobs SET status = 'retrying', errorMessage = ?
         WHERE id = ? AND status = 'running'`
      ).run(errorMessage, job.id);
      logWarn(`Job will retry (attempt ${attempt}/${effectiveMaxAttempts})`);
    }
  }
}

/**
 * Atomically claim the next pending/retrying job.
 * Returns the claimed job with attempt incremented, or null if none available.
 */
function claimNextJob(projectId: string): (JobRecord & { attempt: number }) | null {
  const db = getDb();
  const job = db.prepare(`
    SELECT * FROM jobs
    WHERE projectId = ? AND status IN ('pending', 'retrying')
    ORDER BY id LIMIT 1
  `).get(projectId) as JobRecord | undefined;

  if (!job) return null;

  const nextAttempt = job.attempt + 1;
  const result = db.prepare(`
    UPDATE jobs SET status = 'running', attempt = ?, startedAt = datetime('now'), errorMessage = NULL
    WHERE id = ? AND status IN ('pending', 'retrying')
  `).run(nextAttempt, job.id);

  if (result.changes !== 1) return null;
  return { ...job, status: 'running', attempt: nextAttempt };
}

function sanitizeFilenameBase(filePath: string): string {
  const parsed = path.parse(filePath);
  return parsed.name
    .trim()
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '_')
    .replace(/-+/g, '-')
    .slice(0, 80) || 'image';
}

function ensureUniqueFilename(dir: string, filename: string, fallbackSuffix: string): string {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  const direct = path.join(dir, filename);
  if (!fs.existsSync(direct)) return filename;

  const withSuffix = `${base}-${fallbackSuffix}${ext}`;
  if (!fs.existsSync(path.join(dir, withSuffix))) return withSuffix;

  let i = 2;
  while (true) {
    const candidate = `${base}-${fallbackSuffix}-${i}${ext}`;
    if (!fs.existsSync(path.join(dir, candidate))) return candidate;
    i += 1;
  }
}

function safeJsonForDB(obj: unknown, maxLen = 4000): string {
  if (obj === null || obj === undefined) return '';
  try {
    const s = JSON.stringify(obj);
    return s.length > maxLen ? s.slice(0, maxLen) + '...[truncated]' : s;
  } catch {
    return '[unserializable]';
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  abortController: AbortController
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      abortController.abort();
      reject(new Error(`Task timed out after ${ms}ms`));
    }, ms);

    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeErrorMessage(message: string): string {
  let sanitized = message
    .replace(/sk-[a-zA-Z0-9_-]{20,}/g, '[REDACTED_KEY]')
    .replace(/Bearer\s+[a-zA-Z0-9._\-=+/]{20,}/gi, 'Bearer [REDACTED]')
    .replace(/Authorization:\s*[^\s]+\s+[^\s,]+/gi, 'Authorization: [REDACTED]')
    .replace(/CF-Access-Client-(Id|Secret):\s*\S+/gi, 'CF-Access-Client-$1: [REDACTED]')
    .slice(0, 2000);

  if (message.length > 2000) {
    sanitized += '... [truncated]';
  }

  return sanitized;
}

export { runningQueues };
