import fs from 'node:fs';
import type Database from 'better-sqlite3';
import { BatchApiUnavailableError, BatchDomainError } from '../errors.ts';
import { getBatchPlanningMode } from '../planning-mode.ts';
import { resolveSourceFilePath } from '../media-catalog.ts';
import { assertProjectAssetFileIdentity, projectAssetFileIdentity } from '../project-asset-media.ts';
import { formulaExecutionAvailable } from './execution-gate.ts';
import { verifyFormulaCandidate, recheckFormulaCandidate, type FormulaVerifiedCandidate } from './candidate-media.ts';
import { assertFormulaNarrationAudio } from './narration.ts';
import type { FormulaNarrationStageResult } from './narration-store.ts';
import type { FormulaSelection } from './selection.ts';
import type { FormulaTimelineResult } from './timeline.ts';
import { readFormulaOutputAudioPlan, reconcileFormulaOutputAudio, type FormulaOutputBasis } from './output-audio.ts';
import { readFormulaGenerationRequest } from './generation.ts';
import { readFormulaScheduleStageResult } from './schedule.ts';
import { readFormulaVoiceNarrationResult } from './pipeline-v2.ts';
import { manualMediaForClip, assertManualMediaProtection } from './manual-media.ts';
import { effectiveFormulaOutputBasis } from './manual-audio-basis.ts';

interface RenderTarget {
  db: Database.Database; projectId: string; batchId: string; batchVersionId: string; planId: string; outputVersionId: string;
}
function fail(message: string): never { throw new BatchDomainError('conflict', message); }

