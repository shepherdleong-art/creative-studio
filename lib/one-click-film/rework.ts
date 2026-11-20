import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { OneClickFilmError } from './errors.ts';
import type { OneClickFilmRun } from './store.ts';
import { videoJobFileUrl } from './generation.ts';
import { readReviewScene, type ReviewState } from './review.ts';
import { FINAL_EDIT_FPS, sourceFrameLimit } from '../media-core/render-contract.ts';

/**
 * 局部返工与版本（09–10）。
 *
 * 红线：采用只替换所选区间的等长画面，整条连续音轨与前后镜头位置保持一致；
 * 候选按镜头收录，撤销/恢复各自形成独立版本，其他成片不受影响。
 */

export type ReworkPurpose = 'appearance' | 'person' | 'action' | 'camera' | 'scene';

export const REWORK_PURPOSE_LABELS: Record<ReworkPurpose, string> = {
  appearance: '产品外观',
  person: '人物形象',
  action: '动作',
  camera: '运镜',
  scene: '场景',
};

export interface ReworkReference {
  id: string;
  kind: 'image' | 'video';
  purpose: ReworkPurpose;
  label: string;
}

export interface ReworkCandidate {
  id: string;
  entryCode: string;
  reviewJobId: string;
  reviewSourceId: string | null;
  shotId: string;
  replaceStartUs: number;
  replaceEndUs: number;
  requestedRangeUs: number;
  prompt: string;
  references: ReworkReference[];
  providerId: string;
  model: string;
  status: 'queued' | 'running' | 'ready' | 'failed' | 'needs_check';
  trimStartUs: number;
  durationUs: number;
  adopted: boolean;
  videoUrl: string | null;
  errorMessage: string | null;
  createdAt: string;
}

interface CandidateRow {
  id: string;
  entryId: string;
  entryCode: string;
  reviewJobId: string;
  reviewSourceId: string | null;
  shotId: string;
  replaceStartUs: number;
  replaceEndUs: number;
  requestedRangeUs: number;
  prompt: string;
  referencesJson: string;
  providerId: string;
  model: string;
  status: ReworkCandidate['status'];
  trimStartUs: number;
  localVideoPath: string;
  durationUs: number;
  adoptedAt: string | null;
  errorMessage: string | null;
  createdAt: string;
  queueStatus?: string | null;
  queueError?: string | null;
}

function parseReferences(value: string): ReworkReference[] {
  try {
    const parsed: unknown = JSON.parse(value || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const record = item as Record<string, unknown>;
      const id = typeof record.id === 'string' ? record.id : '';
      if (!id) return [];
      const purpose = (['appearance', 'person', 'action', 'camera', 'scene'] as const)
        .includes(record.purpose as never) ? record.purpose as ReworkPurpose : 'appearance';
      return [{
        id,
        kind: record.kind === 'video' ? 'video' as const : 'image' as const,
        purpose,
        label: typeof record.label === 'string' ? record.label : '',
      }];
    });
  } catch {
    return [];
  }
}

function toCandidate(row: CandidateRow): ReworkCandidate {
  return {
    id: row.id,
    entryCode: row.entryCode,
    reviewJobId: row.reviewJobId,
    reviewSourceId: row.reviewSourceId,
    shotId: row.shotId,
    replaceStartUs: row.replaceStartUs,
    replaceEndUs: row.replaceEndUs,
    requestedRangeUs: row.requestedRangeUs,
    prompt: row.prompt,
    references: parseReferences(row.referencesJson),
    providerId: row.providerId,
    model: row.model,
    status: row.queueStatus === 'needs_check' && (row.status === 'queued' || row.status === 'running') ? 'needs_check' : row.status,
    trimStartUs: row.trimStartUs,
    durationUs: row.durationUs,
    adopted: Boolean(row.adoptedAt),
    videoUrl: row.status === 'ready' ? videoJobFileUrl(row.localVideoPath) : null,
    errorMessage: row.errorMessage ?? row.queueError ?? null,
    createdAt: row.createdAt,
  };
}

