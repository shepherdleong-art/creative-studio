import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { createVideoJobsForShot } from '../video-job-create.ts';
import { getFilmPreview, readFilmBody, readyHdPaths, sourceIdsForBody } from './composition.ts';
import { OneClickFilmError } from './errors.ts';
import { startOneClickFilmVideoQueue } from './generation.ts';
import type { OneClickFilmRun } from './store.ts';
import { listEntries } from './store.ts';
import type { HdPlan } from './hd.ts';
import { estimateFrozenVideoCost } from './video-models.ts';

interface SourceJob {
  id: string; providerId: string; model: string; providerTaskId: string | null; durationSec: number;
  shotId: string; shotSetId: string; aspectRatio: string | null; startedAt: string | null; enabled: number;
  defaultModel: string; filmGenerationStage: string | null;
  usageSnapshotJson: string | null;
}

function sourceJob(db: Database.Database, run: OneClickFilmRun, id: string): SourceJob | undefined {
  return db.prepare(`
    SELECT j.*, p.enabled, p.defaultModel FROM video_jobs j JOIN video_providers p ON p.id=j.providerId
    WHERE j.id=? AND j.projectId=? AND j.status='succeeded'
  `).get(id, run.projectId) as SourceJob | undefined;
}

export function currentHdPlan(db: Database.Database, run: OneClickFilmRun): HdPlan {
  const plan: HdPlan = { sources: [], blocked: [], conversions: 0, totalEstimatedCostMicros: 0 };
  for (const entry of listEntries(db, run.id)) {
    const body = readFilmBody(db, run, entry.code);
    if (!body?.approved || !body.draft) continue;
    for (const id of sourceIdsForBody(body)) {
      const source = sourceJob(db, run, id);
      const previous = db.prepare(`
        SELECT h.id, h.status, COALESCE(h.errorMessage,j.errorMessage) AS errorMessage, j.status AS queueStatus
        FROM one_click_film_hd_sources h LEFT JOIN video_jobs j ON j.id=h.hdVideoJobId
        WHERE h.runId=? AND h.entryId=? AND h.sourceVideoJobId=?
      `).get(run.id, body.entryId, id) as {
        id: string; status: 'pending' | 'failed' | 'ready'; errorMessage: string | null; queueStatus: string | null;
      } | undefined;
      const reusable = previous?.status === 'ready';
      const blocked = !reusable && (!source?.providerTaskId || source.filmGenerationStage !== 'draft'
        || !source.enabled || source.model !== source.defaultModel || !source.startedAt
        || Date.now() - new Date(source.startedAt).getTime() >= 7 * 86_400_000);
      if (blocked) plan.blocked.push({ entryCode: entry.code, reason: `来源 ${id.slice(0, 8)} 的样片已过期或原通道不可用` });
      if (!source) continue;
      const estimatedCostMicros = reusable ? 0 : estimateFrozenVideoCost(source.usageSnapshotJson, source.durationSec);
      if (!reusable && !blocked) {
        plan.conversions += 1;
        plan.totalEstimatedCostMicros += estimatedCostMicros ?? 0;
      }
      plan.sources.push({
        id: previous?.id || id, entryCode: entry.code, sourceVideoJobId: id,
        providerId: source.providerId, model: source.model, accountRef: source.providerId,
        status: previous?.status ?? 'pending', rangeStartUs: 0, rangeEndUs: source.durationSec * 1e6,
        estimatedCostMicros, reusable, errorMessage: previous?.errorMessage ?? null, needsCheck: previous?.queueStatus === 'needs_check',
      });
    }
  }
  return plan;
}