/** Resolve each sound from its saved stage, never from a caller-provided path or a script-wide narration. */
export async function resolveFormulaRenderAudio(target: RenderTarget, arrangementJson: string, signal: AbortSignal) {
  const { db, projectId, batchId, batchVersionId, planId, outputVersionId } = target;
  const arrangement = JSON.parse(arrangementJson) as Record<string, unknown>;
  if (getBatchPlanningMode(db, projectId, batchId) !== 'formula') {
    if (arrangement.formula !== undefined || arrangement.audioPlan !== undefined) fail('普通批次不能使用公式声音计划');
    return null;
  }
  const basis = effectiveFormulaOutputBasis(db, projectId, outputVersionId, arrangement), plan = readFormulaOutputAudioPlan(arrangement.audioPlan);
  if (!basis || !plan || !plan.clips.length || plan.bodyDurationUs <= 0) fail('公式成片缺少实际声音计划');
  // 新规矩的成片没有旧时间轴；声音从排时间结果、依据和配音结果还原。
  const sourceKind = db.prepare('SELECT sourceKind FROM live_mixcut_formula_output_lineage WHERE outputVersionId=?').get(outputVersionId) as
    { sourceKind: 'timeline' | 'schedule' } | undefined;
  if (sourceKind?.sourceKind === 'schedule') return resolveScheduleRenderAudio(target, arrangement, basis, plan, signal);
  const lineage = () => {
    signal.throwIfAborted();
    if (!formulaExecutionAvailable(db)) throw new BatchApiUnavailableError('formula_unavailable', '实拍公式制作暂不可用');
    const row = db.prepare(`SELECT t.resultJson AS timelineJson,s.resultJson AS selectionJson,n.resultJson AS narrationJson
      FROM live_mixcut_formula_output_versions f JOIN live_mixcut_output_versions o ON o.id=f.outputVersionId
      JOIN live_mixcut_output_plans p ON p.id=o.planId JOIN live_mixcut_formula_execution_stages e ON e.id=f.timelineStageId
      JOIN live_mixcut_formula_generation_requests g ON g.id=e.requestId JOIN live_mixcut_productions b ON b.id=g.batchId
      JOIN live_mixcut_formula_timeline_results t ON t.stageId=e.id JOIN live_mixcut_formula_selection_results s ON s.stageId=e.selectionStageId
      JOIN live_mixcut_formula_timeline_stages ts ON ts.id=e.id LEFT JOIN live_mixcut_formula_narration_results n ON n.stageId=ts.narrationStageId
      WHERE f.outputVersionId=? AND f.timelineStageId=? AND e.selectionStageId=? AND e.planId=? AND p.id=e.planId
        AND g.projectId=? AND b.projectId=g.projectId AND g.batchId=? AND g.batchVersionId=? AND p.batchVersionId=g.batchVersionId
        AND b.currentVersionId=g.batchVersionId AND b.deletedAt IS NULL AND b.controlState<>'stopped'
        AND p.currentVersionId=o.id AND o.arrangementJson=?
        AND e.selectionStageId=(SELECT id FROM live_mixcut_formula_stages WHERE planId=p.id AND kind='select' ORDER BY revision DESC LIMIT 1)`)
      .get(outputVersionId, basis.timelineStageId, basis.selectionStageId, planId, projectId, batchId, batchVersionId, arrangementJson) as
        { timelineJson: string; selectionJson: string; narrationJson: string | null } | undefined;
    if (!row) fail('公式渲染版本、编辑内容或选片依据已变化，请重新生成');
    return row;
  };
  const saved = lineage();
  const timeline: FormulaTimelineResult = JSON.parse(saved.timelineJson);
  const selection: FormulaSelection = JSON.parse(saved.selectionJson);
  const narration: FormulaNarrationStageResult | null = saved.narrationJson ? JSON.parse(saved.narrationJson) : null;
  if (timeline.status !== 'planned' || selection.status !== 'selected') fail('公式画面与声音尚未排好');
  const videoClips = arrangement.clips as Array<Record<string, unknown>>;
  // Recompute linked sound and completeness, rather than trusting saved issues=[] or productionReady.
  const checked = structuredClone(arrangement);
  reconcileFormulaOutputAudio(checked, videoClips, undefined, undefined, basis);
  const checkedPlan = readFormulaOutputAudioPlan(checked.audioPlan)!;
  if (checkedPlan.issues.length) fail(checkedPlan.issues.map(issue => issue.message).join('；'));
  if (JSON.stringify(checkedPlan.clips) !== JSON.stringify(plan.clips) || checkedPlan.bodyDurationUs !== plan.bodyDurationUs) {
    fail('原声与画面位置或成片长度不一致');
  }
  const candidates = new Map<string, FormulaVerifiedCandidate>();
  async function candidateFor(slotId: string) {
    const candidate = selection.status === 'selected' ? selection.slots.find(slot => slot.slotId === slotId)?.candidate : null;
    if (!candidate) fail('公式片段不属于已保存的选片');
    const key = candidate.sourceId;
    if (!candidates.has(key)) {
      const verified = await verifyFormulaCandidate(db, projectId, candidate.assetId, candidate.contentFingerprint,
        [{ id: candidate.sourceId, location: candidate.location }], signal);
      if (!verified) fail('公式原片已变化或无法读取，请重新核验');
      candidates.set(key, verified);
    }
    return candidates.get(key)!;
  }
  const videoPaths = new Map<string, string>();
  for (const clip of videoClips) {
    const manual = manualMediaForClip(db, projectId, outputVersionId, clip);
    if (manual) {
      assertManualMediaProtection(manual, videoClips);
      const candidate = manual.candidate;
      const verified = candidates.get(candidate.sourceId) ?? await verifyFormulaCandidate(db, projectId, candidate.assetId, candidate.contentFingerprint,
        [{ id: candidate.sourceId, location: candidate.location }], signal);
      if (!verified || verified.media.durationUs !== candidate.media.durationUs) fail('人工素材已变化或无法读取，请重新核验');
      candidates.set(candidate.sourceId, verified);
      videoPaths.set(String(clip.clipId), resolveSourceFilePath(verified.location));
      continue;
    }
    const original = timeline.duration.clips.find(item => item.slotId === clip.segmentId);
    if (!original || original.assetId !== clip.assetId || original.contentFingerprint !== clip.contentFingerprint) fail('人工插入或换片尚未完成画面、区间和台词核验；请重新拖入带原声的素材，或回到第二步修改输入后重新生成');
    const verified = await candidateFor(original.slotId);
    if (Number(clip.sourceEndUs) > verified.media.durationUs) fail('公式画面区间超出原片');
    videoPaths.set(String(clip.clipId), resolveSourceFilePath(verified.location));
  }
  const audioFiles = new Map<string, string>();
  const voiceChecks: Array<() => void> = [];
  for (const sound of plan.clips) {
    if (audioFiles.has(sound.mediaId)) continue;
    const manualClip = videoClips.find(clip => clip.clipId === sound.linkedVideoClipId && clip.formulaSourceId === sound.mediaId);
    const manual = manualClip && manualMediaForClip(db, projectId, outputVersionId, manualClip);
    if (manual?.sound === 'source') {
      const verified = candidates.get(manual.candidate.sourceId);
      if (sound.kind !== 'source' || !verified?.media.hasAudio) fail('人工原声缺少已核验的关联画面或音轨');
      audioFiles.set(sound.mediaId, resolveSourceFilePath(verified.location));
      continue;
    }
    const original = timeline.audio.find(item => item.id === sound.mediaId);
    const source = basis.audioSources.find(item => item.mediaId === sound.mediaId);
    if (!original || !source || original.kind !== sound.kind || source.kind !== sound.kind
      || original.contentFingerprint !== source.contentFingerprint || original.sourceInUs !== source.verifiedInUs
      || original.sourceOutUs !== source.verifiedOutUs) fail('公式声音与冻结来源不一致');
    if (sound.kind === 'source') {
      if (original.linkGroupId !== source.slotId || original.assetId !== source.assetId) fail('公式原声缺少关联画面');
      const verified = await candidateFor(source.slotId!);
      if (!verified.media.hasAudio || verified.contentFingerprint !== source.contentFingerprint
        || verified.media.durationUs !== source.sourceDurationUs) fail('原片音轨或时长与保存的声音不一致');
      audioFiles.set(sound.mediaId, resolveSourceFilePath(verified.location));
    } else {
      const item = narration?.items.find(item => item.id === original.narrationId);
      if (!item || item.audio.fingerprint !== source.contentFingerprint || original.relativePath !== item.audio.relativePath
        || original.narrationStageId !== timeline.narrationStageId || item.audio.durationUs !== source.sourceDurationUs) fail('配音不属于这份成片');
      const filename = assertFormulaNarrationAudio(projectId, item.text, item.audio);
      const identity = projectAssetFileIdentity(fs.statSync(filename));
      audioFiles.set(sound.mediaId, filename);
      voiceChecks.push(() => { assertProjectAssetFileIdentity(filename, identity); assertFormulaNarrationAudio(projectId, item.text, item.audio); });
    }
  }
  const recheck = () => {
    if (JSON.stringify(lineage()) !== JSON.stringify(saved)) fail('公式声音依据在渲染期间已变化');
    for (const candidate of candidates.values()) recheckFormulaCandidate(db, projectId, candidate);
    for (const check of voiceChecks) check();
  };
  recheck();
  const kinds = new Set(plan.clips.map(clip => clip.kind));
  return { plan, videoPaths, audioFiles, recheck, mode: kinds.size > 1 ? 'mixed' as const : kinds.has('source') ? 'source' as const : 'narration' as const };
}

