/**
 * 把「排时间」的结果变成一条成片版本：画面轨、声音轨、字幕、包装和封面。
 *
 * 成片版本仍然写进通用的 output_versions；只是「这条成片是公式成片、它的排片依据是哪一阶段」
 * 的登记写新表，和旧时间轴的表互不相干。渲染、执行检查和审片都读同一份 arrangement。
 */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { BatchApiUnavailableError, BatchDomainError } from '../errors.ts';
import { createOutputVersion } from '../plans.ts';
import { createBatchTask } from '../tasks.ts';
import { buildCoverRenderTaskRequestKey } from '../render-task-key.ts';
import { FINAL_EDIT_FPS, FINAL_EDIT_INTRO_FRAMES } from '../../media-core/render-contract.ts';
import { formulaExecutionAvailable } from './execution-gate.ts';
import { formulaExecutionInputKey, formulaOutputExecutionReady, queueFormulaExecutionCheck,
  readFormulaExecutionProof, restoreFormulaExecutionStamp } from './execution-store.ts';
import type { FormulaGenerationRequest } from './generation.ts';
import { readFormulaScheduleStage, readFormulaScheduleStageResult, selectionSlotId,
  type FormulaScheduleStageResult } from './schedule.ts';
import type { SchedulingFile } from '../scheduling/types.ts';
import type { FormulaTimelineResult } from './timeline.ts';
import type { FormulaDurationClip } from './duration.ts';
import { parseFormulaProductionSettings } from './production-settings.ts';
import { reconcileFormulaOutputAudio, type FormulaOutputAudioSource, type FormulaOutputBasis } from './output-audio.ts';
import { selectFormulaOutputMusic } from './output-music.ts';
import { initialFormulaPresentation } from './output-presentation.ts';

const FRAME_US = 1_000_000 / FINAL_EDIT_FPS;
const frames = (us: number): number => Math.max(0, Math.round(us / FRAME_US));

/** 只给包装和封面计算用的旧版时间线投影；不写库，也不参与渲染。 */
export function schedulePresentationTimeline(stageId: string, result: FormulaScheduleStageResult,
  selection: import('./selection.ts').FormulaSelection): Extract<FormulaTimelineResult, { status: 'planned' }> {
  const duration: Extract<FormulaTimelineResult, { status: 'planned' }>['duration'] = {
    status: 'planned', algorithmVersion: 'formula-duration/1', executionReady: false,
    fps: FINAL_EDIT_FPS, introFrames: FINAL_EDIT_INTRO_FRAMES,
    bodyFrames: result.timeline.totalFrames, totalFrames: result.timeline.totalFrames,
    bodyDurationUs: result.timeline.totalDurationUs, totalDurationUs: result.timeline.totalDurationUs,
    audioRevisionId: stageId,
    target: { mode: 'reference', scope: 'body', durationUs: result.timeline.totalDurationUs,
      quantizedFrames: result.timeline.totalFrames, bodyFrames: result.timeline.totalFrames,
      totalFrames: result.timeline.totalFrames, quantizedDurationUs: result.timeline.totalDurationUs },
    issues: [],
    clips: result.timeline.clips.map((clip): FormulaDurationClip => ({
      slotId: clip.slotIndex === undefined ? clip.id : selectionSlotId(selection, clip.slotIndex), logicalCode: clip.logicalCode,
      assetId: clip.assetId, contentFingerprint: clip.contentFingerprint, rangeId: clip.id,
      sourceInFrame: frames(clip.sourceInUs), sourceOutFrame: frames(clip.sourceOutUs),
      sourceInUs: clip.sourceInUs, sourceOutUs: clip.sourceOutUs,
      timelineStartFrame: clip.timelineStartFrame, timelineEndFrame: clip.timelineEndFrame,
      timelineStartUs: clip.timelineStartUs, timelineEndUs: clip.timelineEndUs,
      speed: 1, rangeConfirmed: true, hasSourceSpeech: clip.kind === 'vo',
    })),
    narrations: [],
  };
  return {
    status: 'planned', algorithmVersion: 'formula-timeline/3', executionReady: false, reviewStatus: 'pending',
    mappingStageId: stageId, narrationStageId: result.narrationStageId, duration,
    audio: result.timeline.sounds.map(sound => ({
      id: sound.id, kind: sound.kind, slotIds: sound.slotIndex === null ? sound.lineIndexes.map(index => `line:${index}`)
        : [selectionSlotId(selection, sound.slotIndex)], contentFingerprint: sound.contentFingerprint,
      ...(sound.assetId ? { assetId: sound.assetId } : {}),
      ...(sound.kind === 'source' ? { linkGroupId: sound.slotIndex === null ? undefined : selectionSlotId(selection, sound.slotIndex) } : {
        narrationId: `line-${sound.lineIndexes[0]}`,
        ...(result.narrationStageId ? { narrationStageId: result.narrationStageId } : {}),
        ...(sound.relativePath ? { relativePath: sound.relativePath } : {}),
      }),
      sourceInUs: sound.sourceInUs, sourceOutUs: sound.sourceOutUs,
      timelineStartUs: sound.timelineStartUs, timelineEndUs: sound.timelineEndUs,
    })),
    words: result.timeline.words.map((word, index) => ({ id: `word:${index}`, audioId: word.soundId,
      text: word.text, startUs: word.startUs, endUs: word.endUs })),
    issues: result.timeline.warnings.map((message, index) => ({ code: `schedule_warning_${index}`, slotIds: [], message })),
  };
}

