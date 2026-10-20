import type Database from 'better-sqlite3';
import { isDeepStrictEqual } from 'node:util';
import { FinalEditError } from '../errors.ts';
import type { FilmContent } from './content.ts';
import type { VideoTimeline } from '../types.ts';
import { filmBinding } from './store.ts';
import { projectFilmTimeline } from './timeline.ts';

export interface FilmContentProposalInput { requestId: string; expectedRevision: number; summary: string; content: FilmContent }
export function proposeFilmContent(db: Database.Database, groupId: string, input: FilmContentProposalInput, actor: 'human' | 'agent') {
  if (!input || typeof input.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(input.requestId) || !Number.isSafeInteger(input.expectedRevision) || typeof input.summary !== 'string' || !input.summary.trim() || input.summary.length > 1000 || !input.content) throw new FinalEditError('film_proposal_invalid', '提案需要稳定请求 ID、当前编辑版本、修改说明和完整内容', 400);
  const binding = filmBinding(db, groupId);
  if (!binding) throw new FinalEditError('film_not_found', '实拍成片不存在', 404);
  const id = `film:${input.requestId}`;
  return db.transaction(() => {
    const previous = db.prepare('SELECT variantId,kind,proposalJson FROM final_edit_proposals WHERE id=?').get(id) as { variantId: string; kind: string; proposalJson: string } | undefined;
    const payload = { ...input, actor };
    if (previous) {
      if (previous.variantId !== binding.variantId || previous.kind !== 'film-content' || !isDeepStrictEqual(JSON.parse(previous.proposalJson), payload)) throw new FinalEditError('request_conflict', '请求 ID 已用于不同提案，不能覆盖', 409);
      return { id, variantId: binding.variantId, baseRevision: input.expectedRevision };
    }
    const variant = db.prepare('SELECT revision,timelineJson FROM final_edit_variants WHERE id=?').get(binding.variantId) as { revision: number; timelineJson: string };
    if (variant.revision !== input.expectedRevision) throw new FinalEditError('revision_conflict', '草稿已变化，请读取当前版本后重新设计提案', 409);
    const timeline = JSON.parse(variant.timelineJson) as VideoTimeline;
    timeline.filmContent = structuredClone(input.content);
    projectFilmTimeline(JSON.parse(binding.specJson), timeline, JSON.parse(binding.candidatesJson));
    db.prepare("INSERT INTO final_edit_proposals (id,variantId,baseRevision,kind,proposalJson,issuesJson,status,createdAt) VALUES (?,?,?,'film-content',?,'[]','ready',?)").run(id, binding.variantId, variant.revision, JSON.stringify(payload), new Date().toISOString());
    return { id, variantId: binding.variantId, baseRevision: input.expectedRevision };
  }).immediate();
}