/**
 * 新规矩的声音：排时间结果已经写死了每段声音的来源和区间，成片依据给出核验过的原片时长；
 * 配音只从这条成片自己的配音结果里取。
 */
async function resolveScheduleRenderAudio(target: RenderTarget, arrangement: Record<string, unknown>,
  basis: FormulaOutputBasis, plan: NonNullable<ReturnType<typeof readFormulaOutputAudioPlan>>, signal: AbortSignal) {
  const { db, projectId, batchId, batchVersionId, planId, outputVersionId } = target;
  const arrangementJson = JSON.stringify(arrangement);
  const lineage = () => {
    signal.throwIfAborted();
    if (!formulaExecutionAvailable(db)) throw new BatchApiUnavailableError('formula_unavailable', '实拍公式制作暂不可用');
    const row = db.prepare(`SELECT s.narrationStageId,sel.requestId FROM live_mixcut_formula_schedule_output_versions f
      JOIN live_mixcut_output_versions o ON o.id=f.outputVersionId JOIN live_mixcut_output_plans p ON p.id=o.planId
      JOIN live_mixcut_formula_schedule_stages s ON s.id=f.scheduleStageId
      JOIN live_mixcut_formula_stages sel ON sel.id=s.selectionStageId
      JOIN live_mixcut_formula_generation_requests g ON g.id=sel.requestId
      JOIN live_mixcut_productions b ON b.id=g.batchId
      WHERE f.outputVersionId=? AND f.scheduleStageId=? AND s.selectionStageId=? AND sel.planId=? AND p.id=sel.planId
        AND g.projectId=? AND b.projectId=g.projectId AND g.batchId=? AND g.batchVersionId=? AND p.batchVersionId=g.batchVersionId
        AND b.currentVersionId=g.batchVersionId AND b.deletedAt IS NULL AND b.controlState<>'stopped'
        AND p.currentVersionId=o.id AND o.arrangementJson=?
        AND sel.id=(SELECT id FROM live_mixcut_formula_stages WHERE planId=p.id AND kind='select' ORDER BY revision DESC LIMIT 1)`)
      .get(outputVersionId, basis.timelineStageId, basis.selectionStageId, planId, projectId, batchId, batchVersionId, arrangementJson) as
        { narrationStageId: string | null; requestId: string } | undefined;
    if (!row) fail('公式渲染版本、编辑内容或选片依据已变化，请重新生成');
    return row;
  };
  const saved = lineage();
  const schedule = readFormulaScheduleStageResult(db, basis.timelineStageId);
  if (!schedule || schedule.status !== 'planned' || schedule.algorithmVersion !== 'formula-schedule/1') fail('公式画面与声音尚未排好');
  if (schedule.narrationStageId !== saved.narrationStageId) fail('排时间不属于这份配音');
  const narration = saved.narrationStageId ? readFormulaVoiceNarrationResult(db, basis.selectionStageId) : null;
  if (saved.narrationStageId && !narration) fail('配音结果缺失');
  const videoClips = arrangement.clips as Array<Record<string, unknown>>;
  // Recompute linked sound and completeness, rather than trusting saved issues=[] or productionReady.
  const checked = structuredClone(arrangement);
  reconcileFormulaOutputAudio(checked, videoClips, undefined, undefined, basis);
  const checkedPlan = readFormulaOutputAudioPlan(checked.audioPlan)!;
  if (checkedPlan.issues.length) fail(checkedPlan.issues.map(issue => issue.message).join('；'));
  if (JSON.stringify(checkedPlan.clips) !== JSON.stringify(plan.clips) || checkedPlan.bodyDurationUs !== plan.bodyDurationUs) {
    fail('原声与画面位置或成片长度不一致');
  }
  const request = readFormulaGenerationRequest(db, projectId, batchId, saved.requestId);
  const candidates = new Map<string, FormulaVerifiedCandidate>();
  async function candidateFor(assetId: string, contentFingerprint: string, durationUs?: number) {
    let verified = candidates.get(assetId);
    if (!verified) {
      const sources = request.input.mediaSources.find(item => item.assetId === assetId)?.sources ?? [];
      const found = await verifyFormulaCandidate(db, projectId, assetId, contentFingerprint, sources, signal);
      if (!found) fail('公式原片已变化或无法读取，请重新核验');
      verified = found;
      candidates.set(assetId, found);
    }
    if (verified.contentFingerprint !== contentFingerprint) fail('公式原片内容与排时间不一致');
    if (durationUs !== undefined && verified.media.durationUs !== durationUs) fail('公式原片时长与排时间不一致');
    return verified;
  }
  const videoSources = new Map((basis.videoSources ?? []).map(source => [source.mediaId, source]));
  const videoPaths = new Map<string, string>();
  for (const clip of videoClips) {
    const manual = manualMediaForClip(db, projectId, outputVersionId, clip);
    if (manual) {
      assertManualMediaProtection(manual, videoClips);
      const candidate = manual.candidate;
      const verified = candidates.get(candidate.assetId) ?? await candidateFor(candidate.assetId, candidate.contentFingerprint, candidate.media.durationUs);
      if (verified.media.durationUs !== candidate.media.durationUs) fail('人工素材已变化或无法读取，请重新核验');
      if (Number(clip.sourceEndUs) > verified.media.durationUs) fail('公式画面区间超出原片');
      videoPaths.set(String(clip.clipId), resolveSourceFilePath(verified.location));
      continue;
    }
    const source = videoSources.get(String(clip.clipId));
    if (!source || source.assetId !== clip.assetId || source.contentFingerprint !== clip.contentFingerprint) {
      fail('人工插入或换片尚未完成画面、区间和台词核验；请重新拖入带原声的素材，或回到第二步修改输入后重新生成');
    }
    const verified = await candidateFor(source.assetId, source.contentFingerprint);
    if (Number(clip.sourceEndUs) > verified.media.durationUs) fail('公式画面区间超出原片');
    videoPaths.set(String(clip.clipId), resolveSourceFilePath(verified.location));
  }
  const audioFiles = new Map<string, string>();
  const voiceChecks: Array<() => void> = [];
  for (const sound of plan.clips) {
    if (audioFiles.has(sound.mediaId)) continue;
    const manualClip = videoClips.find(clip => clip.clipId === sound.linkedVideoClipId && clip.formulaSourceId === sound.mediaId);
    const manual = manualClip && manualMediaForClip(db, projectId, outputVersionId, manualClip);
    if (manual?.sound === 'source') {
      const verified = candidates.get(manual.candidate.assetId);
      if (sound.kind !== 'source' || !verified?.media.hasAudio) fail('人工原声缺少已核验的关联画面或音轨');
      audioFiles.set(sound.mediaId, resolveSourceFilePath(verified.location));
      continue;
    }
    const source = basis.audioSources.find(item => item.mediaId === sound.mediaId);
    if (!source || source.kind !== sound.kind || source.verifiedInUs !== sound.sourceInUs
      || source.verifiedOutUs !== sound.sourceOutUs) fail('公式声音与冻结来源不一致');
    if (sound.kind === 'source') {
      if (!source.slotId || !source.assetId) fail('公式原声缺少关联画面');
      const verified = await candidateFor(source.assetId, source.contentFingerprint, source.sourceDurationUs);
      if (!verified.media.hasAudio) fail('原片音轨或时长与保存的声音不一致');
      audioFiles.set(sound.mediaId, resolveSourceFilePath(verified.location));
    } else {
      const item = narration?.items.find(entry => `narration:${entry.lineIndex}` === sound.mediaId);
      if (!item || item.audio.fingerprint !== source.contentFingerprint || item.audio.durationUs !== source.sourceDurationUs) {
        fail('配音不属于这份成片');
      }
      const filename = assertFormulaNarrationAudio(projectId, item.text, item.audio);
      const identity = projectAssetFileIdentity(fs.statSync(filename));
      audioFiles.set(sound.mediaId, filename);
      voiceChecks.push(() => { assertProjectAssetFileIdentity(filename, identity); assertFormulaNarrationAudio(projectId, item.text, item.audio); });
    }
  }
  const recheck = () => {
    if (JSON.stringify(lineage()) !== JSON.stringify(saved)) fail('公式声音依据在渲染期间已变化');
    for (const candidate of candidates.values()) recheckFormulaCandidate(db, projectId, candidate);
    for (const check of voiceChecks) check();
  };
  recheck();
  const kinds = new Set(plan.clips.map(clip => clip.kind));
  return { plan, videoPaths, audioFiles, recheck, mode: kinds.size > 1 ? 'mixed' as const : kinds.has('source') ? 'source' as const : 'narration' as const };
}
