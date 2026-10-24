import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { BatchDomainError } from '../errors.ts';
import { listAssetSources } from '../media-catalog.ts';
import { applyBatchOutputClipEdit, getBatchOutputArrangementView } from '../output-arrangement.ts';
import { verifyFormulaCandidate, recheckFormulaCandidate } from './candidate-media.ts';
import { parseFormulaAvailableRanges, type FormulaRangeBounds } from './range-contract.ts';
import { readFormulaManualMedia, type FormulaManualMediaProof, type FormulaReplacedSpeechRange } from './manual-media.ts';
import { parseFormulaManualSpeech } from './manual-speech.ts';
import { effectiveFormulaOutputBasis } from './manual-audio-basis.ts';
import { FINAL_EDIT_FPS } from '../../media-core/render-contract.ts';

export type FormulaManualClipEdit = ({ type: 'replace'; clipId: string } | { type: 'insert'; afterClipId: string | null; timelineStartUs?: number }) & {
  assetId: string; expectedOutputVersionId: string; expectedEditRevision: number; requestKey: string;
  media: { contentFingerprint: string; inUs: number; outUs: number; protected: FormulaRangeBounds | null;
    sound: 'mute' | 'source'; segments: unknown[]; confirmed: boolean; speechConfirmed?: boolean; replaceNarrationClipIds?: string[] };
};

