import type Database from 'better-sqlite3';
import type { BatchTaskExecutor } from './executors.ts';
import {
  discardBatchRenderResult,
  renderBatchOutputVersion,
  resolveBatchArrangementNarration,
  type BatchRenderInput,
  type BatchRenderNarrationInput,
} from './batch-renderer.ts';

export interface BatchRenderExecutorOptions {
  storageRoot?: string;
  dataRootPath?: string;
  renderRoot?: string;
  /** Optional local narration seam. It must return an already prepared path + full fingerprint. */
  resolveNarration?: (input: {
    db: Database.Database;
    projectId: string;
    batchId: string;
    batchVersionId: string;
    planId: string;
    outputVersionId: string;
  }) => Promise<BatchRenderNarrationInput | undefined> | BatchRenderNarrationInput | undefined;
}

/**
 * Adapter for the existing scheduler. The task target is always an
 * output_version; all lineage and source/LUT revalidation remains inside the
 * renderer module rather than being duplicated in the scheduler.
 */
export function createBatchRenderExecutor(options: BatchRenderExecutorOptions = {}): BatchTaskExecutor {
  return {
    workTypes: ['render'],
    async execute(context) {
      const { db, claim, signal } = context;
      if (claim.task.targetKind !== 'output_version') throw new Error('正式渲染任务目标必须是 output_version');
      const task = db.prepare(`SELECT projectId, batchId FROM batch_tasks WHERE id = ?`).get(claim.task.id) as { projectId: string; batchId: string } | undefined;
      if (!task) throw new Error('正式渲染任务不存在');
      const lineage = db.prepare(`
        SELECT p.batchVersionId, p.id AS planId, o.id AS outputVersionId
        FROM batch_output_versions o
        JOIN batch_output_plans p ON p.id = o.planId
        JOIN batch_production_versions v ON v.id = p.batchVersionId
        WHERE o.id = ? AND v.batchId = ?
      `).get(claim.task.targetId, task.batchId) as { batchVersionId: string; planId: string; outputVersionId: string } | undefined;
      if (!lineage) throw new Error('正式渲染目标不属于任务批次谱系');
      const narration = options.resolveNarration
        ? await options.resolveNarration({
            db, projectId: task.projectId, batchId: task.batchId,
            batchVersionId: lineage.batchVersionId, planId: lineage.planId, outputVersionId: lineage.outputVersionId,
          })
        : resolveNarrationFromArrangement(db, lineage.outputVersionId, lineage.planId, lineage.batchVersionId);
      const renderInput: BatchRenderInput = {
        db,
        projectId: task.projectId,
        batchId: task.batchId,
        batchVersionId: lineage.batchVersionId,
        planId: lineage.planId,
        outputVersionId: lineage.outputVersionId,
        storageRoot: options.storageRoot,
        dataRootPath: options.dataRootPath,
        renderRoot: options.renderRoot,
        narration,
        signal,
        onProgress: (progress) => context.reportProgress({
          phase: progress.phase,
          description: progress.description,
          completed: progress.completed ?? undefined,
          total: progress.total ?? undefined,
          percent: progress.percent,
        }),
      };
      const result = await renderBatchOutputVersion(renderInput);
      return {
        resultJson: {
          ...result,
          videoAbsolutePath: undefined,
          coverAbsolutePath: undefined,
        },
        discard: () => discardBatchRenderResult(result),
      };
    },
  };
}

/**
 * Default persisted narration seam. Only a storage-relative path is accepted;
 * browser-provided absolute paths are rejected before renderer invocation.
 * Priority: current arrangement seam first (already frozen into the version),
 * then the authoritative per-script-snapshot narration — so candidates created
 * by a later reallocation still render with the same verified voice.
 */
export function resolveNarrationFromArrangement(db: Database.Database, outputVersionId: string, planId?: string, batchVersionId?: string): BatchRenderNarrationInput | undefined {
  const row = db.prepare(`SELECT arrangementJson FROM batch_output_versions WHERE id = ?`).get(outputVersionId) as { arrangementJson: string } | undefined;
  if (!row) throw new Error('outputVersion 不存在');
  let arrangement: unknown;
  try { arrangement = JSON.parse(row.arrangementJson) as unknown; } catch { throw new Error('outputVersion arrangementJson 损坏'); }
  const value = arrangement && typeof arrangement === 'object' && !Array.isArray(arrangement)
    ? (arrangement as Record<string, unknown>).narration
    : undefined;
  const fromArrangement = resolveBatchArrangementNarration(value);
  if (fromArrangement || !planId || !batchVersionId) return fromArrangement;
  const stored = db.prepare(`
    SELECT narrationJson FROM batch_script_narrations
    WHERE scriptSnapshotId = (SELECT scriptSnapshotId FROM batch_output_plans WHERE id = ? AND batchVersionId = ?)
  `).get(planId, batchVersionId) as { narrationJson: string } | undefined;
  if (!stored) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(stored.narrationJson) as unknown; } catch { return undefined; }
  return resolveBatchArrangementNarration(parsed);
}

export const batchRenderExecutor = createBatchRenderExecutor();
export const batchRendererExecutor = batchRenderExecutor;