/**
 * 成片登记：这条 output version 由哪次排时间产生。
 * 用 immediate 事务：修复循环读到的成片和写回的成片在同一把写锁里，不能把刚提交的通过标记覆盖成旧快照。
 */
export function queueFormulaScheduleExecutionCheck(db: Database.Database, projectId: string, batchId: string,
  outputVersionId: string): string | null {
  if (!formulaExecutionAvailable(db)) return null;
  return db.transaction(() => {
    const row = db.prepare(`SELECT o.arrangementJson,sel.planId,sc.selectionStageId FROM live_mixcut_formula_schedule_output_versions f
      JOIN live_mixcut_output_versions o ON o.id=f.outputVersionId JOIN live_mixcut_output_plans p ON p.id=o.planId
      JOIN live_mixcut_production_versions v ON v.id=p.batchVersionId JOIN live_mixcut_productions b ON b.id=v.batchId
      JOIN live_mixcut_formula_schedule_stages sc ON sc.id=f.scheduleStageId
      JOIN live_mixcut_formula_stages sel ON sel.id=sc.selectionStageId
      WHERE o.id=? AND b.id=? AND b.projectId=? AND b.currentVersionId=v.id AND p.currentVersionId=o.id
        AND b.deletedAt IS NULL AND b.controlState<>'stopped'
        AND sc.selectionStageId=(SELECT id FROM live_mixcut_formula_stages WHERE planId=p.id AND kind='select' ORDER BY revision DESC LIMIT 1)`)
      .get(outputVersionId, batchId, projectId) as { arrangementJson: string; planId: string; selectionStageId: string } | undefined;
    if (!row) return null;
    const arrangement = JSON.parse(row.arrangementJson) as Record<string, unknown>;
    if (formulaOutputExecutionReady(db, outputVersionId, arrangement)) return null;
    // 通过标记可能被别的写入冲掉过：检查结果还在且内容没变，就把标记补回去，不再重排一次检查。
    const proof = readFormulaExecutionProof(db, outputVersionId);
    if (proof) { restoreFormulaExecutionStamp(db, outputVersionId, arrangement, proof); return null; }
    arrangement.productionReady = false;
    delete arrangement.formulaExecution;
    const blockers = Array.isArray(arrangement.blockers) ? arrangement.blockers : [];
    arrangement.blockers = [...blockers.filter(value => value !== 'formula_execution_pending'), 'formula_execution_pending'];
    const inputJson = JSON.stringify(arrangement);
    const inputKey = formulaExecutionInputKey(db, outputVersionId, arrangement);
    db.prepare('UPDATE live_mixcut_output_versions SET arrangementJson=? WHERE id=?').run(inputJson, outputVersionId);
    let stage = db.prepare('SELECT id FROM live_mixcut_formula_schedule_execution_checks WHERE outputVersionId=? AND inputKey=?')
      .get(outputVersionId, inputKey) as { id: string } | undefined;
    if (!stage) {
      stage = { id: randomUUID() };
      const revision = (db.prepare("SELECT COALESCE(MAX(revision),0)+1 AS next FROM live_mixcut_formula_execution_stages WHERE planId=? AND selectionStageId=? AND kind='execution'")
        .get(row.planId, row.selectionStageId) as { next: number }).next;
      db.prepare('INSERT INTO live_mixcut_formula_schedule_execution_checks (id,outputVersionId,revision,inputKey,inputJson,createdAt) VALUES (?,?,?,?,?,?)')
        .run(stage.id, outputVersionId, revision, inputKey, inputJson, new Date().toISOString());
    }
    return createBatchTask(db, projectId, { batchId, workType: 'formula_stage', targetKind: 'formula_stage', targetId: stage.id,
      requestKey: `formula:execution:${stage.id}` });
  }).immediate();
}

