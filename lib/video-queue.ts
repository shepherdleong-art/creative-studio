import { getDb } from './db.ts';
import { getVideoAdapter } from './video-providers/index.ts';
import { redactMediaUrlForLog } from './gateway-media-url.ts';
import { describeGatewayDownloadFailure, downloadVideoMediaForProvider } from './media-download-policy.ts';
import { resolveVideoProviderRuntimeConfig } from './video-auth.ts';
import { writeLog } from './logger.ts';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import { dataRoot } from './data-root.ts';
import { resolveVideoPollingTimeoutMs } from './video-polling-policy.ts';
import { validateVideoTailFrameAsset } from './video-tail-frame.ts';
import { videoMultiShotFromStorage } from './video-multi-shot.ts';
import type { SubmitVideoRequest } from './video-providers/types.ts';
import { persistVideoJobUsageSnapshot, recordVideoJobUsage } from './usage-async-jobs.ts';

export interface VideoQueueOptions {
  projectId: string;
  concurrency: number;
  timeoutMs: number;
}

// Number of video jobs to run concurrently per project. Override with the
// VIDEO_CONCURRENCY env var; clamped to 1–10.
const raw = process.env.VIDEO_CONCURRENCY;
const envConcurrency = (raw !== undefined && raw !== '') ? Number(raw) : NaN;
export const DEFAULT_VIDEO_CONCURRENCY = Math.max(1, Math.min(10, Number.isFinite(envConcurrency) ? envConcurrency : 10));

// 轮询窗口:供应商任务积压时单次轮询可等待多久,超时后任务转 needs_check。
// 默认 15 分钟(旧值 5 分钟在任务积压时频繁掉出自动化管线);用
// VIDEO_TIMEOUT_MS 覆盖,钳制在 1 分钟到 24 小时之间。
const rawTimeout = process.env.VIDEO_TIMEOUT_MS;
const envTimeout = (rawTimeout !== undefined && rawTimeout !== '') ? Number(rawTimeout) : NaN;
export const DEFAULT_VIDEO_TIMEOUT_MS = Number.isFinite(envTimeout) && envTimeout > 0
  ? Math.max(60_000, Math.min(24 * 3_600_000, Math.floor(envTimeout)))
  : 15 * 60_000;

// 视频任务的运行时重试上限。video_jobs.maxAttempts 默认 1(存量库旧行也是 1),
// 这里在失败分支做兜底,与图片队列 `job.maxAttempts || maxAttempts || 2` 同款写法;
// 新建库的建表默认值同步改为 2(见 lib/db.ts),让两处口径一致。
export const DEFAULT_VIDEO_MAX_ATTEMPTS = 2;

type VideoFrameMime = 'image/png' | 'image/jpeg' | 'image/webp';

/**
 * 按实际发给供应商的文件路径推 mime——image_assets.mimeType 记录的是预处理
 * 副本的格式，与原图可能不同（如 PNG 原图 → JPEG 副本），给错 mime 会让
 * 按文件组 data URL 的适配器（jimeng）产出坏请求。
 */
