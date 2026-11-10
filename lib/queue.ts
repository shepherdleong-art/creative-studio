import { parseUsageSnapshot } from './usage-snapshot.ts';
import {
  isReassembledReworkJob,
  protectReassembledQueue,
  registerFilmReworkImageCandidate,
  REASSEMBLED_SUBMIT_UNCERTAIN,
} from './reassembled-shot-guard.ts';
import { calculateUsageCostMicros } from './usage-pricing.ts';
import { getDb } from './db.ts';
import { runWithAcceptedTaskAccess } from './team-service/accepted-access.ts';
import { registerManagedFile, requireAccessContext } from './media-core/access-context.ts';
import { editImageArk } from './providers/ark-images.ts';
import { editImage as editImageOpenAI } from './providers/openai-compatible.ts';
import { submitGeekAITask, pollGeekAITask, downloadGeekAIImage, summarizeGeekAIResponse } from './providers/geekai-json.ts';
import { submitGatewayTaskImage, pollGatewayTaskImage, downloadGatewayTaskImage, summarizeGatewayTaskResponse } from './providers/gateway-task-image.ts';
import { redactMediaUrlForLog, sanitizeGatewayMediaDiagnostic } from './gateway-media-url.ts';
import { describeGatewayDownloadFailure } from './media-download-policy.ts';
import { editImagePacky } from './providers/packy-images.ts';
import { editImagePackyGemini } from './providers/packy-gemini-image.ts';
import { getNonRetryablePackyAdvice, isNonRetryablePackyError, isTimeoutLikeError } from './packy-errors.ts';
import { getEffectiveImageConcurrency } from './provider-concurrency.ts';
import { runMediaQueueWorkers } from './media-queue-workers.ts';
import { calculateEstimatedCost } from './cost.ts';
import { normalizeGeneratedImageToSize, normalizeGeneratedImageToNativeRatio } from './image-output-normalize.ts';
import { companyImageCapsForModel, companyImageDeliverySize } from './company-gateway-size.ts';
import { isPlaceholderValue } from './video-auth.ts';
import { getEffectiveProjectFinalStatus } from './project-status.ts';
import { writeLog } from './logger.ts';
import { sanitizeFilenameBase, ensureUniqueFilename, getUsagePrefix } from './output-filenames.ts';
import { buildImageJobUsageSnapshot, persistImageJobUsageSnapshot, recordImageJobUsage } from './usage-async-jobs.ts';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { dataRoot } from './data-root.ts';
import fs from 'fs';
import {
  assertLegacyMediaProviderRecovery,
  cancelLegacyMediaNewStage,
  failLegacyMediaOperation,
  isLegacyMediaExecutionDeferred,
  isLegacyMediaPoolConfigurationError,
  isLegacyMediaProviderRecoveryBlocked,
  isLegacyMediaSubmissionUnknown,
  LegacyMediaNotCreatedError,
  LegacyMediaRemoteFailedError,
  LegacyMediaSubmissionUnknownError,
  isServerMediaExecution,
  legacyMediaExecutionRevision,
  recoverLegacyMediaSubmission,
  settleLegacyMediaRemote,
  captureLegacyMediaFailure,
  recoverLegacyMediaDownload,
  submitLegacyMediaOperation,
} from './legacy-media-execution.ts';
import type { ExecutionReceipt } from './media-core/execution/context.ts';
import {
  classifyImageSubmissionFailure,
  classifySubmissionOutcome,
  providerHttpError,
  submissionEmployeeCopy,
} from './media-core/submission-evidence.ts';
import {
  assertUnifiedImageSubmissionStillCurrent,
  handleUnifiedImageCapacityDeferral,
  handleUnifiedImageExplicitFailure,
  pauseUnifiedImageQueueWaits,
  prepareUnifiedImageExecution,
  resumeUnifiedImageQueueWaits,
  synchronizeUnifiedImageExecution,
  UnifiedImageCanceledError,
  UnifiedImageChannelUnavailableError,
  UnifiedImageExecutionError,
  UnifiedImageRecoveryPendingError,
  UnifiedImageStaleSubmissionError,
  UnifiedImageWaitingError,
  unifiedImageAttemptCostMinor,
  type PreparedUnifiedImageExecution,
} from './media-core/unified-media/execution.ts';
import {
  recordUnifiedChannelFailure,
  recordUnifiedChannelSuccess,
  releaseUnifiedChannelRecoveryProbe,
  unifiedChannelFailureReasonFromEvidence,
} from './media-core/unified-media/health.ts';
import { UNIFIED_IMAGE_MODEL_KEY } from './media-core/unified-media/catalog.ts';
import { applyUnifiedImageJobCancel } from './media-core/unified-media/cancel-intent.ts';

export interface QueueOptions {
  /** Limit a local rework run to its immutable job. */
  jobId?: string;
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
  errorMessage?: string | null;
  attempt: number;
  maxAttempts: number;
  revision?: number;
  referenceGuidanceMode?: string;
  usageSnapshotJson?: string | null;
  executionRevision?: number;
  providerTaskId?: string | null;
  providerStatus?: string | null;
  remoteImageUrl?: string | null;
  unifiedModel?: string | null;
  unifiedRuleVersion?: string | null;
  unifiedTaskId?: string | null;
  unifiedRequestJson?: string | null;
  cancelRequestedAt?: string | null;
}

type QueueStatus = 'idle' | 'running' | 'paused';

function noteUnifiedChannelFailure(
  db: ReturnType<typeof getDb>,
  execution: PreparedUnifiedImageExecution,
  input: {
    job: JobRecord;
    error: unknown;
    evidence?: ReturnType<typeof classifyImageSubmissionFailure>;
    stage: 'submit' | 'poll' | 'download';
  },
): void {
  const evidence = input.evidence ?? classifyImageSubmissionFailure({
    taskId: input.job.id,
    businessAttemptNo: Math.max(1, input.job.attempt),
    adapterId: execution.channel.definition.providerTable === 'providers'
      ? 'gateway-task-image'
      : 'openai-video',
    stage: input.stage,
    source: 'transport',
    error: input.error,
  });
  const reasonCode = unifiedChannelFailureReasonFromEvidence(evidence);
  if (!reasonCode) return;
  recordUnifiedChannelFailure(db, {
    unifiedModel: UNIFIED_IMAGE_MODEL_KEY,
    channelKey: execution.channel.channelKey,
    providerId: execution.channel.definition.providerId,
    reasonCode,
  });
}

interface RunningQueueEntry {
  abort: AbortController;
  status: QueueStatus;
  stopAfterCurrent?: boolean;
  done: Promise<void>;
  finish: () => void;
}

const runningQueues = new Map<string, RunningQueueEntry>();

export function getQueueStatus(projectId: string): QueueStatus {
  return runningQueues.get(projectId)?.status ?? 'idle';
}

export function pauseQueue(projectId: string) {
  const entry = runningQueues.get(projectId);
  if (entry) {
    entry.status = 'paused';
    if (isServerMediaExecution()) pauseUnifiedImageQueueWaits(getDb(), projectId);
  }
}

