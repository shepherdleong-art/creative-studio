import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { BatchDomainError } from './errors.ts';
import {
  getAsset,
  type BatchAssetAnalysisStatus,
} from './assets.ts';
import {
  createBatchTask,
  type BatchTaskStatus,
} from './tasks.ts';

/** 素材分析能力级别：technical 为本地媒体参数，content 为视觉模型语义结果。 */
export type AssetAnalysisLevel = 'none' | 'technical' | 'content';

export interface CurrentAssetAnalysis {
  id: string;
  status: BatchAssetAnalysisStatus;
  analysisLevel: AssetAnalysisLevel;
  analysisJson: unknown;
  providerId: string;
  model: string;
}

export interface QueueAssetPreparationOptions {
  mode?: 'technical' | 'content';
  providerId?: string;
  model?: string;
  executionScope?: 'external' | 'company';
}

export interface AssetPreparationQueueItem {
  assetId: string;
  taskId: string | null;
  status: BatchTaskStatus | 'ready';
  ready: boolean;
  analysisId: string | null;
  analysisLevel: AssetAnalysisLevel;
}

export interface QueueAssetPreparationResult {
  batchId: string;
  projectId: string;
  items: AssetPreparationQueueItem[];
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

/**
 * 读取素材当前分析的能力级别。只有内容分析 Adapter 显式写入
 * analysisLevel=content 时才按语义分析使用；历史行和纯 FFprobe 结果
 * 都保守归为 technical，不靠字段形状猜测能力。
 */
export function getCurrentAssetAnalysis(
  db: Database.Database,
  projectId: string,
  assetId: string,
): CurrentAssetAnalysis | null {
  const row = db.prepare(`
    SELECT a.currentAnalysisId AS id, aa.status, aa.analysisJson, aa.providerId, aa.model
    FROM batch_assets a
    LEFT JOIN batch_asset_analysis aa ON aa.id = a.currentAnalysisId AND aa.assetId = a.id
    WHERE a.id = ? AND a.projectId = ?
  `).get(assetId, projectId) as {
    id: string | null;
    status: BatchAssetAnalysisStatus | null;
    analysisJson: string | null;
    providerId: string | null;
    model: string | null;
  } | undefined;
  if (!row?.id || !row.status) return null;

  const parsed = parseJson(row.analysisJson ?? '{}');
  const declared = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>).analysisLevel
    : undefined;
  // 能力级别只能由分析 Adapter 显式声明。历史行即使碰巧包含 scenes 或
  // usableRanges 等字段，也不能靠字段形状被升级成“内容分析可用”。
  const analysisLevel: AssetAnalysisLevel = declared === 'content' ? 'content' : 'technical';
  return {
    id: row.id,
    status: row.status,
    analysisLevel,
    analysisJson: parsed,
    providerId: row.providerId ?? '',
    model: row.model ?? '',
  };
}

function assertBatchAndProject(
  db: Database.Database,
  projectId: string,
  batchId: string,
): { controlState: string } {
  const batch = db.prepare(`
    SELECT projectId, controlState FROM batch_productions
    WHERE id = ? AND deletedAt IS NULL
  `).get(batchId) as { projectId: string; controlState: string } | undefined;
  if (!batch) throw new BatchDomainError('not_found', '批次不存在');
  if (batch.projectId !== projectId) throw new BatchDomainError('not_found', '批次不存在');
  if (batch.controlState === 'stopped') {
    throw new BatchDomainError('conflict', '已停止的批次不能继续准备素材');
  }
  return batch;
}

function assertOnlineProjectAsset(
  db: Database.Database,
  projectId: string,
  assetId: string,
): NonNullable<ReturnType<typeof getAsset>> {
  const asset = getAsset(db, projectId, assetId);
  if (!asset) throw new BatchDomainError('not_found', '素材不存在');
  if (asset.status !== 'online') {
    throw new BatchDomainError(
      'conflict',
      asset.status === 'archived' ? '归档素材不能分析' : '离线素材不能分析',
    );
  }
  return asset;
}

function stableDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 20);
}

function requestKey(
  batchId: string,
  assetId: string,
  contentFingerprint: string,
  options: QueueAssetPreparationOptions,
): string {
  if (options.mode === 'content') {
    // v17 已发布的 external key 只包含 provider+model；继续沿用它，避免旧任务在
    // v18 升级后因 key 漂移而重复排队。company scope 使用独立后缀隔离路由身份。
    const providerIdentity = options.executionScope === 'company'
      ? `${options.providerId}\u0000${options.model}\u0000company`
      : `${options.providerId}\u0000${options.model}`;
    return `asset_content:${batchId}:${assetId}:${stableDigest(contentFingerprint)}:${stableDigest(providerIdentity)}`;
  }
  return `asset_prepare:${batchId}:${assetId}`;
}

