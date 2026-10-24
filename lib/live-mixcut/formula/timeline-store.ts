import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { BatchDomainError } from '../errors.ts';
import { createBatchTask, type BatchTaskStatus } from '../tasks.ts';
import { assertFormulaBatch } from './collection-store.ts';
import type { FormulaGenerationRequest } from './generation.ts';
import type { FormulaAudioMapping } from './audio-mapping.ts';
import type { FormulaSelection } from './selection.ts';
import type { FormulaNarrationStageResult } from './narration-store.ts';
import { parseFormulaTimingSettings } from './timing-settings.ts';
import type { FormulaTimelineInput, FormulaTimelineResult } from './timeline.ts';

export interface FormulaTimelineView {
  selectionStageId: string; stageId: string | null; taskStatus: BatchTaskStatus | null; errorMessage: string | null;
  result: FormulaTimelineResult | null;
}

function settings(request: FormulaGenerationRequest, planId: string) {
  const output = request.outputs.find(output => output.planId === planId);
  const script = request.input.scripts.find(script => script.key === output?.scriptKey);
  if (!script) throw new BatchDomainError('conflict', '时长安排缺少当前输出的脚本');
  const timing = parseFormulaTimingSettings(request.input.settings.settings.timing);
  return { formatVersion: 1, target: { mode: timing.mode, scope: timing.scope,
    durationUs: Math.round((timing.overrideDurationSec ?? script.targetDurationSec) * 1_000_000) }, speechMarginUs: timing.speechMarginMs * 1_000 };
}

/** 只有该份全部必需声音已保存才排片，其他输出无需等待。 */
export function queueFormulaTimeline(db: Database.Database, projectId: string, batchId: string,
  selectionStageId: string, request: FormulaGenerationRequest): void {
  const mapping = db.prepare(`SELECT a.id,s.planId,x.resultJson,n.id AS narrationId,v.resultJson AS narrationJson
    FROM live_mixcut_formula_audio_mapping_stages a JOIN live_mixcut_formula_stages s ON s.id=a.selectionStageId
    JOIN live_mixcut_formula_audio_mapping_results x ON x.stageId=a.id
    LEFT JOIN live_mixcut_formula_narration_stages n ON n.audioMappingStageId=a.id LEFT JOIN live_mixcut_formula_narration_results v ON v.stageId=n.id
    WHERE a.selectionStageId=? ORDER BY a.revision DESC LIMIT 1`).get(selectionStageId) as
      { id: string; planId: string; resultJson: string; narrationId: string | null; narrationJson: string | null } | undefined;
  if (!mapping) return;
  const result: FormulaAudioMapping = JSON.parse(mapping.resultJson);
  if (result.status !== 'mapped' || (result.narrations.length && (!mapping.narrationJson || JSON.parse(mapping.narrationJson).status !== 'ready'))) return;
  let stage = db.prepare('SELECT id FROM live_mixcut_formula_timeline_stages WHERE audioMappingStageId=?').get(mapping.id) as { id: string } | undefined;
  if (!stage) {
    stage = { id: randomUUID() };
    db.prepare('INSERT INTO live_mixcut_formula_timeline_stages (id,audioMappingStageId,narrationStageId,inputJson,createdAt) VALUES (?,?,?,?,?)')
      .run(stage.id, mapping.id, result.narrations.length ? mapping.narrationId : null, JSON.stringify(settings(request, mapping.planId)), new Date().toISOString());
  }
  createBatchTask(db, projectId, { batchId, workType: 'formula_stage', targetKind: 'formula_stage', targetId: stage.id, requestKey: `formula:timeline:${stage.id}` });
}