function videoFrameMimeFromPath(imagePath: string, fallback: string | null | undefined): VideoFrameMime {
  const ext = path.extname(imagePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return fallback === 'image/png' || fallback === 'image/jpeg' || fallback === 'image/webp'
    ? fallback
    : 'image/png';
}

// 每供应商并发闸门:同时处于 running 的本地任务数上限,按供应商类型配置、
// 按 providerId(具体供应商行)跨项目统计——队列按项目隔离,但远端并发是
// 供应商维度的,多项目并行时闸门依然生效。未列出的供应商类型不限速。
// 当前无内置限速:原 kling=2 是针对可灵官方直连账号的保守默认值,未经实测;
// 经公司网关(openai-video)的调用本就不命中此闸门。需要限速时在此按类型加回。
const VIDEO_PROVIDER_CONCURRENCY_LIMITS: Readonly<Record<string, number>> = {};

export function providerConcurrencyLimit(providerType: string): number | null {
  return VIDEO_PROVIDER_CONCURRENCY_LIMITS[providerType] ?? null;
}

// ── 提交限流退避 ──
// 网关限流(429)或过载(5xx)时,提交失败的任务打回 pending 会被 worker 立刻
// 重新领走、反复撞墙。这里按 providerId 记一段冷却期,冷却内 claim 视同被
// 闸门挡住(gated),让重试自然错开。内存状态即可:进程重启只是提前结束冷却,
// 任务不丢(pending 持久化在库里)。
const RATE_LIMIT_SUBMIT_PATTERN = /submit error (429|5\d\d)\b/i;
/** 逐级退避的冷却时长;测试可直接 splice 缩短。 */
export const RATE_LIMIT_COOLDOWN_MS = [30_000, 60_000, 120_000];
/** 同一任务的限流重排上限(不消耗 maxAttempts),超过则标失败。 */
export const RATE_LIMIT_MAX_REQUEUES = 5;

const providerCooldownUntil = new Map<string, number>();
const providerCooldownStreak = new Map<string, number>();
const jobRateLimitRequeues = new Map<string, number>();

export function isRateLimitedSubmitError(message: string): boolean {
  return RATE_LIMIT_SUBMIT_PATTERN.test(message);
}

function noteRateLimitCooldown(providerId: string): void {
  const streak = (providerCooldownStreak.get(providerId) ?? 0) + 1;
  providerCooldownStreak.set(providerId, streak);
  const delay = RATE_LIMIT_COOLDOWN_MS[Math.min(streak - 1, RATE_LIMIT_COOLDOWN_MS.length - 1)] ?? 120_000;
  providerCooldownUntil.set(providerId, Date.now() + delay);
}

/** 测试钩子:清空限流冷却/重排状态。 */
export function _resetRateLimitStateForTest(): void {
  providerCooldownUntil.clear();
  providerCooldownStreak.clear();
  jobRateLimitRequeues.clear();
}

interface VideoJobRecord {
  id: string;
  projectId: string;
  shotSetId: string | null;
  shotId: string | null;
  sourceImageId: string;
  tailImageId: string | null;
  providerId: string;
  model: string;
  prompt: string;
  durationSec: number;
  status: string;
  attempt: number;
  maxAttempts: number;
  multiShot: number | null;
  usageSnapshotJson?: string | null;
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

        const claimed = claimNextVideoJob(projectId);
        if (claimed.job) {
          await runVideoJob(claimed.job, { timeoutMs, abort: abort.signal });
          continue;
        }
        // 没有新任务时,自动续跑已掉出轮询窗口的 needs_check 任务(它们持有
        // 远端 task_id,只是轮询超时,不能丢出自动化管线)。
        const needsCheck = claimNeedsCheckVideoJob(projectId);
        if (needsCheck) {
          await runVideoJob(needsCheck, { timeoutMs, abort: abort.signal });
          continue;
        }
        if (claimed.gated) {
          // 被每供应商闸门挡住:等待其他 running 任务释放名额,不能视为无活退出,
          // 否则 pending 任务会留在库里没人跑。
          await sleep(1000);
          continue;
        }

        const runningCount = db
          .prepare(`SELECT COUNT(*) as count FROM video_jobs WHERE projectId = ? AND status = 'running'`)
          .get(projectId) as { count: number };
        if (runningCount.count === 0) break;
        await sleep(500);
        continue;
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
  // 存量库旧行 maxAttempts 默认是 1(建表默认值也长期是 1),实际等于“无自动
  // 重试”;这里把 <= 1 的值统一视为未配置,兜底到运行时上限 2,让旧库也能
  // 自动重试一次。显式配置 > 1 的值(如 3)保持原样。
  const effectiveMaxAttempts = job.maxAttempts > 1 ? job.maxAttempts : DEFAULT_VIDEO_MAX_ATTEMPTS;
  const logInfo = (msg: string) =>
    writeLog({ jobId: job.id, projectId: job.projectId, level: 'info', message: msg, attempt });
  const logError = (msg: string) =>
    writeLog({ jobId: job.id, projectId: job.projectId, level: 'error', message: msg, attempt });
  const logWarn = (msg: string) =>
    writeLog({ jobId: job.id, projectId: job.projectId, level: 'warn', message: msg, attempt });

  logInfo(`Video job started (attempt ${attempt}/${effectiveMaxAttempts})`);

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
      baseUrl: string;
      apiKey: string;
      accessKey: string;
      secretKey: string;
      defaultDurationSec: number;
    } | undefined;

    if (!provider) throw new Error('Video provider not found');

    const runtime = resolveVideoProviderRuntimeConfig(provider);
    let apiKey = runtime.apiKey;
    if (!runtime.enabled) {
      throw new Error('Video provider is disabled. Enable it in Settings before running jobs.');
    }
    if (!runtime.configured) {
      throw new Error(`Video provider not configured. Set ${runtime.missing.join(', ')}`);
    }

    // Kling uses access_key + secret_key to generate a short-lived JWT.
    if (provider.type === 'kling') {
      const { getKlingToken } = await import('./video-providers/kling.ts');
      apiKey = getKlingToken(runtime.accessKey, runtime.secretKey);
    }

    const adapter = getVideoAdapter(provider.type);
    if (!adapter) throw new Error(`Unknown video provider type: ${provider.type}`);

    // Load source image
    const sourceImage = db
      .prepare(`SELECT * FROM image_assets WHERE id = ?`)
      .get(job.sourceImageId) as {
      path: string;
      originalPath: string | null;
      processedPath: string | null;
      mimeType: string;
    } | undefined;

    if (!sourceImage) throw new Error('Source image not found');

    // 首帧优先用未压缩的原图：上传预处理（最长边 1536、JPEG q85）是给图片
    // 生成 API 省流量的，压过再给视频模型会直接拉低成片起点画质；生成的
    // 分镜图没有 originalPath，自然回退到原有路径。
    const imagePath = sourceImage.originalPath || sourceImage.processedPath || sourceImage.path;
    const mimeType = videoFrameMimeFromPath(imagePath, sourceImage.mimeType);

    logInfo(`Calling video API: ${runtime.baseUrl} (type=${provider.type}, model=${job.model}, duration=${job.durationSec}s)`);

    const reqAbort = new AbortController();
    const onAbort = () => reqAbort.abort();
    abort.addEventListener('abort', onAbort, { once: true });

    // Step 1: Submit — 只在还没有远端 task_id 时执行。已持有 task_id 的
    // 任务(needs_check 自动续跑、崩溃后恢复为 pending 的旧任务)直接进入
    // 轮询;重新 submit 会在供应商侧产生第二条付费任务,违反防重复扣费纪律。
    const existingTaskId = (db.prepare(`
      SELECT providerTaskId FROM video_jobs WHERE id = ?
    `).get(job.id) as { providerTaskId: string | null } | undefined)?.providerTaskId ?? null;
    let usageSnapshot: string | null = job.usageSnapshotJson ?? null;

    let taskId: string;
    if (existingTaskId) {
      taskId = existingTaskId;
      logInfo(`Resuming polling for existing task_id=${taskId}`);
    } else {
      const tailValidation = validateVideoTailFrameAsset({
        db,
        tailImageId: job.tailImageId,
        projectId: job.projectId,
        providerType: provider.type,
        model: job.model,
      });
      if (!tailValidation.ok) throw new Error(tailValidation.error);
      const tailImage = tailValidation.asset;
      // 尾帧同首帧：优先未压缩原图，保住末帧收束的画质。
      const tailPath = tailImage
        ? (tailImage.originalPath || tailImage.processedPath || tailImage.path)
        : undefined;
      const tailMimeType = tailPath ? videoFrameMimeFromPath(tailPath, tailImage?.mimeType) : undefined;

      logInfo('Submitting video generation task...');
      const submitRequest: SubmitVideoRequest = {
        model: job.model,
        prompt: job.prompt,
        sourceImagePath: imagePath,
        sourceMimeType: mimeType,
        tailImagePath: tailPath,
        tailMimeType,
        durationSec: job.durationSec,
      };
      const multiShot = videoMultiShotFromStorage(job.multiShot);
      if (multiShot !== undefined) submitRequest.multiShot = multiShot;

      usageSnapshot = persistVideoJobUsageSnapshot(db, {
        jobId: job.id,
        projectId: job.projectId,
        requestModel: job.model,
        provider: {
          id: provider.id,
          name: provider.name,
          type: provider.type,
          model: provider.defaultModel,
          baseUrl: runtime.baseUrl,
        },
        refType: 'video-job',
        refId: job.id,
      });
      const submitResult = await adapter.submit(
        submitRequest,
        apiKey,
        runtime.baseUrl,
        reqAbort.signal
      );

      if (!submitResult.providerTaskId) {
        throw new Error('Video provider did not return a task_id');
      }

      taskId = submitResult.providerTaskId;
      db.prepare(
        `UPDATE video_jobs SET providerTaskId = ?, providerStatus = 'submitted', providerRawResponse = ?, startedAt = datetime('now')
         WHERE id = ?`
      ).run(taskId, safeJson(submitResult.rawResponse), job.id);
      // 提交成功:解除该供应商的限流退避计数与任务的重排计数
      providerCooldownStreak.delete(job.providerId);
      jobRateLimitRequeues.delete(job.id);
      logInfo(`Video task submitted, task_id=${taskId}`);
    }

    // Step 2: Poll with graduated intervals
    let polled = false;
    const pollStartedAt = Date.now();
    const maxPollMs = resolveVideoPollingTimeoutMs({
      requestedTimeoutMs: timeoutMs || DEFAULT_VIDEO_TIMEOUT_MS,
      adapter,
      request: { model: job.model, durationSec: job.durationSec },
    });
    logInfo(`Video polling window=${Math.round(maxPollMs / 1000)}s`);

    while (Date.now() - pollStartedAt < maxPollMs) {
      if (reqAbort.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (!isVideoJobStillRunning(db, job.id)) {
        logWarn('Video job stopped because it is no longer running');
        return;
      }

      await sleep(5000); // poll every 5 seconds
      if (!isVideoJobStillRunning(db, job.id)) {
        logWarn('Video job stopped because it is no longer running');
        return;
      }

      const pollResult = await adapter.poll(taskId, apiKey, runtime.baseUrl, reqAbort.signal);

      const elapsedSec = Math.round((Date.now() - pollStartedAt) / 1000);
      db.prepare(
        `UPDATE video_jobs SET providerStatus = ?, providerRawResponse = ?, lastPolledAt = datetime('now'), pollCount = pollCount + 1
         WHERE id = ?`
      ).run(pollResult.status, safeJson(pollResult.rawResponse), job.id);
      logInfo(`Video poll status=${pollResult.status} (${elapsedSec}s elapsed)`);

      if (pollResult.status === 'succeeded' && pollResult.videoUrl) {
        // Step 3: Download video
        logInfo(`Video generation succeeded, downloading: ${redactMediaUrlForLog(pollResult.videoUrl, apiKey)}`);
        const downloadResult = await downloadVideoMediaForProvider({
          providerType: provider.type,
          url: pollResult.videoUrl,
          baseUrl: runtime.baseUrl,
          apiKey,
        });

        if (!downloadResult.ok) {
          const failure = describeGatewayDownloadFailure('video', pollResult.videoUrl, downloadResult, apiKey);
          logError(`${failure.errorMessage} URL: ${failure.logUrl}`);
          db.prepare(
            `UPDATE video_jobs SET status = ?, errorMessage = ?, providerStatus = ?, remoteVideoUrl = ?, finishedAt = datetime('now')
             WHERE id = ? AND status = 'running'`
          ).run(failure.status, failure.errorMessage, failure.providerStatus, pollResult.videoUrl, job.id);
          return;
        }
        const videoBuffer = downloadResult.buffer;

        // Save video to storage/videos/
        const videosDir = path.join(dataRoot(), 'storage', 'videos');
        if (!fs.existsSync(videosDir)) fs.mkdirSync(videosDir, { recursive: true });

        const videoFilename = `video-${job.id.slice(0, 8)}-${Date.now()}.mp4`;
        const videoPath = path.join(videosDir, videoFilename);
        fs.writeFileSync(videoPath, videoBuffer);

        const finishedAt = new Date().toISOString();
        const completeResult = db.prepare(
          `UPDATE video_jobs SET
            status = 'succeeded',
            providerStatus = 'succeeded',
            remoteVideoUrl = ?,
            localVideoPath = ?,
            filename = ?,
            finishedAt = ?
           WHERE id = ? AND status = 'running'`
         ).run(pollResult.videoUrl, videoPath, videoFilename, finishedAt, job.id);

        if (completeResult.changes === 1) {
          const usageResult = recordVideoJobUsage(db, {
            jobId: job.id,
            projectId: job.projectId,
            durationSec: job.durationSec,
            snapshot: usageSnapshot,
            finishedAt,
          });
          if (!usageResult.ok) {
            logWarn(`实时 usage 记账失败，将由 reconciler 补记 (${usageResult.reason ?? 'unknown'})`);
          }
        }

        logInfo(`Video job completed, saved as ${videoFilename}`);
        polled = true;
        break;
      }

      if (pollResult.status === 'failed') {
        // 供应商明确失败:终态,不补抓、不自动重试(避免无意义的重复提交)。
        const failureMessage = pollResult.errorMessage || 'unknown';
        logError(`Video generation failed: ${failureMessage}`);
        db.prepare(
          `UPDATE video_jobs SET status = 'failed', errorMessage = ?, providerStatus = 'failed', finishedAt = datetime('now')
           WHERE id = ? AND status = 'running'`
        ).run(`Video generation failed: ${failureMessage}`, job.id);
        return;
      }
    }

    if (!polled) {
      // Polling timeout with task_id → needs_check
      logWarn(`Video polling timeout (task_id=${taskId}) → needs_check`);
      db.prepare(
        `UPDATE video_jobs SET status = 'needs_check', errorMessage = ?, providerStatus = 'needs_check', finishedAt = datetime('now')
         WHERE id = ? AND status = 'running'`
      ).run(`Polling timeout (${Math.round((Date.now() - pollStartedAt) / 1000)}s). task_id=${taskId} may still be running.`, job.id);
    }
  } catch (err: unknown) {
    // 只有队列级 abort(用户取消)才是取消;适配器内部超时(如 kling 的 120s
    // 提交/30s 轮询)产生的是 AbortError,但远端任务可能仍在跑,绝不能误判为
    // canceled——按下面的失败分支处理。
    if (abort.aborted) {
      db.prepare(
        `UPDATE video_jobs SET status = 'canceled', errorMessage = 'Canceled by user'
         WHERE id = ? AND status = 'running'`
      ).run(job.id);
      return;
    }

    const errorMessage = (err instanceof Error ? err.message : String(err)).slice(0, 2000);
    logError(`Video job failed: ${errorMessage}`);

    // 网关限流/过载(提交阶段 429/5xx):不消耗 maxAttempts,按供应商记冷却
    // 退避(30s/60s/120s 逐级),冷却内 claim 视同 gated;同一任务重排超过
    // RATE_LIMIT_MAX_REQUEUES 次才标失败。
    if (isRateLimitedSubmitError(errorMessage)) {
      noteRateLimitCooldown(job.providerId);
      const requeues = (jobRateLimitRequeues.get(job.id) ?? 0) + 1;
      jobRateLimitRequeues.set(job.id, requeues);
      if (requeues > RATE_LIMIT_MAX_REQUEUES) {
        db.prepare(
          `UPDATE video_jobs SET status = 'failed', finishedAt = datetime('now'), errorMessage = ?
           WHERE id = ? AND status = 'running'`
        ).run(`网关持续限流，退避重试 ${RATE_LIMIT_MAX_REQUEUES} 次后仍失败：${errorMessage}`, job.id);
      } else {
        db.prepare(
          `UPDATE video_jobs SET status = 'pending', errorMessage = ?
           WHERE id = ? AND status = 'running'`
        ).run(`网关限流，退避后自动重试（第 ${requeues}/${RATE_LIMIT_MAX_REQUEUES} 次）：${errorMessage}`, job.id);
      }
      return;
    }

    // 防重复扣费纪律:已经拿到供应商 task_id 的失败不允许重新 submit(重交
    // 会在远端产生第二条付费任务),一律转 needs_check,由队列自动续跑或用户
    // 手动补抓;只有提交前/未拿到 task_id 的失败才走自动重试。
    const submitted = db.prepare(`
      SELECT providerTaskId FROM video_jobs WHERE id = ?
    `).get(job.id) as { providerTaskId: string | null } | undefined;
    if (submitted?.providerTaskId) {
      db.prepare(
        `UPDATE video_jobs SET status = 'needs_check', errorMessage = ?, providerStatus = 'needs_check', finishedAt = datetime('now')
         WHERE id = ? AND status = 'running'`
      ).run(errorMessage, job.id);
      return;
    }

    if (attempt >= effectiveMaxAttempts) {
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

interface ClaimedVideoJob extends VideoJobRecord {
  attempt: number;
}

export interface ClaimVideoJobResult {
  job: ClaimedVideoJob | null;
  /** 队列里还有 pending 任务,但被每供应商闸门挡住(不能据此认为没活了) */
  gated: boolean;
}

/**
 * 原子领取下一条 pending 视频任务。领取顺序与 UI 的 createdAt 一致,
 * 避免“后面的任务先跑”的混乱观感。若该任务所属供应商已达并发上限,
 * 不领取并标记 gated(跨项目统计 running,闸门在多项目并行时依然生效)。
 */
export function claimNextVideoJob(projectId: string): ClaimVideoJobResult {
  const db = getDb();
  const job = db.prepare(`
    SELECT * FROM video_jobs
    WHERE projectId = ? AND status = 'pending'
    ORDER BY createdAt, id LIMIT 1
  `).get(projectId) as VideoJobRecord | undefined;

  if (!job) return { job: null, gated: false };

  const providerRow = db.prepare(`
    SELECT type FROM video_providers WHERE id = ?
  `).get(job.providerId) as { type: string } | undefined;
  const limit = providerRow ? providerConcurrencyLimit(providerRow.type) : null;
  if (limit !== null) {
    const running = db.prepare(`
      SELECT COUNT(*) AS count FROM video_jobs WHERE providerId = ? AND status = 'running'
    `).get(job.providerId) as { count: number };
    if (running.count >= limit) return { job: null, gated: true };
  }

  // 限流冷却期内视同被闸门挡住:pending 还在,但不能领(避免立刻重新撞墙)。
  const cooldownUntil = providerCooldownUntil.get(job.providerId);
  if (cooldownUntil !== undefined) {
    if (cooldownUntil > Date.now()) return { job: null, gated: true };
    providerCooldownUntil.delete(job.providerId);
  }

  const nextAttempt = job.attempt + 1;
  const result = db.prepare(`
    UPDATE video_jobs SET status = 'running', attempt = ?, startedAt = datetime('now'), errorMessage = NULL
    WHERE id = ? AND status = 'pending'
  `).run(nextAttempt, job.id);

  if (result.changes !== 1) return { job: null, gated: false };
  return { job: { ...job, status: 'running', attempt: nextAttempt }, gated: false };
}

/**
 * 原子领取一条 needs_check 任务继续轮询(自动续跑)。只有持有远端 task_id
 * 的任务才会进入 needs_check,续跑不会重新提交、不会重复扣费。
 */
export function claimNeedsCheckVideoJob(projectId: string): ClaimedVideoJob | null {
  const db = getDb();
  const job = db.prepare(`
    SELECT * FROM video_jobs
    WHERE projectId = ? AND status = 'needs_check' AND providerTaskId IS NOT NULL
    ORDER BY createdAt, id LIMIT 1
  `).get(projectId) as VideoJobRecord | undefined;

  if (!job) return null;

  const nextAttempt = job.attempt + 1;
  const result = db.prepare(`
    UPDATE video_jobs SET status = 'running', attempt = ?, startedAt = datetime('now'), errorMessage = NULL
    WHERE id = ? AND status = 'needs_check'
  `).run(nextAttempt, job.id);

  if (result.changes !== 1) return null;
  return { ...job, status: 'running', attempt: nextAttempt };
}

function isVideoJobStillRunning(db: ReturnType<typeof getDb>, jobId: string): boolean {
  const row = db.prepare(`SELECT status FROM video_jobs WHERE id = ?`).get(jobId) as { status: string } | undefined;
  return row?.status === 'running';
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