/** 成片改动后重新排检查：新规矩的成片走新表，旧批次走旧表，调用方不用分。 */
export function queueFormulaOutputCheck(db: Database.Database, projectId: string, batchId: string, outputVersionId: string): string | null {
  const lineage = db.prepare('SELECT sourceKind FROM live_mixcut_formula_output_lineage WHERE outputVersionId=?')
    .get(outputVersionId) as { sourceKind: 'timeline' | 'schedule' } | undefined;
  if (!lineage) return null;
  return lineage.sourceKind === 'schedule'
    ? queueFormulaScheduleExecutionCheck(db, projectId, batchId, outputVersionId)
    : queueFormulaExecutionCheck(db, projectId, batchId, outputVersionId);
}

/** 升级或中断后把新规矩的成片检查补回来；和旧链的修复互不相干。 */
export function repairFormulaScheduleExecutionChecks(db: Database.Database, onError: (projectId: string, requestId: string) => void): void {
  if (!formulaExecutionAvailable(db)) return;
  const rows = db.prepare(`SELECT f.outputVersionId AS id,b.projectId,sel.requestId FROM live_mixcut_formula_schedule_output_versions f
    JOIN live_mixcut_output_versions o ON o.id=f.outputVersionId JOIN live_mixcut_output_plans p ON p.currentVersionId=o.id
    JOIN live_mixcut_production_versions v ON v.id=p.batchVersionId JOIN live_mixcut_productions b ON b.currentVersionId=v.id
    JOIN live_mixcut_formula_schedule_stages s ON s.id=f.scheduleStageId
    JOIN live_mixcut_formula_stages sel ON sel.id=s.selectionStageId
    WHERE b.deletedAt IS NULL AND b.controlState='running'`).all() as
      Array<{ id: string; projectId: string; batchId: string; requestId: string }>;
  for (const row of rows) {
    try { queueFormulaScheduleExecutionCheck(db, row.projectId, row.batchId, row.id); }
    catch { onError(row.projectId, row.requestId); }
  }
}

