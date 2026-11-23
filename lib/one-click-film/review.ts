import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { OneClickFilmError } from './errors.ts';
import type { OneClickFilmRun } from './store.ts';

/**
 * A 布局审片（08）：按来源片帧记录镜头区间。
 *
 * 红线：源文件保持完整，选镜头只记录范围；手动切分/合并只更新区间，
 * 跨来源或非相邻镜头不可合并。识别失败仍保留可播的整条原片。
 */

export interface ReviewShot {
  id: string;
  index: number;
  startUs: number;
  endUs: number;
  origin: 'detected' | 'manual';
  reviewMark: string;
}

export interface ReviewState {
  jobId: string;
  entryCode: string;
  durationUs: number;
  fps: number;
  detection: 'cuts' | 'single' | 'failed';
  detectionError: string | null;
  videoUrl: string | null;
  approved: boolean;
  shots: ReviewShot[];
  reviewSourceId: string | null;
}

interface ReviewRow {
  id: string;
  runId: string;
  videoJobId: string;
  entryCode: string;
  durationUs: number;
  fps: number;
  cutsJson: string;
  detection: string;
  detectionError: string | null;
  shotsJson: string;
  approvedAt: string | null;
}

function ensureReview(db: Database.Database, run: OneClickFilmRun, jobId: string): ReviewRow {
  const existing = db.prepare(`SELECT * FROM one_click_film_reviews WHERE id = ? AND runId = ? AND supersededAt IS NULL`)
    .get(jobId, run.id) as ReviewRow | undefined;
  if (existing) return existing;
  // 记录不存在时区分「不属于本项目」与「还没生成」，避免越权读取他人成片。
  const foreign = db.prepare(`SELECT 1 FROM one_click_film_reviews WHERE id = ?`).get(jobId);
  if (foreign) throw new OneClickFilmError('not_found', '审片记录不属于当前项目', 404);
  throw new OneClickFilmError('not_found', '还没有这条成片的审片记录', 404);
}

export function listReviews(db: Database.Database, run: OneClickFilmRun): ReviewState[] {
  const rows = db.prepare(`SELECT * FROM one_click_film_reviews WHERE runId = ? AND supersededAt IS NULL ORDER BY entryCode`)
    .all(run.id) as ReviewRow[];
  return rows.map((row) => {
    const active = readReviewScene(db, row);
    return {
      jobId: row.id,
      entryCode: row.entryCode,
      durationUs: row.durationUs,
      fps: row.fps,
      detection: active.detection,
      detectionError: active.detectionError,
      videoUrl: null,
      approved: Boolean(row.approvedAt),
      shots: active.shots,
      reviewSourceId: active.sourceId,
    };
  });
}

interface ReviewScene {
  detection: ReviewState['detection'];
  detectionError: string | null;
  shots: ReviewShot[];
}

export function readReviewScene(
  db: Database.Database,
  row: Pick<ReviewRow, 'id' | 'shotsJson' | 'detection' | 'detectionError'>,
  candidateId?: string | null,
): ReviewScene & { sourceId: string | null } {
  const base = candidateId === null ? undefined : db.prepare(`
    SELECT id,sceneJson FROM one_click_film_candidates WHERE reviewJobId=? AND shotId='whole'
    AND (${candidateId === undefined ? 'adoptedAt IS NOT NULL' : 'id=?'})
  `).get(...(candidateId === undefined ? [row.id] : [row.id, candidateId])) as { id: string; sceneJson: string | null } | undefined;
  if (base?.sceneJson) return { ...JSON.parse(base.sceneJson) as ReviewScene, sourceId: base.id };
  return { sourceId: base?.id ?? null, shots: readShots(row), detection: row.detection as ReviewScene['detection'], detectionError: row.detectionError };
}

export function shotsAtCuts(cutsUs: number[], durationUs: number): ReviewShot[] {
  const points = [0, ...cutsUs.filter((cut) => cut > 0 && cut < durationUs), durationUs].sort((left, right) => left - right);
  const unique = [...new Set(points)];
  return unique.slice(0, -1).map((startUs, index) => ({
    id: `s${index + 1}`, index: index + 1, startUs, endUs: unique[index + 1]!, origin: 'detected', reviewMark: '',
  }));
}

/**
 * 由实际切点生成审片记录。切点为空时保留一个完整区间（一镜到底）；
 * 识别失败也保留整条原片，允许手动加切点。
 */