interface ExistingTask {
  id: string;
  status: BatchTaskStatus;
  targetId: string;
}

function findExistingTask(
  db: Database.Database,
  projectId: string,
  key: string,
): ExistingTask | undefined {
  return db.prepare(`
    SELECT id, status, targetId FROM batch_tasks
    WHERE projectId = ? AND requestKey = ?
  `).get(projectId, key) as ExistingTask | undefined;
}

/**
 * 在快照前排队项目素材技术分析或内容分析。
 * 素材分析版本属于项目素材库，因此已有 currentAnalysisId 时无需为每个批次
 * 再建任务；没有当前分析时才使用所选 draft batch 作为调度/恢复载体。
 * 同一批次+素材的 requestKey 稳定，失败任务原地回 queued，取消任务由
 * createBatchTask 释放 requestKey 后建立新任务。
 */
export function queueAssetPreparation(
  db: Database.Database,
  projectId: string,
  batchId: string,
  assetIds: string[],
  now?: () => Date,
  options: QueueAssetPreparationOptions = {},
): QueueAssetPreparationResult {
  if (!Array.isArray(assetIds) || assetIds.length === 0) {
    throw new BatchDomainError('invalid_input', 'assetIds 不能为空');
  }
  const uniqueAssetIds = [...new Set(assetIds)];
  if (uniqueAssetIds.some((assetId) => typeof assetId !== 'string' || !assetId)) {
    throw new BatchDomainError('invalid_input', 'assetIds 必须是非空字符串');
  }
  const mode = options.mode ?? 'technical';
  if (mode === 'content' && (!options.providerId?.trim() || !options.model?.trim())) {
    throw new BatchDomainError('invalid_input', '内容分析必须指定已配置的视觉供应商与模型');
  }
  if (mode === 'content' && options.executionScope !== undefined
    && options.executionScope !== 'external' && options.executionScope !== 'company') {
    throw new BatchDomainError('invalid_input', '供应商执行作用域无效');
  }

  assertBatchAndProject(db, projectId, batchId);

  // 先完整校验所有输入，避免一批请求中夹带跨项目 id 时对合法素材产生副作用。
  const assets = new Map<string, NonNullable<ReturnType<typeof getAsset>>>();
  for (const assetId of uniqueAssetIds) {
    assets.set(assetId, assertOnlineProjectAsset(db, projectId, assetId));
  }

  return db.transaction(() => {
    const items = uniqueAssetIds.map((assetId): AssetPreparationQueueItem => {
      const asset = assets.get(assetId)!;
      const current = getCurrentAssetAnalysis(db, projectId, assetId);
      const key = requestKey(batchId, assetId, asset.contentFingerprint, { ...options, mode });
      const existing = findExistingTask(db, projectId, key);

      if (current?.status === 'ready' && (mode === 'technical' || current.analysisLevel === 'content')) {
        // 如果本批次曾经有对应任务，保留其稳定 taskId 供 UI 追踪；否则
        // ready 素材可以跨批次复用而不制造第二条无意义任务。
        return {
          assetId,
          taskId: existing?.id ?? null,
          status: 'ready',
          ready: true,
          analysisId: current.id,
          analysisLevel: current.analysisLevel,
        };
      }

      if (existing?.status === 'failed') {
        const updatedAt = (now ?? (() => new Date()))().toISOString();
        db.prepare(`
          UPDATE batch_tasks
          SET status = 'queued', expectedState = 'running', updatedAt = ?
          WHERE id = ? AND projectId = ? AND status = 'failed'
        `).run(updatedAt, existing.id, projectId);
        return {
          assetId,
          taskId: existing.id,
          status: 'queued',
          ready: false,
          analysisId: asset.currentAnalysisId,
          analysisLevel: 'none',
        };
      }

      const taskId = createBatchTask(db, projectId, {
        batchId,
        workType: 'asset_prepare',
        targetKind: 'asset',
        targetId: assetId,
        requestKey: key,
        now,
      });
      if (mode === 'content') {
        const createdAt = (now ?? (() => new Date()))().toISOString();
        db.prepare(`
          INSERT OR IGNORE INTO batch_asset_analysis_requests
            (taskId, projectId, batchId, assetId, contentFingerprint, providerId, model, executionScope, analysisMode, createdAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'content', ?)
        `).run(
          taskId,
          projectId,
          batchId,
          assetId,
          asset.contentFingerprint,
          options.providerId!.trim(),
          options.model!.trim(),
          options.executionScope ?? 'external',
          createdAt,
        );
      }
      const task = findExistingTask(db, projectId, key);
      return {
        assetId,
        taskId,
        status: task?.status ?? 'queued',
        ready: false,
        analysisId: asset.currentAnalysisId,
        analysisLevel: 'none',
      };
    });
    return { batchId, projectId, items };
  })();
}