/** 排时间结果 → 一条成片版本；重复续接不重建已存在的版本。 */
export function materializeFormulaScheduleOutput(db: Database.Database, projectId: string, batchId: string,
  scheduleStageId: string, request: FormulaGenerationRequest): string | null {
  if (!formulaExecutionAvailable(db)) throw new BatchApiUnavailableError('formula_unavailable', '实拍公式制作暂不可用');
  return db.transaction(() => {
    const stage = readFormulaScheduleStage(db, scheduleStageId);
    const row = db.prepare(`SELECT sel.planId,g.batchVersionId,b.currentVersionId,p.currentVersionId AS planVersionId
      FROM live_mixcut_formula_schedule_stages s JOIN live_mixcut_formula_stages sel ON sel.id=s.selectionStageId
      JOIN live_mixcut_formula_generation_requests g ON g.id=sel.requestId
      JOIN live_mixcut_productions b ON b.id=g.batchId JOIN live_mixcut_output_plans p ON p.id=sel.planId
      WHERE s.id=? AND g.id=? AND g.projectId=? AND g.batchId=? AND b.deletedAt IS NULL AND b.controlState<>'stopped'
        AND sel.id=(SELECT id FROM live_mixcut_formula_stages WHERE planId=sel.planId AND kind='select' ORDER BY revision DESC LIMIT 1)`)
      .get(scheduleStageId, request.id, projectId, batchId) as
        { planId: string; batchVersionId: string; currentVersionId: string | null; planVersionId: string | null } | undefined;
    if (!row || row.batchVersionId !== request.batchVersionId) throw new BatchDomainError('conflict', '这次排时间已不是当前制作输入');
    const existing = db.prepare('SELECT outputVersionId FROM live_mixcut_formula_schedule_output_versions WHERE scheduleStageId=?')
      .get(scheduleStageId) as { outputVersionId: string } | undefined;
    if (existing) {
      queueFormulaScheduleExecutionCheck(db, projectId, batchId, existing.outputVersionId);
      return existing.outputVersionId;
    }
    // 恢复某一行会重排一次、出这条成片的新版本；只有「当前版本就来自这一次或更晚的排时间」才拒绝。
    if (row.planVersionId) {
      const current = db.prepare(`SELECT sc.selectionStageId,sc.revision FROM live_mixcut_output_plans p
        JOIN live_mixcut_formula_schedule_output_versions f ON f.outputVersionId=p.currentVersionId
        JOIN live_mixcut_formula_schedule_stages sc ON sc.id=f.scheduleStageId WHERE p.id=?`).get(row.planId) as
          { selectionStageId: string; revision: number } | undefined;
      if (!current || current.selectionStageId !== stage.selectionStageId || current.revision >= stage.revision) {
        throw new BatchDomainError('conflict', '成片已经有其他当前版本，不能覆盖');
      }
    }
    const result = readFormulaScheduleStageResult(db, scheduleStageId);
    if (!result || result.status !== 'planned') return null;
    const selectionRow = db.prepare('SELECT resultJson FROM live_mixcut_formula_selection_results WHERE stageId=?')
      .get(stage.selectionStageId) as { resultJson: string } | undefined;
    if (!selectionRow) throw new BatchDomainError('conflict', '排时间缺少选片结果');
    const selection = JSON.parse(selectionRow.resultJson) as import('./selection.ts').FormulaSelection;
    const timeline = result.timeline;

    const videoSources = timeline.clips.map(clip => ({ mediaId: clip.id, assetId: clip.assetId, contentFingerprint: clip.contentFingerprint }));
    const voFiles = new Map<number, SchedulingFile>();
    for (const item of result.plan.items) if (item.kind === 'vo') voFiles.set(item.slotIndex, item.file);
    const audioSources: FormulaOutputAudioSource[] = timeline.sounds.map(sound => {
      const words = timeline.words.filter(word => word.soundId === sound.id).map((word, index) => ({
        id: `${sound.id}:word:${index}`, text: word.text,
        sourceInUs: sound.sourceInUs + word.startUs - sound.timelineStartUs,
        sourceOutUs: sound.sourceInUs + word.endUs - sound.timelineStartUs,
      }));
      if (sound.kind === 'narration') return { mediaId: sound.id, kind: 'narration', contentFingerprint: sound.contentFingerprint,
        sourceDurationUs: sound.sourceOutUs, verifiedInUs: 0, verifiedOutUs: sound.sourceOutUs, words };
      const file = sound.slotIndex === null ? undefined : voFiles.get(sound.slotIndex);
      if (!file || sound.slotIndex === null || !sound.assetId) throw new BatchDomainError('conflict', '排时间的原声缺少来源文件');
      return { mediaId: sound.id, kind: 'source', contentFingerprint: sound.contentFingerprint,
        sourceDurationUs: file.durationUs, verifiedInUs: sound.sourceInUs, verifiedOutUs: sound.sourceOutUs,
        slotId: selectionSlotId(selection, sound.slotIndex), assetId: sound.assetId, words };
    });
    const basis: FormulaOutputBasis = { version: 1, selectionStageId: stage.selectionStageId, timelineStageId: scheduleStageId,
      videoSources, audioSources };
    const clips = timeline.clips.map(clip => ({ clipId: clip.id,
      segmentId: clip.slotIndex === undefined ? clip.id : selectionSlotId(selection, clip.slotIndex),
      assetId: clip.assetId, contentFingerprint: clip.contentFingerprint,
      sourceStartUs: clip.sourceInUs, sourceEndUs: clip.sourceOutUs,
      timelineStartUs: clip.timelineStartUs, timelineEndUs: clip.timelineEndUs, playbackRate: 1, locked: false }));
    const voClipOf = new Map<number, string>();
    for (const clip of timeline.clips) if (clip.slotIndex !== undefined) voClipOf.set(clip.slotIndex, clip.id);
    const production = parseFormulaProductionSettings(request.input.settings.settings.production);
    const arrangement: Record<string, unknown> = {
      schemaVersion: 'formula-output/1', planningMode: 'formula', preset: production.outputPreset, fps: FINAL_EDIT_FPS,
      formula: basis, clips, targetDurationUs: timeline.totalDurationUs, preserveGaps: true, editRevision: 0,
      productionReady: false, blockers: ['formula_execution_pending'], warnings: timeline.warnings,
      audioPlan: { version: 1, revision: 0, bodyDurationUs: timeline.totalDurationUs, issues: [],
        clips: timeline.sounds.map(sound => ({ id: sound.id, mediaId: sound.id, kind: sound.kind,
          sourceInUs: sound.sourceInUs, sourceOutUs: sound.sourceOutUs,
          timelineStartUs: sound.timelineStartUs, timelineEndUs: sound.timelineEndUs, gainDb: 0,
          ...(sound.kind === 'source' && sound.slotIndex !== null ? { linkedVideoClipId: voClipOf.get(sound.slotIndex) } : {}) })) },
      ...initialFormulaPresentation(request, row.planId, scheduleStageId, schedulePresentationTimeline(scheduleStageId, result, selection)),
      music: selectFormulaOutputMusic(request, row.planId),
    };
    reconcileFormulaOutputAudio(arrangement, clips);
    const outputVersionId = createOutputVersion(db, row.planId, { arrangementJson: arrangement });
    db.prepare('INSERT INTO live_mixcut_formula_schedule_output_versions (scheduleStageId,outputVersionId,createdAt) VALUES (?,?,?)')
      .run(scheduleStageId, outputVersionId, new Date().toISOString());
    queueFormulaScheduleExecutionCheck(db, projectId, batchId, outputVersionId);
    return outputVersionId;
  })();
}
