import { getDb } from './db.ts';
import { writeLog } from './logger.ts';
import type { ExecutionModuleLifecycle } from './media-core/execution/contracts.ts';
import { drainImageQueues, runQueue } from './queue.ts';
import { readRuntimeConfig } from './team-service/config.ts';
import { productionParamsFor } from './team-service/production-defaults.ts';
import {
  DEFAULT_VIDEO_CONCURRENCY,
  DEFAULT_VIDEO_TIMEOUT_MS,
  drainVideoQueues,
  runVideoQueue,
} from './video-queue.ts';

export function createLegacyMediaLifecycle(): ExecutionModuleLifecycle {
  return {
    name: 'legacy-media',
    ensureSchemaReady() {},
    registerRecovery() {},
    recover() {},
    start() {
      const db = getDb();
      const runtimeConfig = readRuntimeConfig();
      const serverMode = runtimeConfig.mode === 'server';
      const imageProjects = db.prepare(`
        SELECT p.id, p.concurrency, p.maxAttempts, p.timeoutMs
        FROM projects p
        WHERE EXISTS (
          SELECT 1 FROM jobs j
          WHERE j.projectId = p.id
            AND (
              j.status IN ('pending', 'retrying', 'running', 'deferred', 'needs_check')
              OR j.providerStatus = 'download_failed'
              OR (
                j.status = 'canceled' AND j.cancelRequestedAt IS NOT NULL
                AND (j.providerTaskId IS NOT NULL OR (j.providerStatus = 'download_failed' AND j.remoteImageUrl IS NOT NULL))
              )
            )
            AND NOT EXISTS (
              SELECT 1 FROM final_edit_film_reworks r
              WHERE r.jobId = j.id AND r.kind = 'generate_image'
            )
        )
      `).all() as Array<{ id: string; concurrency: number; maxAttempts: number; timeoutMs: number }>;
      for (const project of imageProjects) {
        // 恢复也走同一套裁决：server 模式用服务器默认并发/超时，本地版沿用项目存值。
        const production = productionParamsFor(runtimeConfig, {
          concurrency: project.concurrency,
          timeoutMs: project.timeoutMs,
        });
        void runQueue({
          projectId: project.id,
          concurrency: Math.max(1, production.projectConcurrency),
          maxAttempts: Math.max(1, project.maxAttempts || 2),
          timeoutMs: Math.max(1, production.timeoutMs),
        }).catch((error) => {
          writeLog({
            jobId: '', projectId: project.id, level: 'error',
            message: `server 图片队列恢复失败: ${error instanceof Error ? error.message : String(error)}`,
          });
        });
      }

      const videoProjects = db.prepare(`
        SELECT p.id, p.videoConcurrency
        FROM projects p
        WHERE EXISTS (
          SELECT 1 FROM video_jobs j
          WHERE j.projectId = p.id
            AND (
              j.status IN ('pending', 'running', 'deferred', 'needs_check')
              OR j.providerStatus = 'download_failed'
              OR (
                j.status = 'canceled' AND j.cancelRequestedAt IS NOT NULL
                AND (j.providerTaskId IS NOT NULL OR (j.providerStatus = 'download_failed' AND j.remoteVideoUrl IS NOT NULL))
              )
            )
            AND NOT EXISTS (
              SELECT 1 FROM final_edit_film_reworks r
              WHERE r.jobId = j.id AND r.kind = 'generate_video'
            )
        )
      `).all() as Array<{ id: string; videoConcurrency: number | null }>;
      // server 模式下队列恢复也按服务器统一的视频并发；本地版仍按项目存值。
      const serverVideoConcurrency = serverMode
        ? productionParamsFor(readRuntimeConfig()).videoConcurrency
        : null;
      for (const project of videoProjects) {
        void runVideoQueue({
          projectId: project.id,
          concurrency: serverVideoConcurrency
            ?? Math.max(1, Math.min(10, Number(project.videoConcurrency) || DEFAULT_VIDEO_CONCURRENCY)),
          timeoutMs: DEFAULT_VIDEO_TIMEOUT_MS,
        }).catch((error) => {
          writeLog({
            jobId: '', projectId: project.id, level: 'error',
            message: `server 视频队列恢复失败: ${error instanceof Error ? error.message : String(error)}`,
          });
        });
      }
    },
    async drain() {
      const [images, videos] = await Promise.all([drainImageQueues(), drainVideoQueues()]);
      return images + videos;
    },
  };
}