export function upsertReviewFromDetection(db: Database.Database, input: {
  run: OneClickFilmRun;
  jobId: string;
  entryId: string;
  entryCode: string;
  durationUs: number;
  fps: number;
  cutsUs: number[];
  detection: 'cuts' | 'single' | 'failed';
  detectionError?: string | null;
}): void {
  const existing = db.prepare(`SELECT id, shotsJson, approvedAt FROM one_click_film_reviews WHERE id = ? AND runId = ?`)
    .get(input.jobId, input.run.id) as { id: string; shotsJson: string; approvedAt: string | null } | undefined;
  // 已有手动切分/审片结论时，不因重新同步而覆盖剪辑师的工作。
  if (existing?.approvedAt) return;
  if (existing) {
    try {
      const shots = JSON.parse(existing.shotsJson) as Array<{ origin?: string }>;
      if (Array.isArray(shots) && shots.some((shot) => shot.origin === 'manual')) return;
    } catch { /* 脏数据按可重建处理 */ }
  }
  const shots = shotsAtCuts(input.cutsUs, input.durationUs);
  const now = new Date().toISOString();
  db.transaction(() => {
    const latest = db.prepare(`
      SELECT r.id, v.createdAt FROM one_click_film_reviews r
      JOIN one_click_film_video_jobs v ON v.id=r.videoJobId
      WHERE r.runId=? AND r.entryCode=? AND r.supersededAt IS NULL
    `).get(input.run.id, input.entryCode) as { id: string; createdAt: string } | undefined;
    const createdAt = db.prepare('SELECT createdAt FROM one_click_film_video_jobs WHERE id=?').pluck().get(input.jobId) as string | undefined;
    if (latest && latest.id !== input.jobId && createdAt && latest.createdAt > createdAt) return;
    if (latest && latest.id !== input.jobId) db.prepare('UPDATE one_click_film_reviews SET supersededAt=? WHERE id=?').run(now, latest.id);
    db.prepare(`
    INSERT INTO one_click_film_reviews
      (id, runId, videoJobId, entryId, entryCode, durationUs, fps, cutsJson, detection, detectionError,
       shotsJson, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      durationUs = excluded.durationUs, fps = excluded.fps, cutsJson = excluded.cutsJson,
      detection = excluded.detection, detectionError = excluded.detectionError,
      shotsJson = excluded.shotsJson, updatedAt = excluded.updatedAt
    `).run(
      input.jobId, input.run.id, input.jobId, input.entryId, input.entryCode,
      input.durationUs, input.fps, JSON.stringify(input.cutsUs), input.detection,
      input.detectionError ?? null, JSON.stringify(shots), now, now,
    );
  }).immediate();
}

function readShots(row: Pick<ReviewRow, 'shotsJson'>): ReviewShot[] {
  try {
    const parsed: unknown = JSON.parse(row.shotsJson);
    return Array.isArray(parsed) ? parsed as ReviewShot[] : [];
  } catch {
    return [];
  }
}

function writeShots(db: Database.Database, row: ReviewRow, shots: ReviewShot[]): void {
  const scene = readReviewScene(db, row);
  if (scene.sourceId) {
    db.prepare("UPDATE one_click_film_candidates SET sceneJson=?, updatedAt=datetime('now') WHERE id=?")
      .run(JSON.stringify({ detection: scene.detection, detectionError: scene.detectionError, shots }), scene.sourceId);
    return;
  }
  db.prepare(`UPDATE one_click_film_reviews SET shotsJson = ?, updatedAt = ? WHERE id = ?`)
    .run(JSON.stringify(shots), new Date().toISOString(), row.id);
}

function renumber(shots: ReviewShot[]): ReviewShot[] {
  return shots
    .sort((left, right) => left.startUs - right.startUs)
    .map((shot, index) => ({ ...shot, index: index + 1, id: `s${index + 1}` }));
}

export function splitShot(db: Database.Database, input: {
  run: OneClickFilmRun;
  jobId: string;
  shotId: string;
  atUs: number;
}): ReviewShot[] {
  const row = ensureReview(db, input.run, input.jobId);
  const { shots } = readReviewScene(db, row);
  const target = shots.find((shot) => shot.id === input.shotId);
  if (!target) throw new OneClickFilmError('not_found', '找不到要切分的镜头', 404);
  if (!Number.isSafeInteger(input.atUs) || input.atUs <= target.startUs + 100_000 || input.atUs >= target.endUs - 100_000) {
    throw new OneClickFilmError('invalid_input', '切点必须落在镜头内部，且两侧至少保留 0.1 秒');
  }
  assertUnreplacedRange(db, row.id, target.startUs, target.endUs);
  const next = shots.flatMap((shot) => shot.id !== target.id ? [shot] : [
    { ...shot, endUs: input.atUs, origin: 'manual' as const },
    { ...shot, id: '', startUs: input.atUs, origin: 'manual' as const },
  ]);
  const renumbered = renumber(next);
  writeShots(db, row, renumbered);
  return renumbered;
}

