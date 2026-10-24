import type Database from 'better-sqlite3';
import { BatchApiUnavailableError, BatchDomainError } from '../errors.ts';
import { createOutputVersion } from '../plans.ts';
import { formulaExecutionAvailable } from './execution-gate.ts';
import type { FormulaGenerationRequest } from './generation.ts';
import type { FormulaTimelineResult } from './timeline.ts';
import { readFormulaTimelineInput } from './timeline-store.ts';
import { parseFormulaProductionSettings } from './production-settings.ts';
import { reconcileFormulaOutputAudio, type FormulaOutputBasis } from './output-audio.ts';
import { selectFormulaOutputMusic } from './output-music.ts';
import { initialFormulaPresentation } from './output-presentation.ts';
import { queueFormulaExecutionCheck } from './execution-store.ts';

/** 排片结果与编辑器共用既有输出版本；重复续接不重建或覆盖已编辑的版本。 */
export function materializeFormulaOutput(db: Database.Database, projectId: string, batchId: string,
  timelineStageId: string, request: FormulaGenerationRequest): string | null {
  if (!formulaExecutionAvailable(db)) throw new BatchApiUnavailableError('formula_unavailable', '实拍公式制作暂不可用');
  return db.transaction(() => {
    const row = db.prepare(`SELECT s.planId,s.selectionStageId,r.resultJson,p.currentVersionId
      FROM live_mixcut_formula_execution_stages s JOIN live_mixcut_formula_timeline_results r ON r.stageId=s.id
      JOIN live_mixcut_formula_generation_requests g ON g.id=s.requestId JOIN live_mixcut_productions b ON b.id=g.batchId
      JOIN live_mixcut_output_plans p ON p.id=s.planId
      WHERE s.id=? AND s.kind='timeline' AND g.id=? AND g.projectId=? AND g.batchId=?
        AND b.currentVersionId=g.batchVersionId AND b.deletedAt IS NULL AND b.controlState<>'stopped'
        AND s.selectionStageId=(SELECT id FROM live_mixcut_formula_stages WHERE planId=s.planId AND kind='select' ORDER BY revision DESC LIMIT 1)`)
      .get(timelineStageId, request.id, projectId, batchId) as
        { planId: string; selectionStageId: string; resultJson: string; currentVersionId: string | null } | undefined;
    if (!row) throw new BatchDomainError('conflict', '这份排片已不是当前制作输入');
    const timeline: FormulaTimelineResult = JSON.parse(row.resultJson);
    if (timeline.status !== 'planned') return null;
    const existing = db.prepare('SELECT outputVersionId FROM live_mixcut_formula_output_versions WHERE timelineStageId=?').get(timelineStageId) as { outputVersionId: string } | undefined;
    if (existing) {
      queueFormulaExecutionCheck(db, projectId, batchId, existing.outputVersionId);
      return existing.outputVersionId;
    }
    if (row.currentVersionId) throw new BatchDomainError('conflict', '成片已经有其他当前版本，不能覆盖');
    const { input, selection } = readFormulaTimelineInput(db, timelineStageId, request, row.planId);
    const basis: FormulaOutputBasis = { version: 1, selectionStageId: row.selectionStageId, timelineStageId,
      videoSources: timeline.duration.clips.map(clip => ({ mediaId: clip.slotId, assetId: clip.assetId, contentFingerprint: clip.contentFingerprint })),
      audioSources: timeline.audio.map(sound => {
        const selected = selection.slots.find(slot => slot.slotId === sound.linkGroupId)?.candidate;
        const narration = input.narration?.result.items.find(item => item.id === sound.narrationId);
        const duration = sound.kind === 'source' ? selected?.media.durationUs : narration?.audio.durationUs;
        if (!duration) throw new BatchDomainError('conflict', '排片缺少实际声音来源');
        return { mediaId: sound.id, kind: sound.kind, contentFingerprint: sound.contentFingerprint, sourceDurationUs: duration,
          verifiedInUs: sound.sourceInUs, verifiedOutUs: sound.sourceOutUs,
          ...(narration?.audio.timingSource ? { timingSource: narration.audio.timingSource, externalNarrationId: narration.audio.externalNarrationId } : {}),
          ...(sound.kind === 'source' ? { slotId: sound.linkGroupId!, assetId: sound.assetId! } : {}),
          words: timeline.words.filter(word => word.audioId === sound.id).map(word => ({ id: word.id, text: word.text,
            sourceInUs: sound.sourceInUs + word.startUs - sound.timelineStartUs, sourceOutUs: sound.sourceInUs + word.endUs - sound.timelineStartUs })) };
      }) };
    const clips = timeline.duration.clips.map(clip => ({ clipId: clip.slotId, segmentId: clip.slotId, assetId: clip.assetId,
      contentFingerprint: clip.contentFingerprint, sourceStartUs: clip.sourceInUs, sourceEndUs: clip.sourceOutUs,
      timelineStartUs: clip.timelineStartUs, timelineEndUs: clip.timelineEndUs, playbackRate: 1, locked: false }));
    const production = parseFormulaProductionSettings(request.input.settings.settings.production);
    const arrangement: Record<string, unknown> = {
      schemaVersion: 'formula-output/1', planningMode: 'formula', preset: production.outputPreset, fps: 24,
      formula: basis, clips, targetDurationUs: timeline.duration.bodyDurationUs, preserveGaps: true, editRevision: 0,
      productionReady: false, blockers: ['formula_execution_pending'], warnings: timeline.issues.map(issue => issue.message),
      audioPlan: { version: 1, revision: 0, bodyDurationUs: timeline.duration.bodyDurationUs, issues: [],
        clips: timeline.audio.map(sound => ({ id: sound.id, mediaId: sound.id, kind: sound.kind, sourceInUs: sound.sourceInUs,
          sourceOutUs: sound.sourceOutUs, timelineStartUs: sound.timelineStartUs, timelineEndUs: sound.timelineEndUs, gainDb: 0,
          ...(sound.kind === 'source' ? { linkedVideoClipId: sound.linkGroupId } : {}) })) },
      ...initialFormulaPresentation(request, row.planId, timelineStageId, timeline), music: selectFormulaOutputMusic(request, row.planId),
    };
    reconcileFormulaOutputAudio(arrangement, clips);
    const outputVersionId = createOutputVersion(db, row.planId, { arrangementJson: arrangement });
    db.prepare('INSERT INTO live_mixcut_formula_output_versions (timelineStageId,outputVersionId,createdAt) VALUES (?,?,?)')
      .run(timelineStageId, outputVersionId, new Date().toISOString());
    queueFormulaExecutionCheck(db, projectId, batchId, outputVersionId);
    return outputVersionId;
  })();
}