/** Probe outside the write transaction; recheck identity + revision, then atomically save proof and edit. */
export async function applyFormulaManualClipEdit(db: Database.Database, projectId: string, batchId: string, planId: string,
  input: FormulaManualClipEdit, signal = new AbortController().signal) {
  if (!input || !['replace', 'insert'].includes(input.type) || typeof input.requestKey !== 'string' || !input.requestKey.trim()
    || input.requestKey.length > 200 || !input.media || input.media.confirmed !== true || !['mute', 'source'].includes(input.media.sound)
    || !Array.isArray(input.media.segments) || (input.media.sound === 'mute' ? input.media.segments.length !== 0 : input.media.speechConfirmed !== true)
    || typeof input.assetId !== 'string' || !input.assetId.trim() || typeof input.media.contentFingerprint !== 'string'
    || typeof input.expectedOutputVersionId !== 'string' || !input.expectedOutputVersionId
    || !Number.isSafeInteger(input.expectedEditRevision) || input.expectedEditRevision < 0) {
    throw new BatchDomainError('invalid_input', '请明确原声处理方式；保留原声须试听确认实际台词、区间及替换前的话语');
  }
  const narrationIds = input.media.replaceNarrationClipIds ?? [];
  if (!Array.isArray(narrationIds) || narrationIds.length > 1000 || narrationIds.some(id => typeof id !== 'string' || !id.trim())
    || new Set(narrationIds).size !== narrationIds.length || (narrationIds.length && input.media.sound !== 'source')) {
    throw new BatchDomainError('invalid_input', '请选择要由新原声替代的配音片段');
  }
  const inputJson = JSON.stringify({ type: input.type, assetId: input.assetId,
    ...(input.type === 'replace' ? { clipId: input.clipId } : { afterClipId: input.afterClipId, timelineStartUs: input.timelineStartUs }),
    expectedOutputVersionId: input.expectedOutputVersionId, expectedEditRevision: input.expectedEditRevision,
    media: { contentFingerprint: input.media.contentFingerprint, inUs: input.media.inUs, outUs: input.media.outUs,
      protected: input.media.protected ? { inUs: input.media.protected.inUs, outUs: input.media.protected.outUs } : null, sound: input.media.sound,
      ...(input.media.sound === 'source' ? { segments: input.media.segments, speechConfirmed: true,
        ...(narrationIds.length ? { replaceNarrationClipIds: [...narrationIds].sort() } : {}) } : {}) } });
  const check = () => {
    signal.throwIfAborted();
    const view = getBatchOutputArrangementView(db, projectId, batchId, planId);
    if (!view.formulaPreview || !view.editable || view.outputVersionId !== input.expectedOutputVersionId) {
      throw new BatchDomainError('conflict', '公式成片版本已变化或当前不能编辑');
    }
    const prior = db.prepare('SELECT inputJson FROM live_mixcut_formula_manual_media WHERE projectId=? AND outputVersionId=? AND requestKey=?')
      .get(projectId, view.outputVersionId, input.requestKey) as { inputJson: string } | undefined;
    if (prior) {
      if (prior.inputJson !== inputJson) throw new BatchDomainError('conflict', '同一次人工编辑请求不能改用其他素材或区间');
      return { view, replay: true };
    }
    if (view.editRevision !== input.expectedEditRevision) throw new BatchDomainError('conflict', '成片已被修改，请刷新后重试');
    if (input.type === 'replace') {
      const target = view.clips.find(clip => clip.clipId === input.clipId);
      if (!target) throw new BatchDomainError('not_found', '待替换片段不存在');
      if (input.media.sound === 'mute' && view.audioPlan?.clips.some(clip => clip.kind === 'source' && clip.linkedVideoClipId === target.clipId)) {
        throw new BatchDomainError('conflict', '这段画面含需要保留的原声，不能通过静音换片删除台词');
      }
      if (input.media.outUs - input.media.inUs !== target.sourceEndUs - target.sourceStartUs) {
        throw new BatchDomainError('invalid_input', '替换区间须与原片段取用长度相同');
      }
    }
    return { view, replay: false };
  };
  const previous = check();
  const unchanged = (view: typeof previous.view) => ({ outputVersionId: view.outputVersionId!, editRevision: view.editRevision,
    changed: false, replayed: true, visualChanged: false, reviewCleared: false, warnings: [] as string[] });
  if (previous.replay) return unchanged(previous.view);
  const candidate = await verifyFormulaCandidate(db, projectId, input.assetId, input.media.contentFingerprint,
    listAssetSources(db, input.assetId).map(source => ({ id: source.id, location: source.locationJson })), signal);
  if (!candidate) throw new BatchDomainError('conflict', '新素材无法读取或内容已变化，请重新选择');
  const [range] = parseFormulaAvailableRanges([{ inUs: input.media.inUs, outUs: input.media.outUs, protected: input.media.protected }], candidate.media.durationUs);
  if ([range.inUs, range.outUs].some(us => Math.round(Math.round(us * FINAL_EDIT_FPS / 1_000_000) * 1_000_000 / FINAL_EDIT_FPS) !== us)) {
    throw new BatchDomainError('invalid_input', '人工素材取用区间须落在 24fps 的帧边界上');
  }
  const verifiedState = check();
  if (verifiedState.replay) return unchanged(verifiedState.view);
  const base = { id: `manual-media:${randomUUID()}`, candidate, inUs: range.inUs, outUs: range.outUs,
    protected: range.protected, origin: 'manual' as const };
  let proof: FormulaManualMediaProof;
  if (input.media.sound === 'mute') proof = { ...base, version: 1, sound: 'mute' };
  else {
    if (!candidate.media.hasAudio) throw new BatchDomainError('invalid_input', '新素材没有音轨，不能保留原声');
    const speech = parseFormulaManualSpeech('speech', input.media.segments, candidate.media.durationUs);
    if (speech.segments.some(segment => segment.startUs < range.inUs || segment.endUs > range.outUs)) {
      throw new BatchDomainError('invalid_input', '取用区间必须完整包含已核对的台词');
    }
    const replaces: FormulaReplacedSpeechRange[] = [];
    let previousText = '';
    const row = db.prepare('SELECT arrangementJson FROM live_mixcut_output_versions WHERE id=?').get(input.expectedOutputVersionId) as { arrangementJson: string };
    const basis = effectiveFormulaOutputBasis(db, projectId, input.expectedOutputVersionId, JSON.parse(row.arrangementJson))!;
    if (input.type === 'replace') {
      const target = previous.view.clips.find(clip => clip.clipId === input.clipId)!;
      if ((target.playbackRate ?? 1) !== 1) throw new BatchDomainError('invalid_input', '保留原声的画面暂不支持变速');
      const oldSound = previous.view.audioPlan?.clips.find(sound => sound.linkedVideoClipId === target.clipId);
      if (oldSound) {
        const oldSource = basis.audioSources.find(source => source.mediaId === oldSound.mediaId);
        if (!oldSource) throw new BatchDomainError('conflict', '原声已变化，请重新读取成片后核对');
        const words = oldSource.words.filter(word => word.sourceInUs < target.sourceEndUs && word.sourceOutUs > target.sourceStartUs);
        if (words.some(word => word.sourceInUs < target.sourceStartUs || word.sourceOutUs > target.sourceEndUs)) {
          throw new BatchDomainError('invalid_input', '不能只替换半句话，请先选择完整话语所在的画面');
        }
        previousText = words.map(word => word.text).join('');
        replaces.push({ mediaId: oldSound.mediaId, inUs: target.sourceStartUs, outUs: target.sourceEndUs,
          replacementInUs: range.inUs, replacementOutUs: range.outUs });
        if (oldSource.manualMediaId) {
          const oldProof = readFormulaManualMedia(db, projectId, input.expectedOutputVersionId, oldSource.manualMediaId);
          if (oldProof.sound === 'source') for (const ancestor of oldProof.replaces) {
            const start = Math.max(target.sourceStartUs, ancestor.replacementInUs);
            const end = Math.min(target.sourceEndUs, ancestor.replacementOutUs);
            if (end > start) replaces.push({ ...ancestor,
              inUs: ancestor.narration ? ancestor.inUs : ancestor.inUs + start - ancestor.replacementInUs,
              outUs: ancestor.narration ? ancestor.outUs : ancestor.inUs + end - ancestor.replacementInUs,
              replacementInUs: range.inUs + start - target.sourceStartUs, replacementOutUs: range.inUs + end - target.sourceStartUs,
              ...(ancestor.narration ? { narration: { ...ancestor.narration, partInUs: ancestor.narration.partInUs + start - ancestor.replacementInUs } } : {}) });
          }
        }
      }
    }
    const timelineStartUs = input.type === 'replace' ? previous.view.clips.find(clip => clip.clipId === input.clipId)!.timelineStartUs
      : input.timelineStartUs === undefined ? previous.view.clips.find(clip => clip.clipId === input.afterClipId)?.timelineEndUs ?? 0
        : Math.round(Math.round(input.timelineStartUs * FINAL_EDIT_FPS / 1e6) * 1e6 / FINAL_EDIT_FPS);
    for (const id of narrationIds) {
      const sound = previous.view.audioPlan?.clips.find(clip => clip.id === id && clip.kind === 'narration');
      if (!sound) throw new BatchDomainError('conflict', '所选配音已变化，请重新读取后选择');
      if (sound.timelineStartUs < timelineStartUs || sound.timelineEndUs > timelineStartUs + range.outUs - range.inUs) {
        throw new BatchDomainError('invalid_input', '新画面须完整覆盖所选配音；请先在配音轨道按完整话语分割');
      }
      const source = basis.audioSources.find(source => source.mediaId === sound.mediaId && source.kind === 'narration');
      if (!source) throw new BatchDomainError('conflict', '配音来源已变化，请重新读取后核对');
      const words = source.words.filter(word => word.sourceInUs < sound.sourceOutUs && word.sourceOutUs > sound.sourceInUs);
      if (!words.length || words.some(word => word.sourceInUs < sound.sourceInUs || word.sourceOutUs > sound.sourceOutUs)) {
        throw new BatchDomainError('invalid_input', '请完整选择配音话语，不能只替换半句话');
      }
      const text = words.map(word => word.text).join('');
      replaces.push({ mediaId: sound.mediaId, inUs: sound.sourceInUs, outUs: sound.sourceOutUs,
        replacementInUs: speech.segments[0].startUs, replacementOutUs: speech.segments.at(-1)!.endUs,
        narration: { clipId: sound.id, text, coverageId: `${base.id}:${sound.id}`, requiredInUs: speech.segments[0].startUs,
          requiredOutUs: speech.segments.at(-1)!.endUs, partInUs: speech.segments[0].startUs } });
    }
    proof = { ...base, version: replaces.some(range => range.narration) ? 3 : 2,
      sound: 'source', speechConfirmed: true, segments: speech.segments, previousText, replaces };
  }
  return db.transaction(() => {
    const current = check();
    if (current.replay) return unchanged(current.view);
    recheckFormulaCandidate(db, projectId, candidate);
    db.prepare(`INSERT INTO live_mixcut_formula_manual_media (id,projectId,outputVersionId,assetId,requestKey,inputJson,proofJson,createdAt)
      VALUES (?,?,?,?,?,?,?,?)`).run(proof.id, projectId, input.expectedOutputVersionId, input.assetId,
      input.requestKey, inputJson, JSON.stringify(proof), new Date().toISOString());
    return applyBatchOutputClipEdit(db, projectId, batchId, planId, { ...input, formulaSourceId: proof.id });
  })();
}
