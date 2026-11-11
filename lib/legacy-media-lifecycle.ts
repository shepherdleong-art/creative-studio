import { getDb } from './db.ts';
import { writeLog } from './logger.ts';
import { repairLegacyCanceledMediaJobs } from './legacy-media-cancel.ts';
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
      if (serverMode) {
        // 旧版本取消路径只把业务行改成 canceled、没写取消意图，导致执行记录永远停在
        // accepted、队列既不续跑也不补抓。启动时先补写意图，下面的项目恢复查询才能
        // 把这些历史孤儿重新捞回来收口。只补「仍有远端身份、且远端未到终态」的行。
        try {
          const repaired = repairLegacyCanceledMediaJobs(db);
          if (repaired.video > 0 || repaired.image > 0) {
            writeLog({
              jobId: '', projectId: '', level: 'warn',
              message: `已修复历史取消孤儿：视频 ${repaired.video} 条、图片 ${repaired.image} 条，将按原通道续查收尾`,
            });
          }
        } catch (error) {
          // 修复是补救动作，失败不得阻塞启动；原队列恢复逻辑继续按现有条件运行。
          writeLog({
            jobId: '', projectId: '', level: 'error',
            message: `历史取消孤儿修复失败: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
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
                j.status = 'canceled'
                AND (j.providerTaskId IS NOT NULL OR (j.providerStatus = 'download_failed' AND j.remoteImageUrl IS NOT NULL))
                AND COALESCE(j.providerStatus, '') NOT IN ('succeeded', 'failed', 'not_created')
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
                j.status = 'canceled'
                AND (j.providerTaskId IS NOT NULL OR (j.providerStatus = 'download_failed' AND j.remoteVideoUrl IS NOT NULL))
                AND COALESCE(j.providerStatus, '') NOT IN ('succeeded', 'failed', 'not_created')
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
