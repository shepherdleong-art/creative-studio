import crypto from 'node:crypto';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db.ts';
import { dataRoot } from '../data-root.ts';
import { renderFinalEditSnapshot, type FinalEditRenderSnapshot } from './renderer.ts';
import { runFinalEditHeavyJob } from './heavy-job-lock.ts';
import { formatShanghaiTaskDate } from './export-identity.ts';
import { resolveProjectExportDirName } from '../project-export-dir.ts';
import { getOrCreateCurrentExportIdentity } from '../project-export-identity.ts';
import { readProductionIdentityFields, deriveProjectNamingDate } from '../project-production-identity.ts';
import { publishReservedExportTarget, publishReservedSingleFile, reserveProjectExportTarget, restorePublishedExportReservation } from './export-naming.ts';
import { buildPublishedJobOutput, registerPublishedArtifacts, registerSingleArtifact } from './project-artifacts.ts';
import { deletePackagedPublish, executePackagingJob, registerPackagedArtifact, type FinalEditPackagingSnapshot, type PackagingJobResult } from './packaging.ts';
import { FinalEditError } from './errors.ts';

const sha256 = (input: string) => crypto.createHash('sha256').update(input).digest('hex');

let running = false;
let recovered = false;
let shutdownRequested = false;
const activeFinalEditControllers = new Set<AbortController>();

