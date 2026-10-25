import type Database from 'better-sqlite3';
import { applyBatchOutputClipEdit, type BatchOutputClipEdit, type BatchOutputClipEditResult } from './output-arrangement.ts';
import { resolveCoverContract, resolveCoverContractHash } from './cover-contract.ts';
import { scheduleRenderAfterCoverChange } from './phase-e.ts';
import { BatchDomainError } from './errors.ts';

interface EditingOptions {
  wakeScheduler?: () => void | Promise<void>;
}

async function defaultWakeScheduler() {
  const { ensureBatchSchedulerStarted } = await import('./bootstrap.ts');
  ensureBatchSchedulerStarted();
}

function coverHash(db: Database.Database, outputVersionId: string | null): string | null {
  if (!outputVersionId) return null;
  try { return resolveCoverContractHash(db, outputVersionId); }
  catch { return null; } // 旧数据无法解析契约时，沿用有画面变化就排封面的策略。
}

async function finishEdit(
  db: Database.Database, projectId: string, batchId: string, planId: string,
  result: BatchOutputClipEditResult, needsCover: boolean, options: EditingOptions,
) {
  let coverTaskId: string | null = null;
  if (needsCover) {
    try { coverTaskId = scheduleRenderAfterCoverChange(db, projectId, batchId, planId); }
    catch { throw new BatchDomainError('conflict', '修改已保存，但封面任务未能排队，请刷新检查成片后重试'); }
    if (coverTaskId) {
      try { await (options.wakeScheduler ?? defaultWakeScheduler)(); }
      catch { throw new BatchDomainError('conflict', '修改已保存，封面任务已排队，但调度器启动失败'); }
    }
  }
  return { ...result, coverTaskId };
}

/** 保存成片编辑，并且只为真实封面变化安排封面任务；不安排整片渲染。 */
export async function editBatchOutput(
  db: Database.Database, projectId: string, batchId: string, planId: string,
  edit: BatchOutputClipEdit, options: EditingOptions = {},
) {
  const plan = db.prepare('SELECT currentVersionId FROM batch_output_plans WHERE id=?').get(planId) as { currentVersionId: string | null } | undefined;
  const before = coverHash(db, plan?.currentVersionId ?? null);
  // 归属、修订和审核规则由既有编辑事务执行；失败时不会排队或唤醒。
  const result = applyBatchOutputClipEdit(db, projectId, batchId, planId, edit);
  const after = result.visualChanged ? coverHash(db, result.outputVersionId) : null;
  const needsCover = result.changed && result.visualChanged && (before === null || after === null || before !== after);
  return finishEdit(db, projectId, batchId, planId, result, needsCover, options);
}

/** 旧换封面入口：只换抽帧时间；无变化请求仍确保同契约封面任务存在并唤醒。 */
export async function changeBatchOutputCoverFrame(
  db: Database.Database, projectId: string, batchId: string, planId: string,
  timeUs: number, options: EditingOptions = {},
) {
  const plan = db.prepare(`
    SELECT p.currentVersionId FROM batch_output_plans p
    JOIN batch_production_versions v ON v.id = p.batchVersionId
    JOIN batch_productions b ON b.id = v.batchId
    WHERE p.id = ? AND b.id = ? AND b.projectId = ? AND b.deletedAt IS NULL
  `).get(planId, batchId, projectId) as { currentVersionId: string | null } | undefined;
  if (!plan?.currentVersionId) return null;
  const cover = resolveCoverContract(db, plan.currentVersionId);
  const result = applyBatchOutputClipEdit(db, projectId, batchId, planId, { type: 'set_cover', assetId: cover.assetId, timeUs });
  return finishEdit(db, projectId, batchId, planId, result, true, options);
}