export function readFormulaTimelineInput(db: Database.Database, stageId: string, request: FormulaGenerationRequest,
  planId: string): { input: FormulaTimelineInput; selection: FormulaSelection } {
  const row = db.prepare(`SELECT t.inputJson,t.audioMappingStageId,t.narrationStageId,m.resultJson AS mappingJson,n.resultJson AS narrationJson,
      x.resultJson AS selectionJson,s.requestId,s.planId FROM live_mixcut_formula_timeline_stages t
    JOIN live_mixcut_formula_audio_mapping_stages a ON a.id=t.audioMappingStageId JOIN live_mixcut_formula_audio_mapping_results m ON m.stageId=a.id
    JOIN live_mixcut_formula_stages s ON s.id=a.selectionStageId JOIN live_mixcut_formula_selection_results x ON x.stageId=s.id
    LEFT JOIN live_mixcut_formula_narration_results n ON n.stageId=t.narrationStageId WHERE t.id=?`).get(stageId) as
      { inputJson: string; audioMappingStageId: string; narrationStageId: string | null; mappingJson: string; narrationJson: string | null;
        selectionJson: string; requestId: string; planId: string } | undefined;
  if (!row || row.requestId !== request.id || row.planId !== planId) throw new BatchDomainError('conflict', '时间线目标与制作请求不一致');
  const frozen = settings(request, planId);
  if (JSON.stringify(frozen) !== row.inputJson) throw new BatchDomainError('conflict', '时间线时长设置与冻结输入不一致');
  const selection: FormulaSelection = JSON.parse(row.selectionJson);
  if (selection.status !== 'selected') throw new BatchDomainError('conflict', '时间线尚无完整选片');
  return { selection, input: { ...frozen, slots: selection.slots.map(slot => ({ slotId: slot.slotId, logicalCode: slot.logicalCode,
    assetId: slot.assetId!, contentFingerprint: slot.candidate!.contentFingerprint, sourceId: slot.candidate!.sourceId,
    mediaDurationUs: slot.media!.durationUs, sourceFps: slot.media!.fps, ranges: slot.approvedRanges?.ranges ?? [] })),
    mapping: { stageId: row.audioMappingStageId, result: JSON.parse(row.mappingJson) },
    narration: row.narrationStageId && row.narrationJson ? { stageId: row.narrationStageId, result: JSON.parse(row.narrationJson) as FormulaNarrationStageResult } : null } };
}

export function readFormulaTimeline(db: Database.Database, projectId: string, batchId: string, planId: string,
  selectionStageId?: string): FormulaTimelineView {
  assertFormulaBatch(db, projectId, batchId);
  const selection = db.prepare(`SELECT s.id FROM live_mixcut_formula_stages s JOIN live_mixcut_formula_generation_requests r ON r.id=s.requestId
    WHERE s.planId=? AND r.projectId=? AND r.batchId=? AND s.kind='select' ${selectionStageId ? 'AND s.id=?' : ''}
    ORDER BY s.revision DESC LIMIT 1`).get(...[planId, projectId, batchId, ...(selectionStageId ? [selectionStageId] : [])]) as { id: string } | undefined;
  if (!selection) throw new BatchDomainError('not_found', '这条成片的时长安排不存在');
  const row = db.prepare(`SELECT t.id,x.resultJson,j.status,a.errorMessage FROM live_mixcut_formula_audio_mapping_stages m
    JOIN live_mixcut_formula_timeline_stages t ON t.audioMappingStageId=m.id LEFT JOIN live_mixcut_formula_timeline_results x ON x.stageId=t.id
    LEFT JOIN live_mixcut_tasks j ON j.id=(SELECT id FROM live_mixcut_tasks WHERE workType='formula_stage' AND targetId=t.id ORDER BY createdAt DESC,rowid DESC LIMIT 1)
    LEFT JOIN live_mixcut_task_attempts a ON a.taskId=j.id AND a.attemptNumber=j.attemptCount
    WHERE m.selectionStageId=? ORDER BY m.revision DESC LIMIT 1`).get(selection.id) as
      { id: string; resultJson: string | null; status: BatchTaskStatus | null; errorMessage: string | null } | undefined;
  return { selectionStageId: selection.id, stageId: row?.id ?? null, taskStatus: row?.status ?? null, errorMessage: row?.errorMessage ?? null,
    result: row?.resultJson ? JSON.parse(row.resultJson) as FormulaTimelineResult : null };
}