export function mergeShots(db: Database.Database, input: {
  run: OneClickFilmRun;
  jobId: string;
  shotIds: string[];
}): ReviewShot[] {
  return db.transaction(() => {
    const row = ensureReview(db, input.run, input.jobId);
    const scene = readReviewScene(db, row);
    const shots = renumber(scene.shots);
    if (input.shotIds.length < 2) throw new OneClickFilmError('invalid_input', '请选择两个相邻镜头再合并');
    const selected = shots.filter((shot) => input.shotIds.includes(shot.id));
    if (selected.length !== input.shotIds.length) throw new OneClickFilmError('not_found', '有镜头不存在');
    for (let index = 1; index < selected.length; index += 1) {
      if (selected[index]!.index !== selected[index - 1]!.index + 1) {
        throw new OneClickFilmError('invalid_input', '只能合并相邻镜头');
      }
    }
    const first = selected[0]!;
    const last = selected.at(-1)!;
    assertUnreplacedRange(db, row.id, first.startUs, last.endUs);
    const merged: ReviewShot = { ...first, endUs: last.endUs, origin: 'manual' };
    const next = shots.filter((shot) => !input.shotIds.includes(shot.id) || shot.id === first.id)
      .map((shot) => (shot.id === first.id ? merged : shot));
    const renumbered = renumber(next);
    db.prepare(`INSERT INTO one_click_film_merge_history (id,reviewJobId,sourceKey,startUs,endUs,priorShotsJson)
      VALUES (?,?,?,?,?,?)`).run(randomUUID(), row.id, scene.sourceId ?? '', first.startUs, last.endUs, JSON.stringify(selected));
    writeShots(db, row, renumbered);
    return renumbered;
  }).immediate();
}

function latestMerge(db: Database.Database, jobId: string, sourceId: string | null, shots: ReviewShot[]) {
  const row = db.prepare(`SELECT id,startUs,endUs,priorShotsJson FROM one_click_film_merge_history
    WHERE reviewJobId=? AND sourceKey=? ORDER BY rowid DESC LIMIT 1`)
    .get(jobId, sourceId ?? '') as { id: string; startUs: number; endUs: number; priorShotsJson: string } | undefined;
  if (!row) return null;
  const shot = shots.find((item) => item.origin === 'manual' && item.startUs === row.startUs && item.endUs === row.endUs);
  return shot ? { ...row, shot } : null;
}

export function undoableMergeId(db: Database.Database, review: ReviewState): string | null {
  const merge = latestMerge(db, review.jobId, review.reviewSourceId, review.shots);
  return merge && !hasAdoptedReplacement(db, review.jobId, merge.startUs, merge.endUs) ? merge.id : null;
}

export function undoMerge(db: Database.Database, input: { run: OneClickFilmRun; jobId: string; mergeId: string }): ReviewShot[] {
  return db.transaction(() => {
    const row = ensureReview(db, input.run, input.jobId);
    const scene = readReviewScene(db, row);
    const merge = latestMerge(db, row.id, scene.sourceId, scene.shots);
    if (!merge || merge.id !== input.mergeId) {
      throw new OneClickFilmError('invalid_input', '当前镜头区间已变更，这次合并无法撤回', 409);
    }
    assertUnreplacedRange(db, row.id, merge.startUs, merge.endUs);
    const originals = JSON.parse(merge.priorShotsJson) as ReviewShot[];
    const restored = originals.map((shot, index) => index === 0 ? { ...shot, reviewMark: merge.shot.reviewMark } : shot);
    const next = renumber(scene.shots.flatMap((shot) => shot.id === merge.shot.id ? restored : [shot]));
    writeShots(db, row, next);
    db.prepare('DELETE FROM one_click_film_merge_history WHERE id=?').run(merge.id);
    return next;
  }).immediate();
}

function hasAdoptedReplacement(db: Database.Database, reviewJobId: string, startUs: number, endUs: number): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM one_click_film_candidates WHERE reviewJobId=? AND shotId<>'whole'
    AND adoptedAt IS NOT NULL AND replaceStartUs<? AND replaceEndUs>?`).get(reviewJobId, endUs, startUs));
}

function assertUnreplacedRange(db: Database.Database, reviewJobId: string, startUs: number, endUs: number): void {
  if (hasAdoptedReplacement(db, reviewJobId, startUs, endUs)) {
    throw new OneClickFilmError('invalid_input', '该选区包含已采用的补片，请先撤销采用再调整切点');
  }
}

export function markShotReview(db: Database.Database, input: {
  run: OneClickFilmRun;
  jobId: string;
  shotId: string;
  mark: string;
}): ReviewShot[] {
  const row = ensureReview(db, input.run, input.jobId);
  const shots = readReviewScene(db, row).shots.map((shot) => (
    shot.id === input.shotId ? { ...shot, reviewMark: input.mark.trim().slice(0, 40) } : shot
  ));
  writeShots(db, row, shots);
  return shots;
}

/** 标记审片通过：直出片取得包装资格，样片进入待转高清。 */
export function approveReview(db: Database.Database, input: {
  run: OneClickFilmRun;
  jobId: string;
}): void {
  ensureReview(db, input.run, input.jobId);
  db.prepare(`UPDATE one_click_film_reviews SET approvedAt = ?, updatedAt = ? WHERE id = ?`)
    .run(new Date().toISOString(), new Date().toISOString(), input.jobId);
}
