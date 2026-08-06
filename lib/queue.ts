import { getDb } from './db.ts';
import { editImage as editImageOpenAI } from './providers/openai-compatible.ts';
import { submitGeekAITask, pollGeekAITask, downloadGeekAIImage, summarizeGeekAIResponse } from './providers/geekai-json.ts';
import { submitGatewayTaskImage, pollGatewayTaskImage, downloadGatewayTaskImage, summarizeGatewayTaskResponse } from './providers/gateway-task-image.ts';
import { redactMediaUrlForLog } from './gateway-media-url.ts';
import type * as PackyImages from './providers/packy-images.ts';
import { editImagePackyGemini } from './providers/packy-gemini-image.ts';
import { getNonRetryablePackyAdvice, isNonRetryablePackyError, isTimeoutLikeError } from './packy-errors.ts';
import { getEffectiveImageConcurrency } from './provider-concurrency.ts';
import { calculateEstimatedCost } from './cost.ts';
import { normalizeGeneratedImageToSize } from './image-output-normalize.ts';
import { isPlaceholderValue } from './video-auth.ts';
import { getEffectiveProjectFinalStatus } from './project-status.ts';
import { writeLog } from './logger.ts';
import { sanitizeFilenameBase, ensureUniqueFilename, getUsagePrefix } from './output-filenames.ts';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { dataRoot } from './data-root.ts';
import { isManagedDeployment } from './managed-deployment.ts';
import { assertProviderExecutionAvailable, assertProviderExecutionIdentityStable, readManagedExecutionGeneration, ProviderExecutionGateError } from './provider-execution-gate.ts';
import type { AssertProviderExecutionAvailableOptions } from './provider-execution-gate.ts';
import fs from 'fs';

export interface ImageQueueAdapterOverrides {
  submitGeekAITask?: typeof submitGeekAITask;
  pollGeekAITask?: typeof pollGeekAITask;
  downloadGeekAIImage?: typeof downloadGeekAIImage;
  submitGatewayTaskImage?: typeof submitGatewayTaskImage;
  pollGatewayTaskImage?: typeof pollGatewayTaskImage;
  downloadGatewayTaskImage?: typeof downloadGatewayTaskImage;
  editImagePacky?: typeof PackyImages.editImagePacky;
  editImagePackyGemini?: typeof editImagePackyGemini;
  editImageOpenAI?: typeof editImageOpenAI;
}

export interface QueueOptions {
  projectId: string;
  concurrency: number;
  maxAttempts: number;
  timeoutMs: number;
  /** Test seam for keeping provider execution tests completely offline. */
  adapters?: ImageQueueAdapterOverrides;
  /** Test seam for injecting managed runtime/allowlist state. */
  executionGate?: Omit<AssertProviderExecutionAvailableOptions, 'capability'>;
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
  referenceGuidanceMode?: string;
}

type QueueStatus = 'idle' | 'running' | 'paused';