export function resumeQueue(projectId: string, options: QueueOptions) {
  const entry = runningQueues.get(projectId);
  if (entry) {
    if (isServerMediaExecution()) resumeUnifiedImageQueueWaits(getDb(), projectId);
    entry.status = 'running';
  } else {
    if (isServerMediaExecution()) resumeUnifiedImageQueueWaits(getDb(), projectId);
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
  const db = getDb();
  const activeJobs = db.prepare(`SELECT id, unifiedModel, status, providerTaskId FROM jobs
    WHERE projectId = ? AND status IN ('pending', 'retrying', 'running', 'deferred', 'needs_check')`)
    .all(projectId) as Array<{
      id: string; unifiedModel: string | null; status: string; providerTaskId: string | null;
    }>;
  const hasLegacyActive = activeJobs.some((job) => !job.unifiedModel);
  for (const job of activeJobs.filter((candidate) => candidate.unifiedModel)) {
    applyUnifiedImageJobCancel(db, job.id);
  }
  if (entry) {
    if (hasLegacyActive) entry.abort.abort();
    else entry.stopAfterCurrent = true;
    if (!isServerMediaExecution()) runningQueues.delete(projectId);
  }
  db.prepare(
    isServerMediaExecution()
      ? `UPDATE jobs SET status = 'canceled', errorMessage = 'Canceled by user'
         WHERE projectId = ? AND status IN ('pending', 'retrying', 'deferred')`
      : `UPDATE jobs SET status = 'canceled', errorMessage = 'Canceled by user'
         WHERE projectId = ? AND status IN ('pending', 'retrying', 'running')`
  ).run(projectId);
  if (isServerMediaExecution()) {
    db.prepare(`UPDATE execution_operations SET status = 'failed', waitReason = 'stage_canceled',
      waitDetail = NULL, updatedAt = ? WHERE module = 'image' AND status IN ('pending', 'deferred')
      AND taskId IN (SELECT id FROM jobs WHERE projectId = ? AND status = 'canceled')`)
      .run(new Date().toISOString(), projectId);
    if (!hasLegacyActive) {
      for (const job of activeJobs.filter((candidate) =>
        candidate.unifiedModel && candidate.providerTaskId
        && ['needs_check', 'deferred'].includes(candidate.status))) {
        void resumeImageJobPolling(job.id).catch(() => undefined);
      }
    }
  }
  db.prepare(`UPDATE projects SET status = 'canceled' WHERE id = ?`).run(projectId);
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
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  runningQueues.set(projectId, { abort, status: 'running', done, finish });

  const db = getDb();
  // A previous process may have exited while the project queue was paused.
  // Resume from the persisted remaining interval instead of charging restart
  // time to the capacity-wait threshold.
  if (isServerMediaExecution()) resumeUnifiedImageQueueWaits(db, projectId);
  const providerRow = db.prepare(`
    SELECT p.id, p.name, p.type, p.baseUrl
    FROM projects pr
    JOIN providers p ON p.id = pr.providerId
    WHERE pr.id = ?
  `).get(projectId) as { id?: string; name?: string; type?: string; baseUrl?: string } | undefined;
  const effectiveConcurrency = getEffectiveImageConcurrency(providerRow || {}, concurrency);
  concurrency = effectiveConcurrency;

  // Recover any stuck "running" jobs from a previous crash.
  protectReassembledQueue(db, projectId, 'generate_image', options.jobId);
  if (isServerMediaExecution()) {
    const interrupted = db.prepare(`
      SELECT id, providerTaskId, executionRevision FROM jobs
      WHERE projectId = ? AND status = 'running' AND (? IS NULL OR id = ?)
    `).all(projectId, options.jobId || null, options.jobId || null) as Array<{
      id: string; providerTaskId: string | null; executionRevision: number;
    }>;
    for (const row of interrupted) {
      const recovered = recoverLegacyMediaSubmission({
        module: 'image', taskId: row.id,
        inputRevision: legacyMediaExecutionRevision(row.executionRevision),
        providerTaskId: row.providerTaskId,
      });
      if (recovered.status === 'pending') {
        db.prepare("UPDATE jobs SET status = 'pending', errorMessage = NULL WHERE id = ? AND status = 'running'").run(row.id);
      } else {
        db.prepare(`UPDATE jobs SET status = 'needs_check', providerStatus = ?,
          providerTaskId = COALESCE(?, providerTaskId), remoteImageUrl = COALESCE(?, remoteImageUrl),
          errorMessage = '中断前的提交结果需要核查，未自动重发'
          WHERE id = ? AND status = 'running'`).run(
          recovered.resultRef ? 'download_failed' : 'unknown',
          recovered.remoteId ?? null,
          recovered.resultRef ?? null,
          row.id,
        );
      }
    }
  } else {
    db.prepare(
      `UPDATE jobs SET status = 'retrying', errorMessage = 'Recovered from interrupted run'
       WHERE projectId = ? AND status = 'running' AND (? IS NULL OR id = ?)`
    ).run(projectId, options.jobId || null, options.jobId || null);
  }

  try {
    db.prepare(`UPDATE projects SET status = 'running' WHERE id = ?`).run(projectId);

    // ── Worker pool: each worker independently claims and runs jobs ──
    // This prevents a single slow job from blocking the rest of the batch.
    async function worker() {
      while (!abort.signal.aborted) {
        const entry = runningQueues.get(projectId);
        if (entry?.stopAfterCurrent && !entry.abort.signal.aborted) break;
        if (entry?.status === 'paused') {
          await sleep(500);
          continue;
        }

        // Atomically claim next pending/retrying job
        const job = claimNextJob(projectId, options.jobId);
        if (!job) {
          if (isServerMediaExecution()) {
            const accepted = claimNeedsCheckImageJob(projectId, options.jobId);
            if (accepted) {
              await runJob(accepted, { timeoutMs, maxAttempts, abort: abort.signal });
              await sleep(1000);
              continue;
            }
          }
          const deferred = claimDeferredImageJob(projectId, options.jobId);
          if (deferred) {
            await runJob(deferred, { timeoutMs, maxAttempts, abort: abort.signal });
            await sleep(100);
            continue;
          }
          // No pending jobs. Check if any are still running.
          const runningCount = db
            .prepare(`SELECT COUNT(*) as count FROM jobs WHERE projectId = ? AND status IN ('running', 'deferred') AND (? IS NULL OR id = ?)`)
            .get(projectId, options.jobId || null, options.jobId || null) as { count: number };
          if (runningCount.count === 0) break;
          await sleep(500);
          continue;
        }

        await runJob(job, { timeoutMs, maxAttempts, abort: abort.signal });
      }
    }

    await runMediaQueueWorkers({
      db, module: 'image', projectId, jobId: options.jobId, concurrency,
      signal: abort.signal, worker,
    });

    if (!abort.signal.aborted) {
      const finalStatus = getEffectiveProjectFinalStatus(db, projectId);

      db.prepare(`UPDATE projects SET status = ? WHERE id = ?`).run(finalStatus, projectId);
    }
  } finally {
    finish();
    if (runningQueues.get(projectId)?.abort === abort) runningQueues.delete(projectId);
  }
}

export async function drainImageQueues(): Promise<number> {
  const entries = [...runningQueues.values()];
  for (const entry of entries) entry.abort.abort();
  await Promise.all(entries.map((entry) => entry.done));
  return entries.length;
}

/**
 * Run a single job with atomic claiming, abort support, and post-request validation.
 */
async function runJob(
  job: JobRecord,
  options: { timeoutMs: number; maxAttempts: number; abort: AbortSignal }
): Promise<void> {
  try {
    await runWithAcceptedTaskAccess(getDb(), 'image', job.id, () => runAuthorizedJob(job, options));
  } finally {
    if (job.unifiedModel) {
      try {
        synchronizeUnifiedImageExecution(getDb(), job.id);
      } catch (error) {
        console.error(`[Queue] 统一图片任务状态同步失败: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

export async function resumeImageJobPolling(jobId: string, timeoutMs = 300_000): Promise<void> {
  const db = getDb();
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as JobRecord | undefined;
  if (!job?.providerTaskId && !(job?.providerStatus === 'download_failed' && job.remoteImageUrl)) {
    throw new Error('No provider task ID or accepted image URL to resume');
  }
  const claimed = db.prepare(`
    UPDATE jobs SET status = 'running', errorMessage = NULL, finishedAt = NULL
    WHERE id = ? AND (
      status IN ('needs_check', 'pending')
      OR providerStatus = 'download_failed'
      OR (status = 'canceled' AND cancelRequestedAt IS NOT NULL
        AND COALESCE(providerStatus, '') NOT IN ('succeeded', 'failed', 'not_created'))
    )
  `).run(jobId);
  if (claimed.changes !== 1) throw new Error('Only accepted jobs waiting for polling or download can be resumed');
  await runJob(
    { ...job, status: 'running' },
    { timeoutMs, maxAttempts: Math.max(1, job.maxAttempts || 2), abort: new AbortController().signal },
  );
}

async function runAuthorizedJob(
  job: JobRecord,
  options: { timeoutMs: number; maxAttempts: number; abort: AbortSignal }
): Promise<void> {
  const db = getDb();
  const { timeoutMs, maxAttempts, abort } = options;

  if (abort.aborted) return;

  let unifiedExecution: PreparedUnifiedImageExecution | null = null;
  if (job.unifiedModel) {
    try {
      unifiedExecution = prepareUnifiedImageExecution(db, job.id);
      job.providerId = unifiedExecution.channel.provider.id;
      job.model = unifiedExecution.channel.definition.model;
      job.executionRevision = unifiedExecution.channel.executionRevision;
      job.unifiedTaskId = unifiedExecution.taskId;
    } catch (error) {
      if (error instanceof UnifiedImageRecoveryPendingError) {
        writeLog({
          jobId: job.id,
          projectId: job.projectId,
          level: 'warn',
          message: error.message,
          attempt: job.attempt,
        });
        return;
      }
      if (error instanceof UnifiedImageWaitingError) {
        const channelKey = typeof error.waitDetail?.channelKey === 'string'
          ? error.waitDetail.channelKey
          : '';
        const channelLabel = channelKey === 'tencent' ? '腾讯' : '七牛';
        db.prepare(`UPDATE jobs SET status = 'deferred', errorMessage = ?,
          startedAt = NULL, finishedAt = NULL
          WHERE id = ? AND status IN ('running', 'pending', 'retrying', 'deferred')`)
          .run(
            `${channelLabel}云端名额已满，等待可用资源，尚未提交。`,
            job.id,
          );
        return;
      }
      if (error instanceof UnifiedImageCanceledError) {
        db.prepare(`UPDATE jobs SET status = 'canceled', errorMessage = 'Canceled by user',
          finishedAt = COALESCE(finishedAt, datetime('now'))
          WHERE id = ? AND status IN ('pending', 'retrying', 'running', 'deferred')`).run(job.id);
        return;
      }
      if (error instanceof UnifiedImageExecutionError) {
        db.prepare(`UPDATE jobs SET status = 'failed', finishedAt = datetime('now'), errorMessage = ?
          WHERE id = ? AND status IN ('pending', 'retrying', 'running', 'deferred')`).run(error.message, job.id);
        writeLog({ jobId: job.id, projectId: job.projectId, level: 'error', message: error.message, attempt: job.attempt });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      db.prepare(`UPDATE jobs SET status = 'failed', finishedAt = datetime('now'), errorMessage = ?
        WHERE id = ? AND status IN ('pending', 'retrying', 'running', 'deferred')`).run(message, job.id);
      writeLog({ jobId: job.id, projectId: job.projectId, level: 'error', message, attempt: job.attempt });
      return;
    }
  }

  // Job was already claimed atomically by the worker pool.
  // attempt and startedAt were set during claimNextJob().
  let attempt = job.attempt;
  const startedAt = new Date().toISOString();

  // Preparation is not a provider call. Only publish these details after admission.
  let admitted = !isServerMediaExecution() || Boolean(job.providerTaskId || job.remoteImageUrl);
  const preparedLogs: string[] = [];
  const logInfo = (msg: string) => {
    if (!admitted) { preparedLogs.push(msg); return; }
    writeLog({ jobId: job.id, projectId: job.projectId, level: 'info', message: msg, attempt });
  };
  const logError = (msg: string) =>
    writeLog({ jobId: job.id, projectId: job.projectId, level: 'error', message: msg, attempt });
  const logWarn = (msg: string) =>
    writeLog({ jobId: job.id, projectId: job.projectId, level: 'warn', message: msg, attempt });

  if (admitted) logInfo(`图片任务开始（第 ${attempt} 次调用）`);
  let cleanupRequestAbort: (() => void) | undefined;

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
      defaultCostPerImage?: number;
    } | undefined;

    if (!provider) {
      throw new Error('Provider not found');
    }

    const apiKey = (provider.apiKey || '').trim();
    if (isPlaceholderValue(apiKey)) {
      throw new Error('API key not configured. Please set it in Settings.');
    }

    const providerType = provider.type || 'openai-compatible';

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

    const providerSnapshot = {
      providerId: provider.id, providerName: provider.name, type: providerType, model: job.model, baseUrl: provider.baseUrl,
      ...(unifiedExecution ? { unifiedModel: job.unifiedModel } : {}),
    };
    assertLegacyMediaProviderRecovery({
      module: 'image', taskId: job.id,
      inputRevision: legacyMediaExecutionRevision(job.executionRevision),
      providerSnapshot, credentialIdentity: apiKey,
    });

    // Create a per-request AbortController linked to the queue's abort signal
    const reqAbort = new AbortController();
    const onAbort = () => reqAbort.abort();
    abort.addEventListener('abort', onAbort, { once: true });
    cleanupRequestAbort = () => abort.removeEventListener('abort', onAbort);

    // ── Route to correct adapter ──
    let result: { imageBuffer: Buffer; latencyMs: number; rawResponse?: unknown; remoteImageUrl?: string } | undefined;
    let usageSnapshot: string | null = null;

    async function executeImageSubmission<T>(
      send: () => Promise<T>,
      receipt: (value: T) => ExecutionReceipt,
    ): Promise<T> {
      if (!isServerMediaExecution()) return send();
      if (unifiedExecution) {
        const canceled = db.prepare('SELECT cancelRequestedAt FROM jobs WHERE id = ?').pluck().get(job.id) as string | null;
        if (canceled) {
          await cancelLegacyMediaNewStage({
            module: 'image', taskId: job.id,
            inputRevision: legacyMediaExecutionRevision(job.executionRevision),
          });
          throw new UnifiedImageCanceledError();
        }
      }
      if (!usageSnapshot) {
        usageSnapshot = unifiedExecution
          ? buildImageJobUsageSnapshot(db, {
            jobId: job.id,
            projectId: job.projectId,
            requestModel: job.model,
            provider: { id: provider!.id, name: provider!.name, type: provider!.type, model: provider!.model },
            refType: 'channel_attempt',
            refId: `${job.id}:${unifiedExecution.channel.channelKey}:r${job.executionRevision}`,
            startedAt,
          })
          : persistImageJobUsageSnapshot(db, {
            jobId: job.id,
            projectId: job.projectId,
            requestModel: job.model,
            provider: { id: provider!.id, name: provider!.name, type: provider!.type, model: provider!.model },
            refType: 'job',
            refId: job.id,
            startedAt,
          });
      }
      const parsed = parseUsageSnapshot(usageSnapshot);
      const reserveMinor = parsed.ok
        ? Math.ceil(calculateUsageCostMicros(parsed.parsed.snapshot.priceComponents, 1) / 10_000)
        : typeof provider!.defaultCostPerImage === 'number' && Number.isFinite(provider!.defaultCostPerImage)
          ? Math.ceil(provider!.defaultCostPerImage * 100)
          : null;
      const inputRevision = legacyMediaExecutionRevision(job.executionRevision);
      const submitted = await submitLegacyMediaOperation<T>({
        module: 'image',
        taskId: job.id,
        projectId: job.projectId,
        inputRevision,
        inputSnapshot: {
          inputImageId: job.inputImageId,
          referenceImageIds: refIds,
          model: job.model,
          prompt: job.prompt,
          size: job.size,
          quality: job.quality,
          referenceGuidanceMode: job.referenceGuidanceMode || 'preserve_subject',
        },
        requestSnapshot: { providerType, model: job.model, size: job.size, quality: job.quality },
        providerSnapshot,
        baseUrl: provider!.baseUrl,
        apiKey,
        quote: reserveMinor === null
          ? { kind: 'unpriced' }
          : { kind: 'priced', reserve: { currency: 'CNY', minor: reserveMinor }, pricingSnapshot: usageSnapshot },
        mediaTaskId: unifiedExecution?.taskId ?? null,
        channelKey: unifiedExecution?.channel.channelKey ?? null,
        signal: reqAbort.signal,
        beforeSend: unifiedExecution
          ? () => assertUnifiedImageSubmissionStillCurrent(db, {
            jobId: job.id,
            mediaTaskId: unifiedExecution!.taskId,
            channelKey: unifiedExecution!.channel.channelKey,
            executionRevision: unifiedExecution!.channel.executionRevision,
          })
          : undefined,
        onAdmitted() {
          attempt += 1;
          job.attempt = attempt;
          db.prepare('UPDATE jobs SET attempt = ?, startedAt = datetime(\'now\') WHERE id = ? AND status = \'running\'')
            .run(attempt, job.id);
        },
        send: async () => {
          admitted = true;
          logInfo(`图片任务已取得运行名额，开始第 ${attempt} 次调用`);
          for (const message of preparedLogs) logInfo(message);
          preparedLogs.length = 0;
          const value = await send();
          return { value, receipt: receipt(value) };
        },
      });
      if (submitted.resumed || submitted.value === undefined) {
        throw new Error(`已受理图片任务 ${submitted.remoteId ?? ''} 需要续查，不能重新提交。`);
      }
      return submitted.value;
    }

    async function settleImageExecution(
      outcome: 'succeeded' | 'failed',
      resultRef?: string,
      errorCode?: string,
    ): Promise<void> {
      const parsed = parseUsageSnapshot(usageSnapshot);
      const reserveMinor = parsed.ok
        ? Math.ceil(calculateUsageCostMicros(parsed.parsed.snapshot.priceComponents, 1) / 10_000)
        : typeof provider!.defaultCostPerImage === 'number' && Number.isFinite(provider!.defaultCostPerImage)
          ? Math.ceil(provider!.defaultCostPerImage * 100)
          : null;
      await settleLegacyMediaRemote({
        module: 'image',
        taskId: job.id,
        inputRevision: legacyMediaExecutionRevision(job.executionRevision),
        outcome,
        actualCost: outcome === 'succeeded' && reserveMinor !== null
          ? { currency: 'CNY', minor: reserveMinor }
          : null,
        resultRef,
        errorCode,
        errorStage: outcome === 'failed' ? 'remote_poll' : undefined,
      });
    }

    async function failRemoteImageTask(message: string): Promise<void> {
      const failureMessage = sanitizeErrorMessage(sanitizeGatewayMediaDiagnostic(message, apiKey));
      // A remote terminal failure is final even if execution bookkeeping fails.
      // Persist it before settlement so the catch/recovery path cannot requeue it.
      db.prepare(`UPDATE jobs SET status = 'failed', providerStatus = 'failed',
        errorMessage = ?, finishedAt = datetime('now') WHERE id = ? AND status = 'running'`)
        .run(failureMessage, job.id);
      logError(failureMessage);
      let settled = false;
      try {
        await settleImageExecution('failed', undefined, 'provider_failed');
        settled = true;
      } catch (error) {
        logWarn(`远端任务已失败并停止，执行记录同步失败: ${sanitizeErrorMessage(sanitizeGatewayMediaDiagnostic(error instanceof Error ? error.message : String(error), apiKey))}`);
      }
      if (!unifiedExecution || !settled) return;
      try {
        const operation = db.prepare(`SELECT id, currentAttemptId FROM execution_operations
          WHERE mediaTaskId = ? AND channelKey = ?`).get(
          unifiedExecution.taskId, unifiedExecution.channel.channelKey,
        ) as { id: string; currentAttemptId: string | null } | undefined;
        const attempt = operation?.currentAttemptId
          ? db.prepare(`SELECT id, businessAttemptNo, remoteId FROM execution_attempts WHERE id = ?`)
            .get(operation.currentAttemptId) as {
              id: string; businessAttemptNo: number; remoteId: string | null;
            } | undefined
          : undefined;
        const evidence = classifySubmissionOutcome({
          entry: 'image',
          taskId: job.id,
          businessAttemptNo: attempt?.businessAttemptNo ?? Math.max(1, job.attempt),
          adapterId: providerType,
          stage: 'poll',
          source: 'provider',
          outcome: 'terminal_failed',
          remoteId: attempt?.remoteId ?? job.providerTaskId ?? null,
          errorCode: 'provider_failed',
        });
        const decision = handleUnifiedImageExplicitFailure(db, job.id, {
          evidence,
          attemptId: attempt?.id,
          operationId: operation?.id,
          channelKey: unifiedExecution.channel.channelKey,
        });
        if (decision.outcome === 'next_channel') {
          logWarn(`Image 2 ${decision.previousChannelKey} 通道明确失败，转入 ${decision.nextChannelKey}。`);
        }
      } catch (error) {
        logError(`显式失败后的备用通道决策失败，任务保持失败且不会重试: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (job.providerStatus === 'download_failed' && job.remoteImageUrl) {
      try {
        let imageBuffer: Buffer;
        if (providerType === 'gateway-task-image') {
          const downloaded = await downloadGatewayTaskImage(job.remoteImageUrl, provider.baseUrl, apiKey);
          if (!downloaded.ok) throw new Error('网关图片补下载失败');
          imageBuffer = downloaded.buffer;
        } else {
          const response = await fetch(job.remoteImageUrl, { signal: reqAbort.signal });
          if (!response.ok) throw new Error(`图片下载失败（HTTP ${response.status}）`);
          imageBuffer = Buffer.from(await response.arrayBuffer());
        }
        result = {
          imageBuffer,
          latencyMs: 0,
          remoteImageUrl: job.remoteImageUrl,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await captureLegacyMediaFailure({ module: 'image', taskId: job.id, inputRevision: legacyMediaExecutionRevision(job.executionRevision), stage: 'download', errorCode: 'result_download_failed' });
        db.prepare(`UPDATE jobs SET status = 'needs_check', providerStatus = 'download_failed', errorMessage = ?
          WHERE id = ? AND status = 'running'`).run(message, job.id);
        return;
      }
    } else if (providerType === 'geekai-json') {
      // ── GeekAI async flow: submit → poll → download ──
      const geekaiStart = Date.now();

      // Step 1: Submit task；已有远端 ID 时只续查。
      const existingTaskId = job.providerTaskId?.trim() || null;
      logInfo(existingTaskId ? `续查 GeekAI 任务 ${existingTaskId}` : '提交任务到 GeekAI...');
      const submitResult = existingTaskId ? null : await executeImageSubmission(
        () => submitGeekAITask(
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
        ),
        (value) => value.immediateImageUrl || value.immediateImageBase64
          ? { terminalState: 'succeeded', resultRef: value.immediateImageUrl }
          : { remoteId: value.taskId },
      );

      // Handle sync response (immediate result, no taskId)
      if (submitResult && (submitResult.immediateImageUrl || submitResult.immediateImageBase64)) {
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
      } else if (submitResult?.taskId || existingTaskId) {
        // Step 2: Save taskId and raw response, start polling
        const taskId = (submitResult?.taskId || existingTaskId)!;
        if (submitResult) {
          db.prepare(
            `UPDATE jobs SET providerTaskId = ?, providerStatus = 'submitted', providerRawResponse = ?, submittedAt = datetime('now')
             WHERE id = ?`
          ).run(taskId, safeJsonForDB(submitResult.rawResponse), job.id);
          logInfo(`任务已提交, task_id=${taskId} raw=${summarizeGeekAIResponse(submitResult.rawResponse)}`);
        }

        // Step 3: Poll with graduated intervals
        let polled = false;
        const maxPollMs = timeoutMs || 300_000; // default 5 minutes, no forced minimum

        while (Date.now() - geekaiStart < maxPollMs) {
          if (reqAbort.signal.aborted) throw new DOMException('Aborted', 'AbortError');

          let pollResult;
          try {
            pollResult = await pollGeekAITask(
              taskId,
              apiKey,
              provider.baseUrl,
              geekaiStart,
              reqAbort.signal
            );
          } catch (error) {
            if (reqAbort.signal.aborted) throw error;
            await captureLegacyMediaFailure({
              module: 'image', taskId: job.id,
              inputRevision: legacyMediaExecutionRevision(job.executionRevision),
              stage: 'remote_poll', errorCode: 'provider_poll_failed',
            });
            throw error;
          }

          const elapsedSec = Math.round((Date.now() - geekaiStart) / 1000);
          db.prepare(
            `UPDATE jobs SET providerStatus = ?, providerRawResponse = ?, lastPolledAt = datetime('now'), pollCount = pollCount + 1 WHERE id = ?`
          ).run(pollResult.status, safeJsonForDB(pollResult.rawResponse), job.id);
          logInfo(`轮询 task_id=${taskId} raw=${summarizeGeekAIResponse(pollResult.rawResponse)} (${elapsedSec}s)`);

          if (pollResult.status === 'succeeded' && pollResult.imageUrl) {
            await settleImageExecution('succeeded', pollResult.imageUrl);
            // Step 4: Download image（独立阶段）
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
              await captureLegacyMediaFailure({ module: 'image', taskId: job.id, inputRevision: legacyMediaExecutionRevision(job.executionRevision), stage: 'download', errorCode: 'result_download_failed' });
              db.prepare(
                `UPDATE jobs SET status = 'failed', errorMessage = ?, providerStatus = 'download_failed', remoteImageUrl = ?
                 WHERE id = ? AND status = 'running'`
              ).run(
                submissionEmployeeCopy('terminal_succeeded', 'download_failed').detail,
                pollResult.imageUrl,
                job.id,
              );
              return; // Don't retry — the money was already spent
            }
          }

          if (pollResult.status === 'failed') {
            await failRemoteImageTask(`GeekAI task failed: ${pollResult.errorMessage || 'unknown'}`);
            return;
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

      // A claimed/retried job may already have been submitted before a crash or
      // timeout. Never create another billable remote task; hand it to the
      // explicit resume-poll flow instead.
      let existingTaskId: string | null = null;
      let taskLookupFailed = false;
      try {
        const existingTask = db.prepare(`SELECT providerTaskId FROM jobs WHERE id = ?`).get(job.id) as
          { providerTaskId?: unknown } | undefined;
        if (typeof existingTask?.providerTaskId === 'string' && existingTask.providerTaskId.trim()) {
          existingTaskId = existingTask.providerTaskId.trim();
        }
      } catch {
        // Fail closed if the task identity cannot be read: submitting would be
        // unsafe because the remote request may already exist.
        taskLookupFailed = true;
      }

      const enterImageResumeCheck = (resumeMessage: string) => {
        logWarn(resumeMessage);
        try {
          db.prepare(
            `UPDATE jobs SET status = 'needs_check', errorMessage = ?, providerStatus = 'needs_check', finishedAt = datetime('now')
             WHERE id = ? AND status = 'running'`
          ).run(resumeMessage, job.id);
        } catch (stateError) {
          logError(`无法记录 needs_check 状态: ${stateError instanceof Error ? stateError.message : String(stateError)}`);
        }
      };

      if (taskLookupFailed) {
        enterImageResumeCheck('无法确认远端图片任务身份，已暂停提交，请点“补抓结果”重试。');
        return;
      }
      if (existingTaskId && !isServerMediaExecution()) {
        enterImageResumeCheck(`已有远端图片任务 ${existingTaskId}，请点“补抓结果”继续查询。`);
        return;
      }

      if (!existingTaskId && !unifiedExecution) {
        usageSnapshot = persistImageJobUsageSnapshot(db, {
          jobId: job.id,
          projectId: job.projectId,
          requestModel: job.model,
          provider: {
            id: provider.id,
            name: provider.name,
            type: provider.type,
            model: provider.model,
          },
          refType: 'job',
          refId: job.id,
          startedAt,
        });
        if (!usageSnapshot) {
          // Snapshot persistence deliberately remains fail-open when the usage
          // schema is unavailable. Re-read the remote identity, however, so a
          // providerTaskId created between the preflight SELECT and the guarded
          // snapshot UPDATE can never lead to a duplicate submit.
          try {
            const racedTask = db.prepare(`SELECT providerTaskId FROM jobs WHERE id = ?`).get(job.id) as
              { providerTaskId?: unknown } | undefined;
            const racedTaskId = typeof racedTask?.providerTaskId === 'string'
              ? racedTask.providerTaskId.trim()
              : '';
            if (racedTaskId) {
              enterImageResumeCheck(`已有远端图片任务 ${racedTaskId}，请点“补抓结果”继续查询。`);
              return;
            }
          } catch {
            enterImageResumeCheck('无法确认远端图片任务身份，已暂停提交，请点“补抓结果”重试。');
            return;
          }
        }
      }
      logInfo(existingTaskId ? `续查网关图片任务 ${existingTaskId}` : '提交图片生成请求到网关...');
      const submitResult = existingTaskId ? null : await executeImageSubmission(
        () => submitGatewayTaskImage(
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
          provider.baseUrl,
          { onProgress: logInfo, timeoutMs, signal: reqAbort.signal },
        ),
        (value) => value.immediateImageUrl
          ? { terminalState: 'succeeded', resultRef: value.immediateImageUrl, remoteId: value.taskId }
          : { remoteId: value.taskId },
      );
      if (submitResult?.imageTransports?.length) {
        logInfo(`图片传输方式: ${submitResult.imageTransports.map((t, i) => `图${i + 1}=${t}`).join(', ')}`);
      }

      if (submitResult?.immediateImageUrl) {
        const downloadResult = await downloadGatewayTaskImage(submitResult.immediateImageUrl, provider.baseUrl, apiKey);
        if (!downloadResult.ok) {
          const failure = describeGatewayDownloadFailure('image', submitResult.immediateImageUrl, downloadResult, apiKey);
          logError(`${failure.errorMessage} URL: ${failure.logUrl}`);
          db.prepare(
            `UPDATE jobs SET status = ?, errorMessage = ?, providerStatus = ?, remoteImageUrl = ?, finishedAt = datetime('now')
             WHERE id = ? AND status = 'running'`
          ).run(
            failure.status,
            submissionEmployeeCopy('terminal_succeeded', 'download_failed').detail,
            failure.providerStatus,
            submitResult.immediateImageUrl,
            job.id,
          );
          return;
        }
        result = {
          imageBuffer: downloadResult.buffer,
          latencyMs: Date.now() - gatewayStart,
          rawResponse: submitResult.rawResponse,
          remoteImageUrl: submitResult.immediateImageUrl,
        };
        logInfo('网关任务同步返回结果');
      } else if (submitResult?.taskId || existingTaskId) {
        const taskId = (submitResult?.taskId || existingTaskId)!;
        if (submitResult) {
          db.prepare(
            `UPDATE jobs SET providerTaskId = ?, providerStatus = 'submitted', providerRawResponse = ?, submittedAt = datetime('now')
             WHERE id = ?`
          ).run(taskId, safeJsonForDB(submitResult.rawResponse), job.id);
          logInfo(`任务已提交, task_id=${taskId} raw=${summarizeGatewayTaskResponse(submitResult.rawResponse, apiKey)}`);
        }

        let polled = false;
        const maxPollMs = timeoutMs || 300_000;

        while (Date.now() - gatewayStart < maxPollMs) {
          if (reqAbort.signal.aborted) throw new DOMException('Aborted', 'AbortError');

          let pollResult;
          try {
            pollResult = await pollGatewayTaskImage(
              taskId,
              apiKey,
              provider.baseUrl,
              gatewayStart,
              reqAbort.signal
            );
          } catch (error) {
            if (reqAbort.signal.aborted) throw error;
            await captureLegacyMediaFailure({
              module: 'image', taskId: job.id,
              inputRevision: legacyMediaExecutionRevision(job.executionRevision),
              stage: 'remote_poll', errorCode: 'provider_poll_failed',
            });
            throw error;
          }

          const elapsedSec = Math.round((Date.now() - gatewayStart) / 1000);
          db.prepare(
            `UPDATE jobs SET providerStatus = ?, providerRawResponse = ?, lastPolledAt = datetime('now'), pollCount = pollCount + 1 WHERE id = ?`
          ).run(pollResult.status, safeJsonForDB(pollResult.rawResponse), job.id);
          logInfo(`轮询 task_id=${taskId} raw=${summarizeGatewayTaskResponse(pollResult.rawResponse, apiKey)} (${elapsedSec}s)`);
          if (unifiedExecution && pollResult.status === 'unknown' && pollResult.httpStatus) {
            noteUnifiedChannelFailure(db, unifiedExecution, {
              job,
              error: providerHttpError(pollResult.httpStatus),
              stage: 'poll',
            });
          }

          if (pollResult.status === 'succeeded' && pollResult.imageUrl) {
            await settleImageExecution('succeeded', pollResult.imageUrl);
            logInfo(`远端生成成功，下载图片: ${redactMediaUrlForLog(pollResult.imageUrl, apiKey)}`);
            const downloadResult = await downloadGatewayTaskImage(pollResult.imageUrl, provider.baseUrl, apiKey);

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
              const failure = describeGatewayDownloadFailure('image', pollResult.imageUrl, downloadResult, apiKey);
              logError(`${failure.errorMessage} URL: ${failure.logUrl}`);
              db.prepare(
                `UPDATE jobs SET status = ?, errorMessage = ?, providerStatus = ?, remoteImageUrl = ?, finishedAt = datetime('now')
                 WHERE id = ? AND status = 'running'`
              ).run(
                failure.status,
                submissionEmployeeCopy('terminal_succeeded', 'download_failed').detail,
                failure.providerStatus,
                pollResult.imageUrl,
                job.id,
              );
              return; // Don't retry — the money was already spent
            }
          }

          if (pollResult.status === 'failed') {
            await failRemoteImageTask(`网关任务失败: ${pollResult.errorMessage || 'unknown'}`);
            return;
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
        const packyRequest = () =>
          providerType === 'packy-gemini-image'
            ? editImagePackyGemini(
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
                reqAbort.signal,
                { deferDownload: isServerMediaExecution() }
              )
            : editImagePacky(
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
                reqAbort.signal,
                { deferDownload: isServerMediaExecution() }
              );
        const packyResult = await executeImageSubmission(
          () => withTimeout(packyRequest(), timeoutMs, reqAbort),
          (value) => ({ terminalState: 'succeeded', resultRef: value.remoteImageUrl }),
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
      const providerLabel = `${providerName} (${providerType})`;
      const editImage = providerType === 'ark-images' ? editImageArk : editImageOpenAI;
      logInfo(`${providerLabel} 同步请求已开始，等待服务端返回...`);
      const stopHeartbeat = startRequestHeartbeat(`${providerLabel} 同步请求`, logInfo);
      try {
        result = await executeImageSubmission(
          () => withTimeout(
            editImage(
            {
              provider: {
                id: provider.id,
                name: provider.name || '',
                baseUrl: provider.baseUrl,
                apiKeyEnv: provider.apiKeyEnv,
                model: provider.model,
                type: providerType === 'ark-images' ? 'ark-images' : 'openai-compatible',
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
            reqAbort.signal,
            { deferDownload: isServerMediaExecution() }
          ),
          timeoutMs,
          reqAbort
          ),
          (value) => ({ terminalState: 'succeeded', resultRef: value.remoteImageUrl }),
        );
      } finally {
        stopHeartbeat();
      }
    }

    // Clean up the abort listener
    abort.removeEventListener('abort', onAbort);

    // If GeekAI branch returned early (download_failed / needs_check), skip the rest
    if (!result) return;

    if (unifiedExecution) {
      recordUnifiedChannelSuccess(db, {
        unifiedModel: UNIFIED_IMAGE_MODEL_KEY,
        channelKey: unifiedExecution.channel.channelKey,
        providerId: unifiedExecution.channel.definition.providerId,
      });
    }

    if (isServerMediaExecution() && result.remoteImageUrl && result.imageBuffer.byteLength === 0) {
      try {
        const response = await fetch(result.remoteImageUrl, { signal: reqAbort.signal });
        if (!response.ok) throw new Error(`图片下载失败（HTTP ${response.status}）`);
        result.imageBuffer = Buffer.from(await response.arrayBuffer());
      } catch {
        const message = submissionEmployeeCopy('terminal_succeeded', 'download_failed').detail;
        await captureLegacyMediaFailure({ module: 'image', taskId: job.id, inputRevision: legacyMediaExecutionRevision(job.executionRevision), stage: 'download', errorCode: 'result_download_failed' });
        db.prepare(`UPDATE jobs SET status = 'needs_check', providerStatus = 'download_failed',
          remoteImageUrl = ?, errorMessage = ?, finishedAt = datetime('now') WHERE id = ? AND status = 'running'`)
          .run(result.remoteImageUrl, message, job.id);
        return;
      }
    }

    logInfo(`API call succeeded (latency: ${result.latencyMs}ms)`);

    // ── Post-request check: is the job still allowed to settle this result? ──
    // A unified task canceled after an accepted POST keeps running until the
    // late result is downloaded. The result belongs to the task record but
    // must not advance the active shot or create downstream candidates.
    const currentJob = db.prepare(`SELECT status, cancelRequestedAt FROM jobs WHERE id = ?`)
      .get(job.id) as { status: string; cancelRequestedAt: string | null } | undefined;
    const canceledLateResult = Boolean(job.unifiedModel && currentJob?.cancelRequestedAt);

    if (!currentJob || (currentJob.status !== 'running'
      && !(canceledLateResult && currentJob.status === 'canceled'))) {
      logWarn(`Job state changed to "${currentJob?.status}" during API call, discarding result`);
      return;
    }

    if (abort.aborted && !isServerMediaExecution()) {
      logWarn('Queue aborted, discarding result');
      // Mark as canceled since the queue was aborted
      db.prepare(`UPDATE jobs SET status = 'canceled', errorMessage = 'Queue canceled' WHERE id = ? AND status = 'running'`).run(job.id);
      return;
    }

    try {
    // Save output image
    const outputsDir = path.join(dataRoot(), 'storage', 'outputs');
    if (!fs.existsSync(outputsDir)) {
      fs.mkdirSync(outputsDir, { recursive: true });
    }

    // Output filename: use a meaningful prefix based on the input image's usage role
    const { filePrefix, outputUsage } = getUsagePrefix(inputImage.usage || '');

    const inputBase = sanitizeFilenameBase(inputImage.filename || inputImage.path);
    const revSuffix = (job.revision && job.revision > 0) ? `-r${job.revision}` : '';
    // 逐格实测可原生交付的公司模型（nativeDelivery，qiniuyun/* 与 image2）：只按
    // 名义格比例居中裁切、绝不缩放——同比例原样交付网关原生像素（image2 常返回
    // 比名义格更大的图，白赚像素），比例略偏的裁齐（1K 3:4 实返 1024x1376 →
    // 1024x1366）；排除格 donor 图裁回名义格比例（2160x3840 → 2160x2880）。
    // 其余模型维持规整到 job.size。
    const jobCompanyCaps = companyImageCapsForModel(job.model);
    const normalizedImage = jobCompanyCaps?.nativeDelivery
      ? await normalizeGeneratedImageToNativeRatio(result.imageBuffer, companyImageDeliverySize(job.size, jobCompanyCaps))
      : await normalizeGeneratedImageToSize(result.imageBuffer, job.size);
    if (normalizedImage.changed) {
      logWarn(`输出尺寸与任务尺寸不一致，已自动规整: ${normalizedImage.reason}`);
    }
    // 原生交付原样保留网关字节，落盘扩展名与落库 MIME 必须按产物真实格式
    //（qiniuyun 请求 png、image2 仍为 jpeg），不能一律写 .png。
    const outputExt = normalizedImage.format === 'jpeg' ? '.jpg' : normalizedImage.format === 'webp' ? '.webp' : '.png';
    const outputMimeType = outputExt === '.jpg' ? 'image/jpeg' : outputExt === '.webp' ? 'image/webp' : 'image/png';
    const outputFilename = ensureUniqueFilename(outputsDir, `${filePrefix}${inputBase}${revSuffix}${outputExt}`, job.id.slice(0, 6));
    const outputPath = path.join(outputsDir, outputFilename);
    fs.writeFileSync(outputPath, normalizedImage.imageBuffer);

    // Save output image asset (tag with usage so tabs can filter)
    const outputImageId = uuidv4();
    const access = requireAccessContext();
    const publishOutput = db.transaction(() => {
      db.prepare(
        `INSERT INTO image_assets (id, projectId, role, filename, path, mimeType, usage, width, height, createdAt)
         VALUES (?, ?, 'output', ?, ?, ?, ?, ?, ?, datetime('now'))`
      ).run(outputImageId, job.projectId, outputFilename, outputPath, outputMimeType, outputUsage, normalizedImage.width, normalizedImage.height);
      access.registerInheritedScope({
        resourceType: 'image', resourceId: outputImageId,
        parent: { resourceType: 'project', resourceId: job.projectId },
      });
      if (access.kind === 'team') {
        registerManagedFile({
          absolutePath: outputPath,
          mimeType: outputMimeType,
          references: [
            { resourceType: 'image', resourceId: outputImageId, role: 'output' },
            { resourceType: 'job', resourceId: job.id, role: 'output' },
          ],
        });
      }
    });
    publishOutput.immediate();

    const finishedAt = new Date().toISOString();
    const frozenPrice = parseUsageSnapshot(usageSnapshot);
    const estimatedCost = unifiedExecution
      ? unifiedImageAttemptCostMinor(db, job.id) / 100
      : frozenPrice.ok
        ? calculateUsageCostMicros(frozenPrice.parsed.snapshot.priceComponents, attempt) / 1_000_000
        : calculateEstimatedCost(provider.defaultCostPerImage, attempt - 1);

    // ── Atomic completion: only mark succeeded if still running ──
    const lateCanceled = Boolean(
      job.unifiedModel
      && db.prepare('SELECT cancelRequestedAt FROM jobs WHERE id = ?').pluck().get(job.id),
    );
    const completeResult = db.prepare(
      `UPDATE jobs SET
        status = ?,
        providerStatus = 'succeeded',
        finishedAt = ?,
        latencyMs = ?,
        estimatedCost = ?,
        outputImageId = ?,
        usageSnapshotJson = COALESCE(?, usageSnapshotJson),
        remoteImageUrl = COALESCE(?, remoteImageUrl),
        errorMessage = ?,
        providerRawResponse = COALESCE(?, providerRawResponse)
       WHERE id = ? AND status IN ('running', 'canceled')`
    ).run(
      lateCanceled ? 'canceled' : 'succeeded',
      finishedAt, result.latencyMs, estimatedCost, outputImageId,
      unifiedExecution ? usageSnapshot : null,
      result.remoteImageUrl || null,
      lateCanceled
        ? '已停止后续生成；晚到的结果已保存到任务记录，可查看或手动使用。'
        : job.errorMessage ?? null,
      result.rawResponse ? safeJsonForDB(result.rawResponse) : null,
      job.id,
    );

    if (completeResult.changes === 1) {
      const usageResult = recordImageJobUsage(db, {
        jobId: job.id,
        projectId: job.projectId,
        attempt: unifiedExecution ? 1 : attempt,
        snapshot: usageSnapshot,
        finishedAt,
      });
      if (!usageResult.ok) {
        logWarn(`实时 usage 记账失败，将由 reconciler 补记 (${usageResult.reason ?? 'unknown'})`);
      }
      logInfo(`任务完成 (成本: ¥${estimatedCost.toFixed(4)})`);
      await recoverLegacyMediaDownload({ module: 'image', taskId: job.id, inputRevision: legacyMediaExecutionRevision(job.executionRevision) });
      if (lateCanceled) {
        logWarn('任务已停止后续生成；晚到结果已保存，未自动更新分镜或候选。');
        return;
      }
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
      if (isReassembledReworkJob(db, job.id, 'generate_image')) {
        // Rework candidates attach to the frozen original shot without changing
        // the shot's current image; adoption remains an explicit workbench action.
        registerFilmReworkImageCandidate(db, job.id, outputImageId);
      }
      for (const shot of linkedShots) {
        insertCandidate.run(`${shot.id}:${outputImageId}`, shot.id, job.id, outputImageId);
      }
      db.prepare(`UPDATE shots SET latestGeneratedImageId = ? WHERE latestJobId = ?`).run(outputImageId, job.id);
    } else {
      logWarn('Job was no longer running when trying to mark succeeded, discarding');
    }
    } catch (error) {
      if (!abort.aborted) {
        await captureLegacyMediaFailure({
          module: 'image', taskId: job.id, inputRevision: legacyMediaExecutionRevision(job.executionRevision),
          stage: 'storage', errorCode: 'output_storage_failed',
        });
      }
      throw error;
    }
  } catch (err: unknown) {
    let errorMessage = err instanceof Error ? err.message : String(err);

    if (unifiedExecution && !abort.aborted
      && !(err instanceof LegacyMediaNotCreatedError)
      && !(err instanceof LegacyMediaRemoteFailedError)) {
      const submitted = db.prepare('SELECT providerTaskId FROM jobs WHERE id = ?').get(job.id) as
        { providerTaskId: string | null } | undefined;
      const evidence = err instanceof LegacyMediaSubmissionUnknownError ? err.evidence : undefined;
      noteUnifiedChannelFailure(db, unifiedExecution, {
        job,
        error: err,
        evidence,
        stage: submitted?.providerTaskId ? 'poll' : 'submit',
      });
    }

    if (unifiedExecution
      && (err instanceof LegacyMediaNotCreatedError || err instanceof LegacyMediaRemoteFailedError)) {
      try {
        const decision = handleUnifiedImageExplicitFailure(db, job.id, {
          evidence: err.evidence,
          attemptId: err.attemptId,
          operationId: err.operationId,
          channelKey: err.channelKey,
        });
        if (decision.outcome === 'next_channel') {
          logWarn(`Image 2 ${decision.previousChannelKey} 通道明确失败，转入 ${decision.nextChannelKey}。`);
        } else if (decision.outcome === 'exhausted') {
          logError(`Image 2 没有剩余备用通道，任务已最终失败${decision.reason ? `（${decision.reason}）` : ''}。`);
        }
      } catch (error) {
        db.prepare(`UPDATE jobs SET status = 'failed', finishedAt = datetime('now'), errorMessage = ?
          WHERE id = ? AND status IN ('running', 'failed', 'needs_check')`).run(
          error instanceof Error ? error.message : String(error),
          job.id,
        );
        logError(`显式失败后的备用通道决策失败，任务保持失败且不会重试。`);
      }
      return;
    }

    if (err instanceof UnifiedImageCanceledError) {
      const at = new Date().toISOString();
      if (unifiedExecution) {
        releaseUnifiedChannelRecoveryProbe(db, {
          unifiedModel: UNIFIED_IMAGE_MODEL_KEY,
          channelKey: unifiedExecution.channel.channelKey,
          providerId: unifiedExecution.channel.definition.providerId,
        });
      }
      db.prepare(`UPDATE jobs SET status = 'canceled', errorMessage = 'Canceled by user',
        finishedAt = COALESCE(finishedAt, datetime('now')) WHERE id = ? AND status IN ('pending', 'retrying', 'running', 'deferred')`)
        .run(job.id);
      if (job.unifiedTaskId) {
        db.prepare(`UPDATE execution_media_tasks
          SET status = 'canceled', currentChannelKey = NULL,
            cancelRequestedAt = COALESCE(cancelRequestedAt, ?), resultJson = ?, updatedAt = ?
          WHERE id = ?`).run(at, JSON.stringify({ errorCode: 'canceled', reason: 'cancel_before_send' }), at, job.unifiedTaskId);
        db.prepare(`UPDATE execution_media_channels
          SET state = 'canceled', updatedAt = ?
          WHERE mediaTaskId = ? AND state IN ('selected', 'waiting_capacity')`)
          .run(at, job.unifiedTaskId);
        db.prepare(`UPDATE execution_operations
          SET status = 'failed', waitReason = 'stage_canceled', waitDetail = NULL, updatedAt = ?
          WHERE mediaTaskId = ? AND status IN ('pending', 'deferred', 'admitted')`)
          .run(at, job.unifiedTaskId);
      }
      logWarn('统一图片任务已记录取消意图，停止新提交');
      return;
    }

    if (err instanceof UnifiedImageStaleSubmissionError) {
      if (unifiedExecution) {
        releaseUnifiedChannelRecoveryProbe(db, {
          unifiedModel: UNIFIED_IMAGE_MODEL_KEY,
          channelKey: unifiedExecution.channel.channelKey,
          providerId: unifiedExecution.channel.definition.providerId,
        });
      }
      const current = db.prepare('SELECT status FROM jobs WHERE id = ?').pluck().get(job.id) as string | undefined;
      if (current === 'running') {
        db.prepare(`UPDATE jobs SET status = 'needs_check', providerStatus = 'unknown',
          errorMessage = '统一图片任务已切换通道或被取消，本轮未发送请求，请核查。',
          finishedAt = datetime('now') WHERE id = ? AND status = 'running'`).run(job.id);
      }
      logWarn('统一图片提交前复核发现当前通道已变化，本轮未发送请求');
      return;
    }

    if (err instanceof UnifiedImageChannelUnavailableError) {
      db.prepare(`UPDATE jobs SET status = 'failed', errorMessage = ?, finishedAt = datetime('now')
        WHERE id = ? AND status = 'running'`).run(errorMessage, job.id);
      logError(errorMessage);
      return;
    }

    if (err instanceof UnifiedImageExecutionError) {
      db.prepare(`UPDATE jobs SET status = 'failed', finishedAt = datetime('now'), errorMessage = ?
        WHERE id = ? AND status IN ('pending', 'retrying', 'running', 'deferred')`).run(errorMessage, job.id);
      logError(errorMessage);
      return;
    }

    if (isServerMediaExecution() && abort.aborted) {
      const current = db.prepare('SELECT providerTaskId, executionRevision, cancelRequestedAt FROM jobs WHERE id = ?')
        .get(job.id) as { providerTaskId: string | null; executionRevision: number; cancelRequestedAt: string | null } | undefined;
      const recovered = recoverLegacyMediaSubmission({
        module: 'image', taskId: job.id,
        inputRevision: legacyMediaExecutionRevision(current?.executionRevision),
        providerTaskId: current?.providerTaskId,
      });
      if (recovered.status === 'needs_check') {
        db.prepare(`UPDATE jobs SET status = 'needs_check', providerStatus = ?,
          providerTaskId = COALESCE(?, providerTaskId), remoteImageUrl = COALESCE(?, remoteImageUrl),
          errorMessage = ?
          WHERE id = ? AND status = 'running'`).run(
          recovered.resultRef ? 'download_failed' : 'unknown',
          recovered.remoteId ?? null,
          recovered.resultRef ?? null,
          current?.cancelRequestedAt
            ? '已停止后续生成；已提交任务仍在收尾，晚到结果会保留在任务记录。'
            : '已受理任务保留，等待续查或补下载',
          job.id,
        );
      } else {
        await cancelLegacyMediaNewStage({
          module: 'image', taskId: job.id,
          inputRevision: legacyMediaExecutionRevision(current?.executionRevision),
        });
        db.prepare("UPDATE jobs SET status = 'canceled', errorMessage = 'Canceled by user' WHERE id = ? AND status = 'running'").run(job.id);
      }
      return;
    }

    // local 保留原有取消合同。
    if (abort.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
      errorMessage = 'Canceled by user';
      db.prepare(
        `UPDATE jobs SET status = 'canceled', errorMessage = ?
         WHERE id = ? AND status = 'running'`
      ).run(errorMessage, job.id);
      logWarn('Job canceled by user');
      return;
    }

    if (isServerMediaExecution() && isLegacyMediaExecutionDeferred(err)) {
      if (unifiedExecution) {
        releaseUnifiedChannelRecoveryProbe(db, {
          unifiedModel: UNIFIED_IMAGE_MODEL_KEY,
          channelKey: unifiedExecution.channel.channelKey,
          providerId: unifiedExecution.channel.definition.providerId,
        });
        const decision = handleUnifiedImageCapacityDeferral(db, job.id, new Date());
        if (decision.outcome === 'waiting') {
          logWarn(
            decision.channelKey === 'qiniu'
              ? `Image 2 七牛名额已满，等待可用资源至 ${decision.nextEligibleAt}。`
              : 'Image 2 腾讯名额已满，等待可用资源，尚未提交。',
          );
          return;
        }
        if (decision.outcome === 'overflowed') {
          logWarn(
            `Image 2 七牛名额持续已满，已满足 ${decision.thresholdSec} 秒阈值，转入腾讯通道。`,
          );
          return;
        }
        if (decision.outcome === 'canceled') {
          db.prepare(`UPDATE jobs SET status = 'canceled', errorMessage = 'Canceled by user',
            finishedAt = COALESCE(finishedAt, datetime('now'))
            WHERE id = ? AND status IN ('running', 'pending', 'retrying', 'deferred')`)
            .run(job.id);
          return;
        }
        if (decision.outcome === 'not_capacity') {
          const copy: Record<string, string> = {
            monthly_budget: '本月费用额度不足，尚未提交；额度调整后会自动继续。',
            cost_unknown: '上一笔费用仍待核查，暂不能开始新的付费生成。',
            pricing_required: '缺少可信价格，等待管理员补齐后再提交。',
            personal_concurrency: '个人运行名额已满，尚未提交；名额释放后会自动继续。',
            fair_share: '正在与其他成员公平共享名额，尚未提交；释放后按顺序继续。',
          };
          db.prepare(`UPDATE jobs SET status = 'deferred', errorMessage = ?
            WHERE id = ? AND status IN ('running', 'pending', 'retrying', 'deferred')`)
            .run(copy[decision.reason] ?? '等待统一执行准入，尚未提交。', job.id);
          return;
        }
      }
      db.prepare(`UPDATE jobs SET status = 'deferred', errorMessage = ? WHERE id = ? AND status = 'running'`)
        .run(errorMessage, job.id);
      if (job.errorMessage !== errorMessage) {
        logWarn('图片任务等待运行名额或额度，尚未发送请求；具体原因见团队任务。');
      }
      return;
    }

    if (isServerMediaExecution() && isLegacyMediaPoolConfigurationError(err)) {
      db.prepare(`UPDATE jobs SET status = 'failed', finishedAt = datetime('now'), errorMessage = ?
        WHERE id = ? AND status = 'running'`).run(errorMessage, job.id);
      logError('图片供应商池缺失或映射未核验，已在提交前拒绝');
      return;
    }

    if (isServerMediaExecution() && (isLegacyMediaSubmissionUnknown(err) || isLegacyMediaProviderRecoveryBlocked(err))) {
      db.prepare(`UPDATE jobs SET status = 'needs_check', providerStatus = 'unknown', errorMessage = ?, finishedAt = datetime('now')
        WHERE id = ? AND status = 'running'`).run(`${errorMessage}。提交结果未知，已禁止自动重发。`, job.id);
      logError('图片提交结果未知，进入 needs_check，禁止自动重发');
      return;
    }

    if (isServerMediaExecution()) {
      const submitted = db.prepare('SELECT providerTaskId FROM jobs WHERE id = ?').get(job.id) as { providerTaskId: string | null } | undefined;
      if (submitted?.providerTaskId?.trim()) {
        db.prepare(`UPDATE jobs SET status = 'needs_check', providerStatus = 'needs_check', errorMessage = ?, finishedAt = datetime('now')
          WHERE id = ? AND status = 'running'`).run(
          submissionEmployeeCopy('unknown', 'remote_query_failed').detail,
          job.id,
        );
        logError('图片轮询异常，保留远端任务并进入续查，不重新提交');
        return;
      }
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
        failLegacyMediaOperation({
          module: 'image', taskId: job.id, inputRevision: legacyMediaExecutionRevision(job.executionRevision),
        });
        db.prepare(
          `UPDATE jobs SET status = 'failed', finishedAt = datetime('now'), errorMessage = ?
           WHERE id = ? AND status = 'running'`
        ).run(msg, job.id);
        logError(msg);
        return;
      }
    }

    errorMessage = sanitizeErrorMessage(errorMessage);

    if (!job.unifiedModel && isReassembledReworkJob(db, job.id, 'generate_image')) {
      const remote = db.prepare('SELECT providerTaskId FROM jobs WHERE id=?').get(job.id) as { providerTaskId: string | null };
      db.prepare(`UPDATE jobs SET status=?, finishedAt=datetime('now'), errorMessage=? WHERE id=? AND status='running'`)
        .run(remote.providerTaskId?.trim() ? 'needs_check' : 'failed', `${errorMessage}。${remote.providerTaskId?.trim() ? '已有远端任务，请补抓结果，不会重新提交。' : REASSEMBLED_SUBMIT_UNCERTAIN}`, job.id);
      return;
    }

    logError(`Job failed: ${errorMessage}`);

    const effectiveMaxAttempts = job.unifiedModel ? 1 : (job.maxAttempts || maxAttempts || 2);

    if (job.unifiedModel || attempt >= effectiveMaxAttempts) {
      failLegacyMediaOperation({
        module: 'image', taskId: job.id, inputRevision: legacyMediaExecutionRevision(job.executionRevision),
      });
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
  } finally {
    cleanupRequestAbort?.();
  }
}

function claimNeedsCheckImageJob(projectId: string, jobId?: string): JobRecord | null {
  const db = getDb();
  const job = db.prepare(`
    SELECT * FROM jobs
    WHERE projectId = ?
      AND (
        status = 'needs_check'
        ${isServerMediaExecution() ? "OR providerStatus = 'download_failed' OR (status = 'canceled' AND cancelRequestedAt IS NOT NULL AND COALESCE(providerStatus, '') NOT IN ('succeeded', 'failed', 'not_created'))" : ''}
      )
      AND (providerTaskId IS NOT NULL OR (providerStatus = 'download_failed' AND remoteImageUrl IS NOT NULL))
      AND (? IS NULL OR id = ?)
      ${isServerMediaExecution() ? "AND (jobs.unifiedModel IS NOT NULL OR NOT EXISTS (SELECT 1 FROM final_edit_film_reworks r WHERE r.jobId = jobs.id AND r.kind = 'generate_image'))" : ''}
    ORDER BY createdAt, rowid LIMIT 1
  `).get(projectId, jobId || null, jobId || null) as JobRecord | undefined;
  if (!job) return null;
  const claimed = db.prepare(`UPDATE jobs SET status = 'running', errorMessage = NULL
    WHERE id = ? AND (
      status = 'needs_check'
      ${isServerMediaExecution() ? "OR providerStatus = 'download_failed' OR (status = 'canceled' AND cancelRequestedAt IS NOT NULL AND COALESCE(providerStatus, '') NOT IN ('succeeded', 'failed', 'not_created'))" : ''}
    )`)
    .run(job.id);
  return claimed.changes === 1 ? { ...job, status: 'running' } : null;
}

function claimDeferredImageJob(projectId: string, jobId?: string): JobRecord | null {
  const db = getDb();
  const job = db.prepare(`
    SELECT jobs.* FROM jobs
    LEFT JOIN execution_operations AS deferred_operation
      ON deferred_operation.module = 'image' AND deferred_operation.taskId = jobs.id
      AND deferred_operation.operationKey = 'image/' || jobs.id || '/submit/r' || COALESCE(jobs.executionRevision, 0)
    LEFT JOIN execution_media_tasks AS unified_wait
      ON unified_wait.module = 'image' AND unified_wait.taskId = jobs.id
    WHERE jobs.projectId = ? AND jobs.status = 'deferred' AND (? IS NULL OR jobs.id = ?)
      AND (deferred_operation.updatedAt IS NULL OR julianday(deferred_operation.updatedAt) <= julianday('now', '-1 second'))
      AND (
        jobs.unifiedModel IS NULL
        OR unified_wait.id IS NULL
        OR unified_wait.nextEligibleAt IS NULL
        OR julianday(unified_wait.nextEligibleAt) <= julianday('now')
      )
    ORDER BY COALESCE(deferred_operation.updatedAt, jobs.createdAt), jobs.createdAt, jobs.rowid LIMIT 1
  `).get(projectId, jobId || null, jobId || null) as JobRecord | undefined;
  if (!job) return null;
  const claimed = db.prepare(`UPDATE jobs SET status = 'running'
    WHERE id = ? AND status = 'deferred'`).run(job.id);
  return claimed.changes === 1 ? { ...job, status: 'running' } : null;
}

/**
 * Atomically claim the next pending/retrying job.
 * Returns the claimed job with attempt incremented, or null if none available.
 */
function claimNextJob(projectId: string, jobId?: string): (JobRecord & { attempt: number }) | null {
  const db = getDb();
  protectReassembledQueue(db, projectId, 'generate_image', jobId, false);
  const job = db.prepare(`
    SELECT * FROM jobs
    WHERE projectId = ? AND status IN ('pending', 'retrying') AND (? IS NULL OR id = ?)
      ${isServerMediaExecution() ? "AND (jobs.unifiedModel IS NOT NULL OR NOT EXISTS (SELECT 1 FROM final_edit_film_reworks r WHERE r.jobId = jobs.id AND r.kind = 'generate_image'))" : ''}
    ORDER BY id LIMIT 1
  `).get(projectId, jobId || null, jobId || null) as JobRecord | undefined;

  if (!job) return null;

  const nextAttempt = isServerMediaExecution() ? job.attempt : job.attempt + 1;
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