export async function submitHdConversions(db: Database.Database, run: OneClickFilmRun, entryCode: string): Promise<void> {
  const body = readFilmBody(db, run, entryCode);
  if (!body?.draft || !body.approved) throw new OneClickFilmError('invalid_input', '请先将当前样片标记为审片通过');
  const plan = currentHdPlan(db, run);
  const blocked = plan.blocked.find((item) => item.entryCode === entryCode);
  if (blocked) throw new OneClickFilmError('invalid_input', blocked.reason);
  for (const item of plan.sources.filter((source) => source.entryCode === entryCode && !source.reusable)) {
    const source = sourceJob(db, run, item.sourceVideoJobId)!;
    const existing = db.prepare(`
      SELECT id, hdVideoJobId, status FROM one_click_film_hd_sources WHERE entryId=? AND sourceVideoJobId=?
    `).get(body.entryId, source.id) as { id: string; hdVideoJobId: string | null; status: string } | undefined;
    if (existing?.hdVideoJobId && existing.status === 'pending') continue;
    const result = await createVideoJobsForShot({
      db, shotSetId: source.shotSetId, shotId: source.shotId,
      items: [{
        providerId: source.providerId, prompt: '采用已绑定的样片转高清',
        durationSec: source.durationSec, templateId: null, tailImageId: null, multiShot: null,
        generationMode: 'image-to-video', aspectRatio: source.aspectRatio, resolution: '1080p', referenceAssetIds: [],
        filmGenerationStage: 'final-from-draft', filmDraftSourceJobId: source.id,
      }],
    });
    if (!result.ok) throw new OneClickFilmError('invalid_input', result.error);
    db.prepare(`
      INSERT INTO one_click_film_hd_sources
        (id,runId,entryId,entryCode,sourceVideoJobId,providerId,model,accountRef,status,
         hdVideoJobId,rangeStartUs,rangeEndUs,estimatedCostMicros,createdAt,updatedAt)
      VALUES (?,?,?,?,?,?,?,?,'pending',?,0,?,?,datetime('now'),datetime('now'))
      ON CONFLICT(entryId,sourceVideoJobId) DO UPDATE SET status='pending', localVideoPath='',
        errorMessage=NULL, hdVideoJobId=excluded.hdVideoJobId, updatedAt=excluded.updatedAt
    `).run(uuidv4(), run.id, body.entryId, entryCode, source.id, source.providerId, source.model, source.providerId,
      result.videoJobIds[0], item.rangeEndUs, item.estimatedCostMicros ?? 0);
  }
  startOneClickFilmVideoQueue(db, run.projectId);
}

export function syncHdConversions(db: Database.Database, run: OneClickFilmRun): void {
  const rows = db.prepare(`
    SELECT h.id,j.localVideoPath,j.status,j.errorMessage FROM one_click_film_hd_sources h
    JOIN video_jobs j ON j.id=h.hdVideoJobId WHERE h.runId=? AND h.status='pending' AND j.status IN ('succeeded','failed','canceled')
  `).all(run.id) as Array<{ id: string; status: string; localVideoPath: string | null; errorMessage: string | null }>;
  for (const row of rows) {
    const ready = row.status === 'succeeded' && row.localVideoPath;
    db.prepare("UPDATE one_click_film_hd_sources SET status=?,localVideoPath=?,errorMessage=?,updatedAt=datetime('now') WHERE id=?")
      .run(ready ? 'ready' : 'failed', row.localVideoPath ?? '', ready ? null : row.errorMessage || '样片转高清失败', row.id);
  }
}

export async function approveHd(db: Database.Database, run: OneClickFilmRun, entryCode: string): Promise<void> {
  const body = readFilmBody(db, run, entryCode);
  if (!body?.approved || !body.draft || readyHdPaths(db, run, body).size !== sourceIdsForBody(body).length) {
    throw new OneClickFilmError('invalid_input', '当前成片的高清来源还没有全部完成');
  }
  await getFilmPreview(db, run, body, true);
  if (readFilmBody(db, run, entryCode)?.signature !== body.signature) {
    throw new OneClickFilmError('invalid_input', '当前剪辑已变更，请复核最新高清结果');
  }
  db.prepare('UPDATE one_click_film_reviews SET hdApprovedSignature=? WHERE runId=? AND id=?')
    .run(body.signature, run.id, body.jobId);
}