function makeAbortError(): Error {
  const error = new Error('成片任务因服务停机而中止');
  error.name = 'AbortError';
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/** 广播停机到成片 worker 当前持有的任务。 */
export function abortRunningFinalEditJobs(): number {
  shutdownRequested = true;
  const runningControllers = [...activeFinalEditControllers];
  for (const controller of runningControllers) controller.abort();
  return runningControllers.length;
}

export interface FinalEditJobControllerRegistration {
  controller: AbortController;
  release(): void;
}

/** Registers both render and prepare work in the process-wide shutdown set. */
export function createFinalEditJobController(): FinalEditJobControllerRegistration {
  const controller = new AbortController();
  activeFinalEditControllers.add(controller);
  if (shutdownRequested) controller.abort();
  let released = false;
  return {
    controller,
    release: () => {
      if (released) return;
      released = true;
      activeFinalEditControllers.delete(controller);
    },
  };
}

/** 返回超时后仍未从成片 worker 收尾的任务数。 */
export async function waitForFinalEditJobsIdle(timeoutMs: number): Promise<number> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (activeFinalEditControllers.size > 0 && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  return activeFinalEditControllers.size;
}

async function drain() {
  if (running || shutdownRequested) return;
  running = true;
  const db = getDb();
  try {
    if (!recovered) {
      db.prepare(`UPDATE final_edit_jobs SET status='queued', phase='recovered_after_restart', startedAt=NULL WHERE kind IN ('render','packaging') AND status='running'`).run();
      recovered = true;
    }
    while (!shutdownRequested) {
      const job = db.prepare(`SELECT id, projectId, groupId, kind, inputSnapshotJson FROM final_edit_jobs WHERE kind IN ('render','packaging') AND status='queued' ORDER BY createdAt LIMIT 1`).get() as { id: string; projectId: string; groupId: string | null; kind: string; inputSnapshotJson: string } | undefined;
      if (!job) break;
      const claimed = db.prepare(`UPDATE final_edit_jobs SET status='running', phase='preflight', progress=0, startedAt=? WHERE id=? AND status='queued'`).run(new Date().toISOString(), job.id);
      if (!claimed.changes) continue;
      const registration = createFinalEditJobController();
      const controller = registration.controller;
      try {
        if (controller.signal.aborted) throw makeAbortError();
        if (job.kind === 'packaging') {
          await drainPackagingJob(db, job, controller);
          continue;
        }
        let snapshot = JSON.parse(job.inputSnapshotJson) as FinalEditRenderSnapshot;
        if (!snapshot.exportIdentity || !snapshot.exportTarget) {
          const project = db.prepare(`SELECT name, productCode, createdAt, storeCode, productSubmodel, productionType, editorName, namingDate FROM projects WHERE id=?`).get(job.projectId) as { name: string; productCode: string | null; createdAt: string; storeCode: string | null; productSubmodel: string | null; productionType: string | null; editorName: string | null; namingDate: string | null } | undefined;
          if (!project) throw new FinalEditError('project_not_found', '项目不存在', 404);
          const identityFields = readProductionIdentityFields(project);
          const namingDate = deriveProjectNamingDate({ namingDate: project.namingDate ?? '', createdAt: project.createdAt });
          const frozen = identityFields.storeCode && identityFields.productCode && identityFields.productionType && identityFields.editorName
            ? getOrCreateCurrentExportIdentity(db, job.projectId, { ...identityFields, namingDate })
            : null;
          const exportIdentity = {
            projectId: job.projectId,
            taskName: project.name,
            productCode: project.productCode || '',
            taskDate: formatShanghaiTaskDate(project.createdAt),
            exportDirName: frozen ? frozen.exportDirName : resolveProjectExportDirName(db, job.projectId),
            ...(frozen ? { baseName: frozen.baseName } : {}),
          };
          const blockedRelativePaths = new Set((db.prepare(`SELECT relativePath FROM project_artifacts WHERE projectId=?`).all(job.projectId) as Array<{ relativePath: string }>).map((row) => row.relativePath));
          snapshot = { ...snapshot, exportIdentity, exportTarget: reserveProjectExportTarget(path.join(dataRoot(), 'storage'), exportIdentity, { blockedRelativePaths }) };
          db.prepare(`UPDATE final_edit_jobs SET inputSnapshotJson=? WHERE id=? AND status='running'`).run(JSON.stringify(snapshot), job.id);
        }
        db.prepare(`UPDATE final_edit_jobs SET phase='rendering', progress=0.05 WHERE id=?`).run(job.id);
        const storageRoot = path.join(dataRoot(), 'storage');
        const internal = await runFinalEditHeavyJob(() => renderFinalEditSnapshot({ jobId: job.id, storageRoot, snapshot, signal: controller.signal, onProgress: (progress) => db.prepare(`UPDATE final_edit_jobs SET progress=? WHERE id=?`).run(0.05 + progress * 0.8, job.id) }));
        if (controller.signal.aborted) throw makeAbortError();
        const exportTarget = snapshot.exportTarget;
        if (!exportTarget) throw new FinalEditError('export_reservation_lost', '渲染快照缺少导出目标');
        db.prepare(`UPDATE final_edit_jobs SET phase='publishing', progress=0.9 WHERE id=?`).run(job.id);
        if (snapshot.packaging?.enabled) {
          // 包装联动：封面先发布，视频留给包装任务以正常成片名发布（目录唯一成片）
          await publishReservedSingleFile({ storageRoot, sourceRelativePath: internal.coverRelativePath, targetRelativePath: exportTarget.coverRelativePath, reservationRelativePath: exportTarget.reservationRelativePath, invalidCode: 'render_artifact_invalid' });
          if (controller.signal.aborted) {
            await restorePublishedExportReservation(storageRoot, exportTarget);
            throw makeAbortError();
          }
          const packagingJobId = uuidv4();
          const packagingSnapshot: FinalEditPackagingSnapshot = {
            renderJobId: job.id,
            variantId: snapshot.variant.id,
            template: snapshot.packaging.template,
            varsOverrides: snapshot.packaging.varsOverrides,
            exportTarget,
            ...(snapshot.packaging.pointCues ? { pointCues: snapshot.packaging.pointCues } : {}),
            ...(snapshot.packaging.pointCuesMode ? { pointCuesMode: snapshot.packaging.pointCuesMode } : {}),
            // §7：手动布局与编辑保护标志随快照冻结（包装任务据此写 vars.json 的 layouts）
            ...(snapshot.packaging.layouts && Object.keys(snapshot.packaging.layouts).length > 0 ? { layouts: snapshot.packaging.layouts } : {}),
            ...(snapshot.packaging.pointCuesEdited ? { pointCuesEdited: true } : {}),
            // §10 ②：三槽字体随快照冻结（包装任务按此注入 @font-face）
            ...(snapshot.packaging.titleFont ? { titleFont: snapshot.packaging.titleFont } : {}),
            ...(snapshot.packaging.subtitleFont ? { subtitleFont: snapshot.packaging.subtitleFont } : {}),
            ...(snapshot.packaging.pointFont ? { pointFont: snapshot.packaging.pointFont } : {}),
          };
          const result = {
            ...internal,
            publishedCoverRelativePath: exportTarget.coverRelativePath,
            coverFilename: exportTarget.coverFilename,
            displayDirectory: exportTarget.displayDirectory,
            packagingDeferred: true,
            packagingJobId,
          };
          const finishedAt = new Date().toISOString();
          try {
            db.transaction(() => {
              registerSingleArtifact(db, { id: `final-edit:${job.id}:cover`, projectId: job.projectId, kind: 'final_cover', displayName: exportTarget.coverFilename, relativePath: exportTarget.coverRelativePath, mimeType: 'image/jpeg', sourceJobId: job.id, createdAt: finishedAt });
              db.prepare(`INSERT INTO final_edit_jobs (id, projectId, groupId, variantId, kind, status, phase, progress, requestKey, inputSnapshotJson, estimatedCost, costCurrency, createdAt) VALUES (?, ?, ?, ?, 'packaging', 'queued', 'queued', 0, ?, ?, 0, 'CNY', ?)`).run(packagingJobId, job.projectId, job.groupId, snapshot.variant.id, sha256(JSON.stringify({ packagingJobId, packagingSnapshot })), JSON.stringify(packagingSnapshot), finishedAt);
              db.prepare(`UPDATE final_edit_jobs SET status='succeeded', phase='succeeded', progress=1, outputJson=?, errorCode=NULL, errorMessage=NULL, finishedAt=? WHERE id=?`).run(JSON.stringify(result), finishedAt, job.id);
              db.prepare(`UPDATE final_edit_variants SET lastRenderedRevision=? WHERE id=?`).run(snapshot.variantRevision, snapshot.variant.id);
            })();
          } catch (error) {
            await restorePublishedExportReservation(storageRoot, exportTarget);
            throw error;
          }
          continue;
        }
        const target = await publishReservedExportTarget({
          storageRoot,
          target: exportTarget,
          internalVideoRelativePath: internal.videoRelativePath,
          internalCoverRelativePath: internal.coverRelativePath,
        });
        if (controller.signal.aborted) {
          await restorePublishedExportReservation(storageRoot, target);
          throw makeAbortError();
        }
        const result = buildPublishedJobOutput({ internal, target });
        const finishedAt = new Date().toISOString();
        try {
          db.transaction(() => {
            registerPublishedArtifacts(db, { projectId: job.projectId, sourceJobId: job.id, target, createdAt: finishedAt });
            db.prepare(`UPDATE final_edit_jobs SET status='succeeded', phase='succeeded', progress=1, outputJson=?, errorCode=NULL, errorMessage=NULL, finishedAt=? WHERE id=?`).run(JSON.stringify(result), finishedAt, job.id);
            db.prepare(`UPDATE final_edit_variants SET lastRenderedRevision=? WHERE id=?`).run(snapshot.variantRevision, snapshot.variant.id);
          })();
        } catch (error) {
          await restorePublishedExportReservation(storageRoot, target);
          throw error;
        }
      } catch (error) {
        if (shutdownRequested && isAbortError(error)) {
          db.prepare(`UPDATE final_edit_jobs SET status='queued', phase='recovered_after_shutdown', progress=0, errorCode=NULL, errorMessage=NULL, startedAt=NULL, finishedAt=NULL WHERE id=? AND status='running'`).run(job.id);
          break;
        }
        db.prepare(`UPDATE final_edit_jobs SET status='failed', phase='failed', errorCode=?, errorMessage=?, finishedAt=? WHERE id=?`).run(error instanceof FinalEditError ? error.code : 'render_failed', error instanceof Error ? error.message.slice(0, 1500) : String(error).slice(0, 1500), new Date().toISOString(), job.id);
      } finally {
        registration.release();
      }
    }
  } finally { running = false; }
}

export function wakeFinalEditWorker() { setTimeout(() => void drain(), 0); }

/**
 * 包装任务分支：与渲染共用领取/中止/恢复骨架，但失败只影响包装任务本身。
 * 包装执行器内部完成渲染管线与发布；这里只做中止撤销与事务落账。
 */
async function drainPackagingJob(
  db: ReturnType<typeof getDb>,
  job: { id: string; projectId: string; inputSnapshotJson: string },
  controller: AbortController,
): Promise<void> {
  const snapshot = JSON.parse(job.inputSnapshotJson) as FinalEditPackagingSnapshot;
  db.prepare(`UPDATE final_edit_jobs SET phase='packaging', progress=0.05 WHERE id=?`).run(job.id);
  const storageRoot = path.join(dataRoot(), 'storage');
  const result: PackagingJobResult = await runFinalEditHeavyJob(() => executePackagingJob({
    db,
    storageRoot,
    jobId: job.id,
    projectId: job.projectId,
    snapshot,
    signal: controller.signal,
    onProgress: (progress) => db.prepare(`UPDATE final_edit_jobs SET progress=? WHERE id=?`).run(0.05 + progress * 0.85, job.id),
  }));
  if (controller.signal.aborted) {
    await deletePackagedPublish(storageRoot, result.published);
    if (snapshot.exportTarget) {
      // 联动模式：重建视频预留锁供重试（封面前半由渲染任务发布，保留不动）
      try {
        const { writeFileSync } = await import('node:fs');
        writeFileSync(path.join(storageRoot, snapshot.exportTarget.reservationRelativePath), '', { flag: 'wx' });
      } catch { /* 锁已存在或目录异常，重试时按既有语义处理 */ }
    }
    throw makeAbortError();
  }
  const output = {
    videoRelativePath: result.internal.videoRelativePath,
    publishedVideoRelativePath: result.published.videoRelativePath,
    videoFilename: result.published.videoFilename,
    displayDirectory: result.published.displayDirectory,
    vars: result.internal.vars,
    renderSeconds: result.internal.renderSeconds,
    sourceRenderJobId: snapshot.renderJobId,
  };
  const finishedAt = new Date().toISOString();
  try {
    db.transaction(() => {
      registerPackagedArtifact(db, { projectId: job.projectId, sourceJobId: job.id, target: result.published, createdAt: finishedAt, kind: snapshot.exportTarget ? 'final_video' : 'packaged_video' });
      db.prepare(`UPDATE final_edit_jobs SET status='succeeded', phase='succeeded', progress=1, outputJson=?, errorCode=NULL, errorMessage=NULL, finishedAt=? WHERE id=?`).run(JSON.stringify(output), finishedAt, job.id);
    })();
  } catch (error) {
    await deletePackagedPublish(storageRoot, result.published);
    throw error;
  }
}