const runningQueues = new Map<string, { abort: AbortController; status: QueueStatus }>();
const REMOTE_IMAGE_DOWNLOAD_FAILURE_MESSAGE = 'Remote image ready but local download failed; manual inspection required';
const REMOTE_IMAGE_EXECUTION_FAILURE_MESSAGE = 'Remote image task may still be running; manual inspection required';

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
  const { projectId, maxAttempts, timeoutMs } = options;
  let { concurrency } = options;

  // Guard: prevent duplicate start
  const existingStatus = getQueueStatus(projectId);
  if (existingStatus !== 'idle') {
    throw new Error(`Queue is already ${existingStatus} for project ${projectId}`);
  }

  const abort = new AbortController();
  runningQueues.set(projectId, { abort, status: 'running' });

  const db = getDb();
  const providerRow = db.prepare(`
    SELECT p.id, p.name, p.type, p.baseUrl
    FROM projects pr
    JOIN providers p ON p.id = pr.providerId
    WHERE pr.id = ?
  `).get(projectId) as { id?: string; name?: string; type?: string; baseUrl?: string } | undefined;
  const effectiveConcurrency = getEffectiveImageConcurrency(providerRow || {}, concurrency);
  concurrency = effectiveConcurrency;

  // Recover any stuck "running" jobs from a previous crash
  // Recover interrupted jobs conservatively: once a provider task or remote
  // result URL exists, retrying could submit a second paid task. Those jobs
  // require explicit inspection; only jobs with no remote identity may retry.
  db.prepare(
    `UPDATE jobs SET status = 'needs_check', errorMessage = 'Recovered remote image task; manual inspection required'
     WHERE projectId = ? AND status IN ('pending', 'retrying', 'running')
       AND (length(trim(COALESCE(providerTaskId, ''))) > 0
         OR length(trim(COALESCE(remoteImageUrl, ''))) > 0)`
  ).run(projectId);
  db.prepare(
    `UPDATE jobs SET status = 'retrying', errorMessage = 'Recovered from interrupted run'
     WHERE projectId = ? AND status = 'running'
       AND length(trim(COALESCE(providerTaskId, ''))) = 0
       AND length(trim(COALESCE(remoteImageUrl, ''))) = 0`
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

        await runJob(job, { timeoutMs, maxAttempts, abort: abort.signal, adapters: options.adapters, executionGate: options.executionGate });
      }
    }

    await Promise.allSettled(
      Array.from({ length: concurrency }, (_, i) => worker(i + 1))
    );

    if (!abort.signal.aborted) {
      const finalStatus = getEffectiveProjectFinalStatus(db, projectId);

      db.prepare(`UPDATE projects SET status = ? WHERE id = ?`).run(finalStatus, projectId);
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
  options: { timeoutMs: number; maxAttempts: number; abort: AbortSignal; adapters?: ImageQueueAdapterOverrides; executionGate?: Omit<AssertProviderExecutionAvailableOptions, 'capability'> }
): Promise<void> {
  const db = getDb();
  const { timeoutMs, maxAttempts, abort, adapters, executionGate } = options;

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
      usage?: string;
    } | undefined;

    if (!inputImage) {
      throw new Error('Input image not found');
    }

    const inputApiPath = inputImage.processedPath || inputImage.path;
    // MIME from processed file if available, otherwise original
    const inputMimeType = (inputImage.mimeType || 'image/png') as 'image/png' | 'image/jpeg' | 'image/webp';

    // Load reference images
    const refIds = safeParseReferenceImageIds(job.referenceImageIds, (msg) => logWarn(msg));
    const rawRefImages = refIds.length > 0
      ? db.prepare(
          `SELECT * FROM image_assets WHERE id IN (${refIds.map(() => '?').join(',')})`
        ).all(...refIds) as Array<{
        id: string;
        path: string;
        processedPath: string | null;
        mimeType: string;
      }>
      : [];

    const rawRefImageById = new Map(rawRefImages.map((image) => [image.id, image]));
    const orderedRefImages = refIds
      .map((refId) => rawRefImageById.get(refId))
      .filter((image): image is NonNullable<typeof image> => !!image);
    const refApiPaths = orderedRefImages.map((r) => r.processedPath || r.path);
    const refMimeTypes = orderedRefImages.map((r) => (r.mimeType || 'image/png') as 'image/png' | 'image/jpeg' | 'image/webp');

    // Load provider
    const provider = db
      .prepare(`SELECT * FROM providers WHERE id = ?`)
      .get(job.providerId) as {
      id: string;
      baseUrl: string;
      apiKeyEnv: string;
      apiKey: string;
      model: string;
      name: string;
      type: string;
      enabled: number;
      defaultCostPerImage?: number;
    } | undefined;

    if (!provider) {
      throw new Error('Provider not found');
    }

    const apiKey = (provider.apiKey || '').trim();
    const providerType = provider.type || 'openai-compatible';
    const managedExecution = isManagedDeployment(executionGate?.env ?? process.env);
    const imageProviderIdentity = {
      id: provider.id,
      type: providerType,
      apiKeyEnv: provider.apiKeyEnv,
      executionScope: managedExecution ? 'company' as const : 'external' as const,
      baseUrl: provider.baseUrl,
      enabled: provider.enabled === 1,
      configured: Boolean(apiKey && !isPlaceholderValue(apiKey) && provider.baseUrl && job.model),
      apiKey,
      model: provider.model,
      managedGeneration: managedExecution
        ? readManagedExecutionGeneration(executionGate?.root ?? dataRoot())
        : undefined,
    };
    const assertImageExecution = async () => {
      await assertProviderExecutionAvailable(imageProviderIdentity, {
        root: dataRoot(),
        ...executionGate,
        capability: 'model',
        kind: 'image',
      });
       if (!managedExecution) return;
      const current = db.prepare(`SELECT * FROM providers WHERE id = ?`).get(provider.id) as typeof provider | undefined;
      const currentApiKey = (current?.apiKey || '').trim();
      assertProviderExecutionIdentityStable(imageProviderIdentity, {
        id: current?.id || provider.id,
        type: current?.type || '',
        apiKeyEnv: current?.apiKeyEnv || '',
        executionScope: 'company',
        baseUrl: current?.baseUrl || '',
        enabled: current?.enabled === 1,
        configured: Boolean(currentApiKey && !isPlaceholderValue(currentApiKey) && current?.baseUrl && job.model),
         apiKey: currentApiKey,
         model: current?.model || '',
         managedGeneration: readManagedExecutionGeneration(executionGate?.root ?? dataRoot()),
       });
    };
    await assertImageExecution();
    if (isPlaceholderValue(apiKey)) {
      throw new Error('API key not configured. Please set it in Settings.');
    }

    logInfo(`Calling API: ${provider.baseUrl} (type=${providerType}, model=${job.model}, size=${job.size})`);
    const multipartImageField =
      providerType === 'openai-compatible' && provider.baseUrl.includes('api.gpt.ge')
        ? 'image'
        : providerType === 'openai-compatible'
          ? 'image[]'
          : 'image';
    logInfo(`图片发送顺序: adapter=${providerType}, multipart=${multipartImageField}, refs=${refApiPaths.length}`);
    logInfo(`  图1 底图: ${path.basename(inputApiPath)}`);
    for (let ri = 0; ri < refApiPaths.length; ri++) {
      logInfo(`  图${ri + 2} 参考: ${path.basename(refApiPaths[ri])}`);
    }

    // Create a per-request AbortController linked to the queue's abort signal
    const reqAbort = new AbortController();
    const onAbort = () => reqAbort.abort();
    abort.addEventListener('abort', onAbort, { once: true });

    // ── Route to correct adapter ──
    let result: { imageBuffer: Buffer; latencyMs: number; rawResponse?: unknown; remoteImageUrl?: string } | undefined;

    if (providerType === 'geekai-json') {
      // ── GeekAI async flow: submit → poll → download ──
      const geekaiStart = Date.now();

      // Step 1: Submit task
      logInfo('提交任务到 GeekAI...');
      await assertImageExecution();
      const submitResult = await (adapters?.submitGeekAITask ?? submitGeekAITask)(
        {
          model: job.model,
          prompt: job.prompt,
          inputImagePath: inputApiPath,
          inputMimeType,
          referenceImagePaths: refApiPaths,
          referenceMimeTypes: refMimeTypes,
          size: job.size,
          quality: job.quality,
          referenceGuidanceMode: (job.referenceGuidanceMode || 'preserve_subject') as 'preserve_subject' | 'none',
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
          const immediateUrl = submitResult.immediateImageUrl;
          if (!immediateUrl) throw new Error('GeekAI immediate response did not include an image');
          db.prepare(
            `UPDATE jobs SET providerStatus = 'succeeded', remoteImageUrl = ?, providerRawResponse = ? WHERE id = ?`
          ).run(immediateUrl, summarizeGeekAIResponse(submitResult.rawResponse), job.id);
          await assertImageExecution();
          try {
            const imgRes = await fetch(immediateUrl);
            if (!imgRes.ok) throw new Error(`HTTP ${imgRes.status}`);
            buf = Buffer.from(await imgRes.arrayBuffer());
          } catch {
            db.prepare(
              `UPDATE jobs SET status = 'needs_check', errorMessage = ?, providerStatus = 'download_failed', finishedAt = datetime('now')
               WHERE id = ? AND status = 'running'`
            ).run(REMOTE_IMAGE_DOWNLOAD_FAILURE_MESSAGE, job.id);
            return;
          }
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

          await assertImageExecution();
          const pollResult = await (adapters?.pollGeekAITask ?? pollGeekAITask)(
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
            logInfo(`远端生成成功，下载图片: ${redactMediaUrlForLog(pollResult.imageUrl, apiKey)}`);
            await assertImageExecution();
            const imgBuffer = await (adapters?.downloadGeekAIImage ?? downloadGeekAIImage)(pollResult.imageUrl);

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
              logError(REMOTE_IMAGE_DOWNLOAD_FAILURE_MESSAGE);
              db.prepare(
                `UPDATE jobs SET status = 'needs_check', errorMessage = ?, providerStatus = 'download_failed', remoteImageUrl = ?
                 WHERE id = ? AND status = 'running'`
              ).run(REMOTE_IMAGE_DOWNLOAD_FAILURE_MESSAGE, pollResult.imageUrl, job.id);
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
    } else if (providerType === 'gateway-task-image') {
      // ── 网关异步任务流（/v1/videos 协议）: submit → poll → download ──
      const gatewayStart = Date.now();

      logInfo('提交任务到网关（异步任务协议）...');
      await assertImageExecution();
      const submitResult = await (adapters?.submitGatewayTaskImage ?? submitGatewayTaskImage)(
        {
          model: job.model,
          prompt: job.prompt,
          inputImagePath: inputApiPath,
          inputMimeType,
          referenceImagePaths: refApiPaths,
          referenceMimeTypes: refMimeTypes,
          size: job.size,
          quality: job.quality,
          referenceGuidanceMode: (job.referenceGuidanceMode || 'preserve_subject') as 'preserve_subject' | 'none',
        },
        apiKey,
        provider.baseUrl
      );

      if (submitResult.immediateImageUrl) {
        const immediateUrl = submitResult.immediateImageUrl;
        db.prepare(
          `UPDATE jobs SET providerStatus = 'succeeded', remoteImageUrl = ?, providerRawResponse = ? WHERE id = ?`
        ).run(immediateUrl, summarizeGatewayTaskResponse(submitResult.rawResponse, apiKey), job.id);
        await assertImageExecution();
        const downloadResult = await (adapters?.downloadGatewayTaskImage ?? downloadGatewayTaskImage)(immediateUrl, provider.baseUrl, apiKey);
        if (!downloadResult.ok) {
          logError(REMOTE_IMAGE_DOWNLOAD_FAILURE_MESSAGE);
          db.prepare(
            `UPDATE jobs SET status = 'needs_check', errorMessage = ?, providerStatus = ?, remoteImageUrl = ?, finishedAt = datetime('now')
             WHERE id = ? AND status = 'running'`
          ).run(REMOTE_IMAGE_DOWNLOAD_FAILURE_MESSAGE, 'download_failed', immediateUrl, job.id);
          return;
        }
        result = {
          imageBuffer: downloadResult.buffer,
          latencyMs: Date.now() - gatewayStart,
          rawResponse: submitResult.rawResponse,
          remoteImageUrl: immediateUrl,
        };
        logInfo('网关任务同步返回结果');
      } else if (submitResult.taskId) {
        const taskId = submitResult.taskId;
        db.prepare(
          `UPDATE jobs SET providerTaskId = ?, providerStatus = 'submitted', providerRawResponse = ?, submittedAt = datetime('now')
           WHERE id = ?`
        ).run(taskId, safeJsonForDB(submitResult.rawResponse), job.id);
        logInfo(`任务已提交, task_id=${taskId} raw=${summarizeGatewayTaskResponse(submitResult.rawResponse, apiKey)}`);

        let polled = false;
        const maxPollMs = timeoutMs || 300_000;

        while (Date.now() - gatewayStart < maxPollMs) {
          if (reqAbort.signal.aborted) throw new DOMException('Aborted', 'AbortError');

          await assertImageExecution();
          const pollResult = await (adapters?.pollGatewayTaskImage ?? pollGatewayTaskImage)(
            taskId,
            apiKey,
            provider.baseUrl,
            gatewayStart,
            reqAbort.signal
          );

          const elapsedSec = Math.round((Date.now() - gatewayStart) / 1000);
          db.prepare(
            `UPDATE jobs SET providerStatus = ?, providerRawResponse = ?, lastPolledAt = datetime('now'), pollCount = pollCount + 1 WHERE id = ?`
          ).run(pollResult.status, safeJsonForDB(pollResult.rawResponse), job.id);
          logInfo(`轮询 task_id=${taskId} raw=${summarizeGatewayTaskResponse(pollResult.rawResponse, apiKey)} (${elapsedSec}s)`);

          if (pollResult.status === 'succeeded' && pollResult.imageUrl) {
            logInfo(`远端生成成功，下载图片: ${redactMediaUrlForLog(pollResult.imageUrl, apiKey)}`);
            await assertImageExecution();
            const downloadResult = await (adapters?.downloadGatewayTaskImage ?? downloadGatewayTaskImage)(pollResult.imageUrl, provider.baseUrl, apiKey);

            if (downloadResult.ok) {
              db.prepare(
                `UPDATE jobs SET providerStatus = 'succeeded', remoteImageUrl = ? WHERE id = ?`
              ).run(pollResult.imageUrl, job.id);
              result = {
                imageBuffer: downloadResult.buffer,
                latencyMs: Date.now() - gatewayStart,
                rawResponse: pollResult.rawResponse,
                remoteImageUrl: pollResult.imageUrl,
              };
              polled = true;
              break;
            } else {
              logError(REMOTE_IMAGE_DOWNLOAD_FAILURE_MESSAGE);
              db.prepare(
                `UPDATE jobs SET status = 'needs_check', errorMessage = ?, providerStatus = ?, remoteImageUrl = ?, finishedAt = datetime('now')
                 WHERE id = ? AND status = 'running'`
              ).run(REMOTE_IMAGE_DOWNLOAD_FAILURE_MESSAGE, 'download_failed', pollResult.imageUrl, job.id);
              return; // Don't retry — the money was already spent
            }
          }

          if (pollResult.status === 'failed') {
            throw new Error(`网关任务失败: ${pollResult.errorMessage || 'unknown'}`);
          }
        }

        if (!polled) {
          logWarn(`轮询超时，进入 needs_check (task_id=${taskId})`);
          db.prepare(
            `UPDATE jobs SET status = 'needs_check', errorMessage = ?, providerStatus = 'needs_check', finishedAt = datetime('now')
             WHERE id = ? AND status = 'running'`
          ).run(
            `轮询超时 (${Math.round((Date.now() - gatewayStart) / 1000)}s)。远端 task_id=${taskId} 可能仍在执行，请点"补抓结果"继续查询。`,
            job.id
          );
          return;
        }
      } else {
        throw new Error('网关未返回 task_id 或图片结果');
      }
    } else if (providerType === 'packy-images' || providerType === 'packy-gemini-image') {
      // Packy image routes are synchronous long-connections with no polling.
      logInfo(
        providerType === 'packy-gemini-image'
          ? 'Calling Packy Gemini Image API (chat completions, no polling)...'
          : 'Calling Packy Images API (multipart, no polling)...'
      );
      if (refApiPaths.length > 0) {
        logInfo(`Packy 参考图模式：${refApiPaths.length} 张参考图 + 1 张待处理图`);
      }
      logInfo('Packy 长连接请求已开始，等待服务端返回...');

      // Heartbeat: log every 15s while waiting for the long-connection response
      const stopHeartbeat = startPackyHeartbeat(logInfo);

      try {
        await assertImageExecution();
        const packyRequest =
          providerType === 'packy-gemini-image'
            ? (adapters?.editImagePackyGemini ?? editImagePackyGemini)(
                {
                  model: job.model,
                  prompt: job.prompt,
                  inputImagePath: inputApiPath,
                  inputMimeType,
                  referenceImagePaths: refApiPaths,
                  referenceMimeTypes: refMimeTypes,
                  size: job.size,
                },
                apiKey,
                provider.baseUrl,
                reqAbort.signal
              )
            : (adapters?.editImagePacky ?? (await import('./providers/packy-images.ts')).editImagePacky)(
                {
                  model: job.model,
                  prompt: job.prompt,
                  inputImagePath: inputApiPath,
                  inputMimeType,
                  referenceImagePaths: refApiPaths,
                  referenceMimeTypes: refMimeTypes,
                  size: job.size,
                  quality: job.quality || 'auto',
                  referenceGuidanceMode: 'none',
                },
                apiKey,
                provider.baseUrl,
                reqAbort.signal
              );
        const packyResult = await withTimeout(
          packyRequest,
          timeoutMs,
          reqAbort
        );
        logInfo(`Packy 已返回并下载图片，耗时 ${Math.round(packyResult.latencyMs / 1000)}s，开始保存本地输出`);
        result = {
          imageBuffer: packyResult.imageBuffer,
          latencyMs: packyResult.latencyMs,
          rawResponse: packyResult.rawResponse,
          remoteImageUrl: packyResult.remoteImageUrl,
        };
      } finally {
        stopHeartbeat();
      }
    } else {
      // Do not normalize or overwrite Packy baseUrl here.
      // Existing provider rows may contain the user-tested working URL.
      const providerName = provider.name || 'provider';
      const providerLabel = `${providerName} (openai-compatible)`;
      logInfo(`${providerLabel} 同步请求已开始，等待服务端返回...`);
      const stopHeartbeat = startRequestHeartbeat(`${providerLabel} 同步请求`, logInfo);
      try {
        await assertImageExecution();
        result = await withTimeout(
          (adapters?.editImageOpenAI ?? editImageOpenAI)(
            {
              provider: {
                id: provider.id,
                name: provider.name || '',
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
      } finally {
        stopHeartbeat();
      }
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
    const outputsDir = path.join(dataRoot(), 'storage', 'outputs');
    if (!fs.existsSync(outputsDir)) {
      fs.mkdirSync(outputsDir, { recursive: true });
    }

    // Output filename: use a meaningful prefix based on the input image's usage role
    const { filePrefix, outputUsage } = getUsagePrefix(inputImage.usage || '');

    const inputBase = sanitizeFilenameBase(inputImage.filename || inputImage.path);
    const revSuffix = (job.revision && job.revision > 0) ? `-r${job.revision}` : '';
    const preferredOutputName = `${filePrefix}${inputBase}${revSuffix}.png`;
    const outputFilename = ensureUniqueFilename(outputsDir, preferredOutputName, job.id.slice(0, 6));
    const outputPath = path.join(outputsDir, outputFilename);
    const normalizedImage = await normalizeGeneratedImageToSize(result.imageBuffer, job.size);
    if (normalizedImage.changed) {
      logWarn(`输出尺寸与任务尺寸不一致，已自动规整: ${normalizedImage.reason}`);
    }
    fs.writeFileSync(outputPath, normalizedImage.imageBuffer);

    // Save output image asset (tag with usage so tabs can filter)
    const outputImageId = uuidv4();
    db.prepare(
      `INSERT INTO image_assets (id, projectId, role, filename, path, mimeType, usage, width, height, createdAt)
       VALUES (?, ?, 'output', ?, ?, 'image/png', ?, ?, ?, datetime('now'))`
    ).run(outputImageId, job.projectId, outputFilename, outputPath, outputUsage, normalizedImage.width, normalizedImage.height);

    const finishedAt = new Date().toISOString();
    const estimatedCost = calculateEstimatedCost(provider.defaultCostPerImage, attempt - 1);

    // ── Atomic completion: only mark succeeded if still running ──
    const completeResult = db.prepare(
      `UPDATE jobs SET
        status = 'succeeded',
        finishedAt = ?,
        latencyMs = ?,
        estimatedCost = ?,
        outputImageId = ?,
        remoteImageUrl = COALESCE(?, remoteImageUrl),
        providerRawResponse = COALESCE(?, providerRawResponse)
       WHERE id = ? AND status = 'running'`
    ).run(finishedAt, result.latencyMs, estimatedCost, outputImageId, result.remoteImageUrl || null, result.rawResponse ? safeJsonForDB(result.rawResponse) : null, job.id);

    if (completeResult.changes === 1) {
      logInfo(`任务完成 (成本: ¥${estimatedCost.toFixed(4)})`);
      // Sync shot candidates even if a newer redo job already replaced latestJobId.
      const linkedShots = db.prepare(`
        SELECT s.id
        FROM shots s
        WHERE s.latestJobId = ?
        UNION
        SELECT s.id
        FROM shots s
        JOIN jobs latestJob ON latestJob.id = s.latestJobId
        WHERE latestJob.parentJobId = ?
      `).all(job.id, job.id) as Array<{ id: string }>;
      const insertCandidate = db.prepare(`
        INSERT OR IGNORE INTO shot_result_candidates (id, shotId, jobId, imageAssetId)
        VALUES (?, ?, ?, ?)
      `);
      for (const shot of linkedShots) {
        insertCandidate.run(`${shot.id}:${outputImageId}`, shot.id, job.id, outputImageId);
      }
      db.prepare(`UPDATE shots SET latestGeneratedImageId = ? WHERE latestJobId = ?`).run(outputImageId, job.id);
    } else {
      logWarn('Job was no longer running when trying to mark succeeded, discarding');
    }
  } catch (err: unknown) {
    let errorMessage = err instanceof Error ? err.message : String(err);

    // If aborted by user, mark as canceled — never retry
    if (err instanceof ProviderExecutionGateError) {
      const gateMessage = `[${err.code}] ${err.message}`;
      const submitted = db.prepare(`SELECT providerTaskId, remoteImageUrl FROM jobs WHERE id = ?`).get(job.id) as { providerTaskId: string | null; remoteImageUrl: string | null } | undefined;
      const hasRemoteIdentity = Boolean(
        submitted
        && ((typeof submitted.providerTaskId === 'string' && submitted.providerTaskId.trim().length > 0)
          || (typeof submitted.remoteImageUrl === 'string' && submitted.remoteImageUrl.trim().length > 0)),
      );
      if (hasRemoteIdentity) {
        // A remote task may still be running. Do not turn a mid-flight gate
        // failure into an ordinary retry that could submit a second task.
        db.prepare(`UPDATE jobs SET status = 'needs_check', providerStatus = ?, finishedAt = datetime('now'), errorMessage = ? WHERE id = ? AND status = 'running'`).run(err.code, gateMessage, job.id);
      } else {
        db.prepare(`UPDATE jobs SET status = 'failed', providerStatus = ?, finishedAt = datetime('now'), errorMessage = ? WHERE id = ? AND status = 'running'`).run(err.code, gateMessage, job.id);
      }
      logError(`Job blocked by provider execution gate: ${gateMessage}`);
      return;
    }

    if (abort.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
      errorMessage = 'Canceled by user';
      db.prepare(
        `UPDATE jobs SET status = 'canceled', errorMessage = ?
         WHERE id = ? AND status = 'running'`
      ).run(errorMessage, job.id);
      logWarn('Job canceled by user');
      return;
    }

    // Any non-cancellation error after a remote identity was persisted must
    // stop here. Retrying would submit a second paid task even when the
    // provider merely timed out or returned an ambiguous failure.
    const submitted = db.prepare(`SELECT providerTaskId, remoteImageUrl FROM jobs WHERE id = ?`).get(job.id) as { providerTaskId: string | null; remoteImageUrl: string | null } | undefined;
    const hasRemoteIdentity = Boolean(
      submitted
      && ((typeof submitted.providerTaskId === 'string' && submitted.providerTaskId.trim().length > 0)
        || (typeof submitted.remoteImageUrl === 'string' && submitted.remoteImageUrl.trim().length > 0)),
    );
    if (hasRemoteIdentity) {
      db.prepare(
        `UPDATE jobs SET status = 'needs_check', finishedAt = datetime('now'), errorMessage = ?
         WHERE id = ? AND status = 'running'`
      ).run(REMOTE_IMAGE_EXECUTION_FAILURE_MESSAGE, job.id);
      logError(REMOTE_IMAGE_EXECUTION_FAILURE_MESSAGE);
      return;
    }

    const pType = getProviderTypeForJob(job.id);

    if (pType === 'packy-images' || pType === 'packy-gemini-image') {
      // Packy timeout protection: synchronous long-connection timeouts may
      // still result in successful image generation on the server side.
      // Auto-retrying risks duplicate charges.
      if (isTimeoutLikeError(errorMessage)) {
        const msg = `${errorMessage}。Packy 是长连接同步返回，超时不代表远端一定未扣费；为避免重复扣费，已停止自动重试。请检查 Packy 控制台确认后手动重跑。`;
        db.prepare(
          `UPDATE jobs SET status = 'failed', finishedAt = datetime('now'), errorMessage = ?
           WHERE id = ? AND status = 'running'`
        ).run(msg, job.id);
        logError(msg);
        return;
      }

      if (isNonRetryablePackyError(errorMessage)) {
        const msg = `${errorMessage}。${getNonRetryablePackyAdvice(errorMessage)}`;
        db.prepare(
          `UPDATE jobs SET status = 'failed', finishedAt = datetime('now'), errorMessage = ?
           WHERE id = ? AND status = 'running'`
        ).run(msg, job.id);
        logError(msg);
        return;
      }
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

function startRequestHeartbeat(
  label: string,
  logInfo: (msg: string) => void,
  intervalMs = 10000
): () => void {
  const startedAt = Date.now();
  const timer: ReturnType<typeof setInterval> = setInterval(() => {
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    if (elapsed >= 60) {
      logInfo(`${label} 等待中，已等待 ${elapsed}s；如果长时间无响应，可能是代理、网络或上游长连接限制`);
    } else {
      logInfo(`${label} 等待中，已等待 ${elapsed}s`);
    }
  }, intervalMs);

  return () => clearInterval(timer);
}

function startPackyHeartbeat(logInfo: (msg: string) => void, intervalMs = 10000): () => void {
  return startRequestHeartbeat('Packy 长连接', logInfo, intervalMs);
}

function getProviderTypeForJob(jobId: string): string {
  try {
    const db = getDb();
    const row = db.prepare(
      `SELECT p.type FROM jobs j JOIN providers p ON p.id = j.providerId WHERE j.id = ?`
    ).get(jobId) as { type?: string } | undefined;
    return row?.type || '';
  } catch {
    return '';
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

function safeParseReferenceImageIds(value: string, logWarn?: (msg: string) => void): string[] {
  try {
    const parsed = JSON.parse(value || '[]');
    if (!Array.isArray(parsed)) {
      logWarn?.('referenceImageIds is not an array; continuing without reference images');
      return [];
    }
    return parsed.filter((id): id is string => typeof id === 'string' && id.length > 0);
  } catch {
    logWarn?.('referenceImageIds contains invalid JSON; continuing without reference images');
    return [];
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
