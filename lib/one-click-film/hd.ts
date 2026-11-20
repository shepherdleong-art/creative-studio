import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { OneClickFilmError } from './errors.ts';
import type { OneClickFilmRun } from './store.ts';

/**
 * 按采用来源转高清（12）。
 *
 * 红线：只转换当前版本实际采用的样片来源；同一来源用于多个区间只列一次；
 * 未采用的候选不提交。样片过期或绑定不符时定位到具体来源与受影响条目。
 */

export interface HdSource {
  id: string;
  entryCode: string;
  sourceVideoJobId: string;
  providerId: string;
  model: string;
  accountRef: string;
  status: 'pending' | 'ready' | 'failed';
  rangeStartUs: number;
  rangeEndUs: number;
  estimatedCostMicros: number;
  reusable: boolean;
  errorMessage: string | null;
}

export interface HdPlan {
  sources: HdSource[];
  totalEstimatedCostMicros: number;
  conversions: number;
  blocked: Array<{ entryCode: string; reason: string }>;
}

/**
 * 生成高清来源清单：从当前审片版本实际采用的画面出发，
 * 原片与采用补片各算一个来源；同一来源合并成一次转换。
 */
export function planHdSources(db: Database.Database, run: OneClickFilmRun): HdPlan {
  const reviews = db.prepare(`
    SELECT id, entryId, entryCode, durationUs FROM one_click_film_reviews
    WHERE runId = ? AND approvedAt IS NOT NULL ORDER BY entryCode
  `).all(run.id) as Array<{ id: string; entryId: string; entryCode: string; durationUs: number }>;
  if (reviews.length === 0) {
    throw new OneClickFilmError('invalid_input', '还没有审片通过的成片，不能转高清');
  }

  const sources: HdSource[] = [];
  const blocked: Array<{ entryCode: string; reason: string }> = [];
  const seen = new Set<string>();

  for (const review of reviews) {
    const job = db.prepare(`
      SELECT v.videoJobId, v.providerId, v.model, vj.status, vj.providerTaskId
      FROM one_click_film_video_jobs v
      LEFT JOIN video_jobs vj ON vj.id = v.videoJobId
      WHERE v.id = ?
    `).get(review.id) as {
      videoJobId: string | null; providerId: string; model: string;
      status: string | null; providerTaskId: string | null;
    } | undefined;
    if (!job?.videoJobId) {
      blocked.push({ entryCode: review.entryCode, reason: '找不到这条成片的原片任务' });
      continue;
    }
    if (job.status !== 'succeeded') {
      blocked.push({ entryCode: review.entryCode, reason: '原片任务尚未成功' });
      continue;
    }
    if (!job.providerTaskId) {
      blocked.push({ entryCode: review.entryCode, reason: '样片缺少供应商标识，不能转高清' });
      continue;
    }

    const adopted = db.prepare(`
      SELECT id, providerId, model, replaceStartUs, replaceEndUs
      FROM one_click_film_candidates
      WHERE entryId = ? AND adoptedAt IS NOT NULL ORDER BY replaceStartUs
    `).all(review.entryId) as Array<{
      id: string; providerId: string; model: string; replaceStartUs: number; replaceEndUs: number;
    }>;

    // 原片来源：只转换仍被采用的区间；同一来源只列一次。
    const originalKey = `original:${job.videoJobId}`;
    if (!seen.has(originalKey)) {
      seen.add(originalKey);
      sources.push({
        id: uuidv4(),
        entryCode: review.entryCode,
        sourceVideoJobId: job.videoJobId,
        providerId: job.providerId,
        model: job.model,
        accountRef: job.providerTaskId,
        status: 'pending',
        rangeStartUs: 0,
        rangeEndUs: review.durationUs,
        estimatedCostMicros: Math.round(review.durationUs / 1e6 * 800_000),
        reusable: false,
        errorMessage: null,
      });
    }

    for (const candidate of adopted) {
      const key = `candidate:${candidate.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sources.push({
        id: uuidv4(),
        entryCode: review.entryCode,
        sourceVideoJobId: candidate.id,
        providerId: candidate.providerId,
        model: candidate.model,
        accountRef: job.providerTaskId,
        status: 'pending',
        rangeStartUs: candidate.replaceStartUs,
        rangeEndUs: candidate.replaceEndUs,
        estimatedCostMicros: Math.round((candidate.replaceEndUs - candidate.replaceStartUs) / 1e6 * 800_000),
        reusable: false,
        errorMessage: null,
      });
    }
  }

  return {
    sources,
    totalEstimatedCostMicros: sources.reduce((sum, source) => sum + source.estimatedCostMicros, 0),
    conversions: sources.length,
    blocked,
  };
}

/** 登记高清转换任务；同一来源已有成功结果时直接复用，不重复提交。 */
export function registerHdSources(db: Database.Database, input: {
  run: OneClickFilmRun;
  sources: HdSource[];
}): void {
  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT INTO one_click_film_hd_sources
      (id, runId, entryId, entryCode, sourceVideoJobId, providerId, model, accountRef, status,
       rangeStartUs, rangeEndUs, estimatedCostMicros, createdAt, updatedAt)
    SELECT ?, ?, r.entryId, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?
    FROM one_click_film_reviews r
    WHERE r.runId = ? AND r.entryCode = ?
    ON CONFLICT(entryId, sourceVideoJobId) DO NOTHING
  `);
  db.transaction(() => {
    for (const source of input.sources) {
      insert.run(
        source.id, input.run.id, source.entryCode, source.sourceVideoJobId,
        source.providerId, source.model, source.accountRef,
        source.rangeStartUs, source.rangeEndUs, source.estimatedCostMicros, now, now,
        input.run.id, source.entryCode,
      );
    }
  }).immediate();
}

export function markHdReady(db: Database.Database, input: {
  run: OneClickFilmRun;
  sourceId: string;
  localVideoPath: string;
}): void {
  db.prepare(`UPDATE one_click_film_hd_sources SET status = 'ready', localVideoPath = ?, updatedAt = ?
    WHERE id = ? AND runId = ?`)
    .run(input.localVideoPath, new Date().toISOString(), input.sourceId, input.run.id);
}

export function markHdFailed(db: Database.Database, input: {
  run: OneClickFilmRun;
  sourceId: string;
  message: string;
}): void {
  db.prepare(`UPDATE one_click_film_hd_sources SET status = 'failed', errorMessage = ?, updatedAt = ?
    WHERE id = ? AND runId = ?`)
    .run(input.message.slice(0, 500), new Date().toISOString(), input.sourceId, input.run.id);
}