export function listCandidates(db: Database.Database, run: OneClickFilmRun): ReworkCandidate[] {
  return (db.prepare(`SELECT c.*, j.status AS queueStatus, j.errorMessage AS queueError
    FROM one_click_film_candidates c LEFT JOIN video_jobs j ON j.id=c.videoJobId
    WHERE c.runId = ? ORDER BY c.createdAt ASC`)
    .all(run.id) as CandidateRow[]).map(toCandidate);
}

/**
 * 记录候选计划：明确区分「要换的区间」「送模型的生成范围」与「计划采用的区间」。
 * 通道最小时长超过选区时，生成范围按最小可生成长度扩展，并如实展示。
 */
export function createCandidate(db: Database.Database, input: {
  run: OneClickFilmRun;
  entryId: string;
  entryCode: string;
  reviewJobId: string;
  reviewSourceId?: string | null;
  shotId: string;
  replaceStartUs: number;
  replaceEndUs: number;
  minimumGenerationUs?: number;
  prompt: string;
  references: ReworkReference[];
  providerId: string;
  model: string;
  requestKey?: string;
}): ReworkCandidate {
  // 归属以数据库为准：不接受客户端自称的条目身份。
  const owned = db.prepare(`SELECT id, code FROM one_click_film_entries WHERE id = ? AND runId = ?`)
    .get(input.entryId, input.run.id) as { id: string; code: string } | undefined;
  if (!owned || owned.code !== input.entryCode) {
    throw new OneClickFilmError('not_found', '成片条目不属于当前项目', 404);
  }
  if (input.replaceEndUs <= input.replaceStartUs) throw new OneClickFilmError('invalid_input', '要替换的区间无效');
  const selectedUs = input.replaceEndUs - input.replaceStartUs;
  const requestedRangeUs = Math.max(selectedUs, Math.round(input.minimumGenerationUs ?? selectedUs));
  const now = new Date().toISOString();
  const id = uuidv4();
  db.prepare(`
    INSERT INTO one_click_film_candidates
      (id, runId, projectId, entryId, entryCode, reviewJobId, shotId, replaceStartUs, replaceEndUs,
       requestedRangeUs, prompt, referencesJson, providerId, model, status, createdAt, updatedAt, requestKey, reviewSourceId)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)
  `).run(
    id, input.run.id, input.run.projectId, input.entryId, input.entryCode, input.reviewJobId,
    input.shotId, input.replaceStartUs, input.replaceEndUs, requestedRangeUs,
    input.prompt.slice(0, 8000), JSON.stringify(input.references), input.providerId, input.model,
    now, now, input.requestKey ?? null, input.reviewSourceId ?? null,
  );
  return listCandidates(db, input.run).find((candidate) => candidate.id === id)!;
}

export function setCandidateResult(db: Database.Database, input: {
  run: OneClickFilmRun;
  candidateId: string;
  status: Exclude<ReworkCandidate['status'], 'needs_check'>;
  localVideoPath?: string;
  durationUs?: number;
  errorMessage?: string;
}): void {
  const row = db.prepare(`SELECT id FROM one_click_film_candidates WHERE id = ? AND runId = ?`)
    .get(input.candidateId, input.run.id);
  if (!row) throw new OneClickFilmError('not_found', '候选不存在', 404);
  db.prepare(`
    UPDATE one_click_film_candidates
    SET status = ?, localVideoPath = COALESCE(?, localVideoPath), durationUs = COALESCE(?, durationUs),
        errorMessage = ?, updatedAt = ?
    WHERE id = ?
  `).run(
    input.status, input.localVideoPath ?? null, input.durationUs ?? null,
    input.errorMessage?.slice(0, 500) ?? null, new Date().toISOString(), input.candidateId,
  );
}

export function setCandidateTrim(db: Database.Database, input: {
  run: OneClickFilmRun;
  candidateId: string;
  trimStartUs: number;
}): void {
  const row = db.prepare(`SELECT * FROM one_click_film_candidates
    WHERE id = ? AND runId = ?`).get(input.candidateId, input.run.id) as CandidateRow | undefined;
  if (!row) throw new OneClickFilmError('not_found', '候选不存在', 404);
  if (row.adoptedAt && row.trimStartUs !== input.trimStartUs) throw new OneClickFilmError('invalid_input', '请先撤销采用，再调整候选入点');
  if (!candidateFits(row, input.trimStartUs)) {
    throw new OneClickFilmError('invalid_input', '候选截取起点超出可用范围，请重新生成更长的补片');
  }
  db.prepare(`UPDATE one_click_film_candidates SET trimStartUs = ?, updatedAt = ? WHERE id = ?`)
    .run(input.trimStartUs, new Date().toISOString(), input.candidateId);
}

