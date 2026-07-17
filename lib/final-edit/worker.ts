import path from 'node:path';
import { getDb } from '../db';
import { dataRoot } from '../data-root';
import { renderFinalEditSnapshot, type FinalEditRenderSnapshot } from './renderer';
import { runFinalEditHeavyJob } from './heavy-job-lock';

let running = false;
let recovered = false;

async function drain() {
  if (running) return;
  running = true;
  const db = getDb();
  try {
    if (!recovered) {
      db.prepare(`UPDATE final_edit_jobs SET status='queued', phase='recovered_after_restart', startedAt=NULL WHERE kind='render' AND status='running'`).run();
      recovered = true;
    }
    while (true) {
      const job = db.prepare(`SELECT id, inputSnapshotJson FROM final_edit_jobs WHERE kind='render' AND status='queued' ORDER BY createdAt LIMIT 1`).get() as { id: string; inputSnapshotJson: string } | undefined;
      if (!job) break;
      const claimed = db.prepare(`UPDATE final_edit_jobs SET status='running', phase='preflight', progress=0, startedAt=? WHERE id=? AND status='queued'`).run(new Date().toISOString(), job.id);
      if (!claimed.changes) continue;
      try {
        const snapshot = JSON.parse(job.inputSnapshotJson) as FinalEditRenderSnapshot;
        db.prepare(`UPDATE final_edit_jobs SET phase='rendering', progress=0.05 WHERE id=?`).run(job.id);
        const result = await runFinalEditHeavyJob(() => renderFinalEditSnapshot({ jobId: job.id, storageRoot: path.join(dataRoot(), 'storage'), snapshot, onProgress: (progress) => db.prepare(`UPDATE final_edit_jobs SET progress=? WHERE id=?`).run(0.05 + progress * 0.9, job.id) }));
        db.transaction(() => {
          db.prepare(`UPDATE final_edit_jobs SET status='succeeded', phase='succeeded', progress=1, outputJson=?, errorCode=NULL, errorMessage=NULL, finishedAt=? WHERE id=?`).run(JSON.stringify(result), new Date().toISOString(), job.id);
          db.prepare(`UPDATE final_edit_variants SET lastRenderedRevision=? WHERE id=?`).run(snapshot.variantRevision, snapshot.variant.id);
        })();
      } catch (error) {
        db.prepare(`UPDATE final_edit_jobs SET status='failed', phase='failed', errorCode='render_failed', errorMessage=?, finishedAt=? WHERE id=?`).run(error instanceof Error ? error.message.slice(0, 1500) : String(error).slice(0, 1500), new Date().toISOString(), job.id);
      }
    }
  } finally { running = false; }
}

export function wakeFinalEditWorker() { setTimeout(() => void drain(), 0); }
