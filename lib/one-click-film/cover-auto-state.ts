import type Database from 'better-sqlite3';
import type { CoverFraming } from '../media-core/cover-types.ts';
import { fallbackFilmCover, parseFilmCoverMedia, resolveFilmCoverMedia, type FilmCoverMedia } from './cover-media.ts';
import type { FilmBody } from './composition.ts';

type AutoCover = Extract<FilmCoverMedia, { kind: 'auto_frame' }>;

export type FilmAutoCoverFallback = 'no_provider' | 'no_panorama' | 'invalid_result' | 'content_filtered'
  | 'timeout' | 'media_unavailable' | 'request_failed';

export type FilmAutoCoverState = {
  sourceSignature: string;
  attempt: number;
  status: 'pending' | 'ready' | 'fallback';
  media?: AutoCover;
  reason?: FilmAutoCoverFallback;
};

export interface FilmAutoCoverRow {
  attempt: number;
  state: 'queued' | 'started' | 'waiting' | 'ready' | 'fallback';
  principalModule: string;
  principalTaskId: string;
  requestJson: string | null;
  frame: number | null;
  shotId: string | null;
  reason: FilmAutoCoverFallback | null;
}

export function readFilmAutoCoverRow(db: Database.Database, body: FilmBody): FilmAutoCoverRow | undefined {
  return db.prepare('SELECT * FROM one_click_film_auto_covers WHERE entryId=? AND sourceSignature=?')
    .get(body.entryId, body.signature) as FilmAutoCoverRow | undefined;
}

export function readFilmAutoCover(db: Database.Database, body: FilmBody): FilmAutoCoverState {
  const row = db.prepare(`SELECT attempt, state, frame, shotId, reason FROM one_click_film_auto_covers
    WHERE entryId=? AND sourceSignature=?`).get(body.entryId, body.signature) as
      Pick<FilmAutoCoverRow, 'attempt' | 'state' | 'frame' | 'shotId' | 'reason'> | undefined;
  const base = { sourceSignature: body.signature, attempt: row?.attempt ?? 1 };
  if (row?.state === 'ready' && row.frame !== null) {
    return { ...base, status: 'ready', media: {
      kind: 'auto_frame', frame: row.frame, ...(row.shotId && { shotId: row.shotId }), sourceSignature: body.signature,
    } };
  }
  if (row?.state === 'fallback') {
    return { ...base, status: 'fallback', reason: row.reason ?? 'request_failed',
      media: fallbackFilmCover(body.signature) };
  }
  return { ...base, status: 'pending' };
}

export function automaticFilmCoverForDraft(db: Database.Database, body: FilmBody, framing?: CoverFraming): AutoCover {
  const media = readFilmAutoCover(db, body).media ?? fallbackFilmCover(body.signature);
  return { ...media, ...(framing && { framing }) };
}

export function filmCoverChoiceToReconcile(current: FilmCoverMedia | undefined, body: FilmBody, auto: FilmAutoCoverState): FilmCoverMedia | undefined {
  if (current?.kind === 'video_frame') {
    const next = resolveFilmCoverMedia(current, body);
    if (next.kind !== 'video_frame' || next.frame === current.frame) return;
    // The frame still applies to the new body, but an old shot ID might point elsewhere.
    delete next.shotId;
    return next;
  }
  if (current && current.kind !== 'auto_frame') return;
  if (auto.status === 'pending' && (!current || current.sourceSignature === body.signature)) return;
  if (auto.status === 'fallback' && !current) return; // Legacy implicit first frame is already the same choice.
  const next = auto.media ?? fallbackFilmCover(body.signature);
  if (current && current.sourceSignature === next.sourceSignature && current.frame === next.frame
    && current.shotId === next.shotId && current.fallback === next.fallback) return;
  return { ...next, ...(current?.framing && { framing: current.framing }) };
}

export function reconcileFilmCoverChoice(db: Database.Database, body: FilmBody) {
  const row = db.prepare('SELECT id, revision, optionsJson FROM one_click_film_packaging WHERE entryId=?')
    .get(body.entryId) as { id: string; revision: number; optionsJson: string } | undefined;
  if (!row) return;
  const current = parseFilmCoverMedia(JSON.parse(row.optionsJson).coverMedia);
  const next = filmCoverChoiceToReconcile(current, body, readFilmAutoCover(db, body));
  if (!next) return;
  db.prepare(`
    UPDATE one_click_film_packaging
    SET optionsJson=json_set(json_remove(optionsJson,'$.renderedCoverMedia'),'$.coverMedia',json(?)),
      coverClampSignature=?, status='pending', revision=revision+1, errorMessage=NULL, updatedAt=datetime('now')
    WHERE id=? AND revision=?
  `).run(JSON.stringify(next), next.kind === 'video_frame' ? body.signature : null, row.id, row.revision);
}