export function candidateFits(row: Pick<CandidateRow, 'replaceStartUs' | 'replaceEndUs' | 'durationUs' | 'shotId'>, trimUs: number): boolean {
  const frame = (us: number) => Math.round(us * FINAL_EDIT_FPS / 1e6);
  const length = frame(row.replaceEndUs) - frame(row.replaceStartUs);
  return Number.isSafeInteger(trimUs) && trimUs >= 0 && (row.shotId !== 'whole' || trimUs === 0)
    && length > 0 && frame(trimUs) + length <= sourceFrameLimit(row.durationUs);
}

function nextVersion(db: Database.Database, entryId: string): number {
  return ((db.prepare(`SELECT MAX(versionNumber) AS v FROM one_click_film_versions WHERE entryId = ?`)
    .get(entryId) as { v: number | null }).v ?? 0) + 1;
}

function snapshotState(db: Database.Database, run: OneClickFilmRun, entryId: string, reviewJobId?: string): Record<string, unknown> {
  const candidates = db.prepare(`SELECT id, shotId, replaceStartUs, replaceEndUs, trimStartUs, localVideoPath
    FROM one_click_film_candidates WHERE runId = ? AND entryId = ? AND adoptedAt IS NOT NULL ORDER BY replaceStartUs`)
    .all(run.id, entryId) as Array<Record<string, unknown>>;
  return { reviewJobId, adopted: candidates };
}

/**
 * 采用候选：只换选区的等长画面。生成候选若长于选区，按 trimStartUs 截取等长片段。
 */
