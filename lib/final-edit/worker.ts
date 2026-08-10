import path from 'node:path';
import { getDb } from '../db.ts';
import { dataRoot } from '../data-root.ts';
import { renderFinalEditSnapshot, type FinalEditRenderSnapshot } from './renderer.ts';
import { runFinalEditHeavyJob } from './heavy-job-lock.ts';
import { formatShanghaiTaskDate } from './export-identity.ts';
import { resolveProjectExportDirName } from '../project-export-dir.ts';
import { publishReservedExportTarget, reserveProjectExportTarget, restorePublishedExportReservation } from './export-naming.ts';
import { buildPublishedJobOutput, registerPublishedArtifacts } from './project-artifacts.ts';
import { FinalEditError } from './errors.ts';

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
      db.prepare(`UPDATE final_edit_jobs SET status='queued', phase='recovered_after_restart', startedAt=NULL WHERE kind='render' AND status='running'`).run();
      recovered = true;
    }
    while (!shutdownRequested) {
      const job = db.prepare(`SELECT id, projectId, inputSnapshotJson FROM final_edit_jobs WHERE kind='render' AND status='queued' ORDER BY createdAt LIMIT 1`).get() as { id: string; projectId: string; inputSnapshotJson: string } | undefined;
      if (!job) break;
      const claimed = db.prepare(`UPDATE final_edit_jobs SET status='running', phase='preflight', progress=0, startedAt=? WHERE id=? AND status='queued'`).run(new Date().toISOString(), job.id);
      if (!claimed.changes) continue;
      const registration = createFinalEditJobController();
      const controller = registration.controller;
      try {
        if (controller.signal.aborted) throw makeAbortError();
        let snapshot = JSON.parse(job.inputSnapshotJson) as FinalEditRenderSnapshot;
        if (!snapshot.exportIdentity || !snapshot.exportTarget) {
          const project = db.prepare(`SELECT name, productCode, createdAt FROM projects WHERE id=?`).get(job.projectId) as { name: string; productCode: string | null; createdAt: string } | undefined;
          if (!project) throw new FinalEditError('project_not_found', '项目不存在', 404);
          const exportIdentity = {
            projectId: job.projectId,
            taskName: project.name,
            productCode: project.productCode || '',
            taskDate: formatShanghaiTaskDate(project.createdAt),
            exportDirName: resolveProjectExportDirName(db, job.projectId),
          };
          const blockedRelativePaths = new Set((db.prepare(`SELECT relativePath FROM project_artifacts WHERE projectId=?`).all(job.projectId) as Array<{ relativePath: string }>).map((row) => row.relativePath));
          snapshot = { ...snapshot, exportIdentity, exportTarget: reserveProjectExportTarget(path.join(dataRoot(), 'storage'), exportIdentity, { blockedRelativePaths }) };
          db.prepare(`UPDATE final_edit_jobs SET inputSnapshotJson=? WHERE id=? AND status='running'`).run(JSON.stringify(snapshot), job.id);
        }
        db.prepare(`UPDATE final_edit_jobs SET phase='rendering', progress=0.05 WHERE id=?`).run(job.id);
        const storageRoot = path.join(dataRoot(), 'storage');
        const internal = await runFinalEditHeavyJob(() => renderFinalEditSnapshot({ jobId: job.id, storageRoot, snapshot, signal: controller.signal, onProgress: (progress) => db.prepare(`UPDATE final_edit_jobs SET progress=? WHERE id=?`).run(0.05 + progress * 0.8, job.id) }));
        if (controller.signal.aborted) throw makeAbortError();
        db.prepare(`UPDATE final_edit_jobs SET phase='publishing', progress=0.9 WHERE id=?`).run(job.id);
        const exportTarget = snapshot.exportTarget;
        if (!exportTarget) throw new FinalEditError('export_reservation_lost', '渲染快照缺少导出目标');
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
