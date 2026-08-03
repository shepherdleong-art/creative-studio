import type Database from 'better-sqlite3';
import { probeVideoMedia } from '../ffmpeg.ts';
import { createAnalysisVersionAndSetCurrent } from './assets.ts';
import { resolveSourceFilePath } from './media-catalog.ts';
import type { BatchTaskWorkType, ClaimedBatchTask } from './tasks.ts';

/**
 * 统一进度报告。不可测的阶段 percent 必须为 null,不允许伪造
 * “看起来在动”的假数字(供应商只返回处理中时显示阶段与等待)。
 */
export interface BatchTaskProgress {
  phase: string;
  description?: string;
  completed?: number;
  total?: number;
  /** 0–1;不可测时为 null */
  percent?: number | null;
}

export interface BatchTaskExecutionContext {
  db: Database.Database;
  claim: ClaimedBatchTask;
  signal: AbortSignal;
  /** 报告当前阶段与真实进度(调度器负责节流落库) */
  reportProgress(progress: BatchTaskProgress): void;
}

export interface BatchTaskExecutor {
  /** 该执行器接受的任务种类 */
  workTypes: BatchTaskWorkType[];
  execute(context: BatchTaskExecutionContext): Promise<{ resultJson?: unknown }>;
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error('任务已中止');
  }
}

/**
 * 素材分析执行器(asset_prepare):用 ffprobe 探测素材媒体属性,
 * 写入素材分析版本并更新素材当前分析指向。
 * 分析来源是 ffprobe,版本号固定,失败可重试。
 */
export const analyzeAssetExecutor: BatchTaskExecutor = {
  workTypes: ['asset_prepare'],
  async execute(context) {
    const { db, claim, signal } = context;
    if (claim.task.targetKind !== 'asset') {
      throw new Error('素材分析任务的目标必须是素材');
    }
    context.reportProgress({ phase: 'locating', description: '定位素材来源', percent: null });
    assertNotAborted(signal);
    const source = db.prepare(`
      SELECT locationJson FROM batch_asset_sources
      WHERE assetId = ? AND health = 'healthy'
      ORDER BY createdAt, id LIMIT 1
    `).get(claim.task.targetId) as { locationJson: string } | undefined;
    if (!source) {
      throw new Error('素材没有可用来源,等待重新定位');
    }
    const filePath = resolveSourceFilePath(JSON.parse(source.locationJson));
    context.reportProgress({ phase: 'probing', description: '探测媒体属性', percent: null });
    assertNotAborted(signal);
    const probe = await probeVideoMedia(filePath);
    // 领域逻辑在 assets.ts:原子创建分析版本并切换当前指向,返回真实分析 id
    const analysisId = createAnalysisVersionAndSetCurrent(db, {
      assetId: claim.task.targetId,
      analyzerVersion: 'batch-analysis-v1',
      providerId: 'ffprobe',
      model: 'ffprobe',
      analysisJson: {
        durationUs: probe.durationUs,
        width: probe.width,
        height: probe.height,
      },
      now: () => new Date(),
    });
    context.reportProgress({ phase: 'analyzed', description: '分析完成', percent: 1 });
    return { resultJson: { analysisId } };
  },
};

/** 按任务种类选择执行器;没有注册执行器的任务种类返回 null。 */
export function findExecutor(
  executors: BatchTaskExecutor[],
  workType: BatchTaskWorkType,
): BatchTaskExecutor | undefined {
  return executors.find((executor) => executor.workTypes.includes(workType));
}