export function adoptCandidate(db: Database.Database, input: {
  run: OneClickFilmRun;
  candidateId: string;
  trimStartUs?: number;
}): void {
  db.transaction(() => {
    const row = db.prepare(`SELECT * FROM one_click_film_candidates WHERE id = ? AND runId = ?`)
      .get(input.candidateId, input.run.id) as CandidateRow | undefined;
    if (!row) throw new OneClickFilmError('not_found', '候选不存在', 404);
    if (row.status !== 'ready' || !row.localVideoPath) {
      throw new OneClickFilmError('invalid_input', '候选还没生成完成，不能采用');
    }
    const trimStartUs = input.trimStartUs ?? row.trimStartUs;
    if (row.adoptedAt && row.trimStartUs === trimStartUs) return;
    const review = db.prepare('SELECT id,durationUs,shotsJson,detection,detectionError,supersededAt FROM one_click_film_reviews WHERE id=? AND runId=? AND entryId=?')
      .get(row.reviewJobId, input.run.id, row.entryId) as {
        id: string; durationUs: number; shotsJson: string; detection: ReviewState['detection']; detectionError: string | null;
        supersededAt: string | null;
      } | undefined;
    if (review) {
      if (review.supersededAt) throw new OneClickFilmError('invalid_input', '当前条目已切换到新的原片');
      const scene = readReviewScene(db, review);
      const matches = row.shotId === 'whole' ? row.replaceStartUs === 0 && row.replaceEndUs === review.durationUs
        : row.reviewSourceId === scene.sourceId && scene.shots.some((shot) =>
          shot.id === row.shotId && shot.startUs === row.replaceStartUs && shot.endUs === row.replaceEndUs);
      if (!matches) throw new OneClickFilmError('invalid_input', '镜头选区已变更，请按当前切点重新生成候选');
    }
    if (!candidateFits(row, trimStartUs)) {
      throw new OneClickFilmError('invalid_input', '候选截取范围无法覆盖当前镜头，请调整入点和出点');
    }
    const now = new Date().toISOString();
    // 同一镜头的旧采用结果让位：一个镜头只保留一个当前采用的画面。
    db.prepare(`UPDATE one_click_film_candidates SET adoptedAt = NULL
      WHERE entryId = ? AND reviewJobId = ? AND adoptedAt IS NOT NULL AND replaceStartUs < ? AND replaceEndUs > ?
        AND (?='whole' OR shotId<>'whole')`)
      .run(row.entryId, row.reviewJobId, row.replaceEndUs, row.replaceStartUs, row.shotId);
    db.prepare(`UPDATE one_click_film_candidates SET adoptedAt = ?, trimStartUs = ?, updatedAt = ? WHERE id = ?`)
      .run(now, trimStartUs, now, row.id);
    db.prepare('UPDATE one_click_film_reviews SET approvedAt=NULL, hdApprovedSignature=NULL WHERE id=? AND runId=?')
      .run(row.reviewJobId, input.run.id);
    db.prepare(`
      INSERT INTO one_click_film_versions (id, runId, entryId, entryCode, versionNumber, source, stateJson, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      uuidv4(), input.run.id, row.entryId, row.entryCode, nextVersion(db, row.entryId),
      row.shotId === 'whole' ? 'redraw' : 'candidate',
      JSON.stringify(snapshotState(db, input.run, row.entryId, row.reviewJobId)), now,
    );
  }).immediate();
}

/** 撤销采用：回到该镜头的原片；恢复则重新采用指定候选。 */
export function revertAdoption(db: Database.Database, input: {
  run: OneClickFilmRun;
  entryId: string;
  entryCode: string;
  shotId: string;
}): void {
  const owned = db.prepare(`SELECT id FROM one_click_film_entries WHERE id = ? AND runId = ? AND code = ?`)
    .get(input.entryId, input.run.id, input.entryCode);
  if (!owned) throw new OneClickFilmError('not_found', '成片条目不属于当前项目', 404);
  const now = new Date().toISOString();
  db.transaction(() => {
    const reviewJobId = db.prepare('SELECT id FROM one_click_film_reviews WHERE entryId=? AND runId=? AND supersededAt IS NULL')
      .pluck().get(input.entryId, input.run.id) as string | undefined;
    const changed = db.prepare(`UPDATE one_click_film_candidates SET adoptedAt=NULL
      WHERE entryId=? AND reviewJobId=? AND (shotId=? OR ?='whole') AND adoptedAt IS NOT NULL`)
      .run(input.entryId, reviewJobId ?? '', input.shotId, input.shotId);
    if (!changed.changes) return;
    db.prepare('UPDATE one_click_film_reviews SET approvedAt=NULL, hdApprovedSignature=NULL WHERE entryId=? AND runId=?')
      .run(input.entryId, input.run.id);
    db.prepare(`
      INSERT INTO one_click_film_versions (id, runId, entryId, entryCode, versionNumber, source, stateJson, createdAt)
      VALUES (?, ?, ?, ?, ?, 'restore', ?, ?)
    `).run(
      uuidv4(), input.run.id, input.entryId, input.entryCode, nextVersion(db, input.entryId),
      JSON.stringify(snapshotState(db, input.run, input.entryId, reviewJobId)), now,
    );
  }).immediate();
}

export interface FilmVersion {
  id: string;
  versionNumber: number;
  source: 'original' | 'candidate' | 'redraw' | 'restore';
  createdAt: string;
  adopted: Array<{ id: string; shotId: string; replaceStartUs: number; replaceEndUs: number }>;
}

export function listVersions(db: Database.Database, run: OneClickFilmRun, entryId: string): FilmVersion[] {
  return (db.prepare(`SELECT * FROM one_click_film_versions WHERE runId = ? AND entryId = ? ORDER BY versionNumber`)
    .all(run.id, entryId) as Array<{
      id: string; versionNumber: number; source: FilmVersion['source']; createdAt: string; stateJson: string;
    }>).map((row) => {
    let adopted: FilmVersion['adopted'] = [];
    try {
      const parsed = JSON.parse(row.stateJson) as { adopted?: unknown };
      if (Array.isArray(parsed.adopted)) adopted = parsed.adopted as FilmVersion['adopted'];
    } catch { adopted = []; }
    return {
      id: row.id, versionNumber: row.versionNumber, source: row.source, createdAt: row.createdAt, adopted,
    };
  });
}

/** Restore exactly the saved candidate trim and review state for the current original. */
export function restoreFilmVersion(db: Database.Database, run: OneClickFilmRun, reviewJobId: string, versionId: string): void {
  db.transaction(() => {
    const review = db.prepare(`SELECT id,entryId,entryCode,shotsJson,durationUs,detection,detectionError FROM one_click_film_reviews
      WHERE id=? AND runId=? AND supersededAt IS NULL`).get(reviewJobId, run.id) as {
      id: string; entryId: string; entryCode: string; shotsJson: string; durationUs: number;
      detection: ReviewState['detection']; detectionError: string | null;
    } | undefined;
    if (!review) throw new OneClickFilmError('not_found', '当前原片不存在', 404);
    const saved = db.prepare('SELECT stateJson FROM one_click_film_versions WHERE id=? AND entryId=? AND runId=?')
      .pluck().get(versionId, review.entryId, run.id) as string | undefined;
    if (!saved) throw new OneClickFilmError('not_found', '找不到这条成片的历史版本', 404);
    const state = JSON.parse(saved) as {
      reviewJobId?: string; adopted: Array<{ id: string; trimStartUs: number }>;
    };
    if (state.reviewJobId !== reviewJobId && (state.reviewJobId || !state.adopted.length)) {
      throw new OneClickFilmError('invalid_input', '该历史版本所用的原片已变更');
    }
    const read = db.prepare(`SELECT * FROM one_click_film_candidates
      WHERE id=? AND reviewJobId=? AND runId=? AND status='ready'`);
    const savedCandidates = state.adopted.map((edit) => read.get(edit.id, reviewJobId, run.id) as CandidateRow | undefined);
    const sourceId = savedCandidates.find((candidate) => candidate?.shotId === 'whole')?.id ?? null;
    const { shots } = readReviewScene(db, review, sourceId);
    for (const [index, edit] of state.adopted.entries()) {
      const candidate = savedCandidates[index];
      const target = candidate?.shotId === 'whole' ? { startUs: 0, endUs: review.durationUs }
        : shots.find((shot) => shot.id === candidate?.shotId);
      if (!candidate || !target || candidate.replaceStartUs !== target.startUs || candidate.replaceEndUs !== target.endUs
        || (candidate.shotId !== 'whole' && candidate.reviewSourceId !== sourceId)
        || !candidateFits(candidate, edit.trimStartUs)) {
        throw new OneClickFilmError('invalid_input', '历史版本的选区或候选已不可用');
      }
    }
    const active = db.prepare(`SELECT id,trimStartUs FROM one_click_film_candidates
      WHERE reviewJobId=? AND adoptedAt IS NOT NULL ORDER BY replaceStartUs`).all(reviewJobId);
    if (JSON.stringify(active) === JSON.stringify(state.adopted.map(({ id, trimStartUs }) => ({ id, trimStartUs })))) return;
    const now = new Date().toISOString();
    db.prepare('UPDATE one_click_film_candidates SET adoptedAt=NULL WHERE reviewJobId=?').run(reviewJobId);
    const adopt = db.prepare('UPDATE one_click_film_candidates SET adoptedAt=?,trimStartUs=? WHERE id=?');
    for (const edit of state.adopted) adopt.run(now, edit.trimStartUs, edit.id);
    db.prepare('UPDATE one_click_film_reviews SET approvedAt=NULL,hdApprovedSignature=NULL WHERE id=?').run(reviewJobId);
    db.prepare(`INSERT INTO one_click_film_versions (id,runId,entryId,entryCode,versionNumber,source,stateJson,createdAt)
      VALUES (?,?,?,?,?,'restore',?,?)`).run(
      uuidv4(), run.id, review.entryId, review.entryCode, nextVersion(db, review.entryId),
      JSON.stringify(snapshotState(db, run, review.entryId, reviewJobId)), now,
    );
  }).immediate();
}

/**
 * 整条重抽的费用估算：按「模型 × 时长 × 账号」列出，提交前让剪辑师看清范围。
 */
export function redrawEstimate(input: {
  model: string;
  providerName: string;
  durationSec: number;
  costPerSecondMicros: number;
}): { model: string; providerName: string; durationSec: number; rangeLabel: string; estimatedCostMicros: number } {
  return {
    model: input.model,
    providerName: input.providerName,
    durationSec: input.durationSec,
    rangeLabel: `整条正文 0–${input.durationSec} 秒`,
    estimatedCostMicros: Math.max(0, Math.round(input.costPerSecondMicros * input.durationSec)),
  };
}
