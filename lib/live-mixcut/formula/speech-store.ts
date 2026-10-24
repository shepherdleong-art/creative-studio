import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { BatchDomainError } from '../errors.ts';
import { createBatchTask, type BatchTaskStatus } from '../tasks.ts';
import { assertFormulaBatch } from './collection-store.ts';
import type { FormulaSelection } from './selection.ts';
import type { FormulaStage } from './selection-store.ts';
import type { FormulaGenerationRequest } from './generation.ts';
import type { FormulaSourceSpeech } from './source-speech.ts';
import type { FormulaSpeechService } from './speech-provider.ts';
import type { FormulaSavedManualSpeech } from './manual-speech.ts';

export interface FormulaSpeechStage {
  id: string; selectionStageId: string; assetId: string; contentFingerprint: string; revision: number;
  inputJson: string;
}
export interface FormulaSpeechView {
  planId: string; selectionStageId: string; executionReady: false;
  status: 'waiting_selection' | 'pending' | 'needs_attention' | 'inspected' | 'not_required';
  sources: Array<{ id: string; assetId: string; slotIds: string[]; revision: number;
    taskStatus: BatchTaskStatus | null; errorMessage: string | null; result: FormulaSourceSpeech | null }>;
}

/** 与选片结果在同一个提交事务内排队；每份每个实际来源独立落盘。 */
export function queueFormulaSpeech(db: Database.Database, projectId: string, batchId: string,
  stage: FormulaStage, request: FormulaGenerationRequest, selection: FormulaSelection): void {
  if (selection.status !== 'selected' || request.input.settings.settings.production.audio.mode === 'narration') return;
  for (const assetId of new Set(selection.slots.map(slot => slot.assetId!))) {
    const candidate = selection.slots.find(slot => slot.assetId === assetId)?.candidate;
    if (!candidate) throw new BatchDomainError('conflict', '原声检查缺少已核验的素材身份');
    let row = db.prepare('SELECT * FROM live_mixcut_formula_speech_stages WHERE selectionStageId=? AND assetId=? ORDER BY revision DESC LIMIT 1')
      .get(stage.id, assetId) as FormulaSpeechStage | undefined;
    if (!row) {
      const manual = request.input.manualSpeech?.find(item => item.assetId === assetId && item.contentFingerprint === candidate.contentFingerprint);
      row = { id: randomUUID(), selectionStageId: stage.id, assetId, contentFingerprint: candidate.contentFingerprint, revision: 1,
        inputJson: JSON.stringify({ formatVersion: 1, service: manual ? null : request.input.speechService ?? null,
          ...(manual ? { manualSpeech: manual } : {}) }) };
      db.prepare(`INSERT INTO live_mixcut_formula_speech_stages (id,selectionStageId,assetId,contentFingerprint,revision,inputJson,createdAt)
        VALUES (?,?,?,?,?,?,?)`).run(row.id, row.selectionStageId, assetId, row.contentFingerprint, row.revision, row.inputJson, new Date().toISOString());
    }
    createBatchTask(db, projectId, { batchId, workType: 'formula_stage', targetKind: 'formula_stage', targetId: row.id,
      requestKey: `formula:speech:${row.id}` });
  }
}

export function readFormulaSpeechStage(db: Database.Database, id: string): FormulaSpeechStage & { service: FormulaSpeechService | null; manualSpeech: FormulaSavedManualSpeech | null } {
  const row = db.prepare('SELECT * FROM live_mixcut_formula_speech_stages WHERE id=?').get(id) as FormulaSpeechStage | undefined;
  if (!row) throw new BatchDomainError('not_found', '原声检查任务不存在');
  const input = JSON.parse(row.inputJson);
  if (input.formatVersion !== 1) throw new BatchDomainError('conflict', '不支持这次原声检查的输入版本');
  return { ...row, service: input.service, manualSpeech: input.manualSpeech ?? null };
}

/** 只复用同项目、同内容、同处理/服务输入的成功依据；使用方仍须核验当前原片。 */
export function findReusableFormulaSpeech(db: Database.Database, projectId: string, source: FormulaSpeechStage): FormulaSourceSpeech | null {
  const saved = db.prepare(`SELECT s.id,x.resultJson FROM live_mixcut_formula_speech_stages s
    JOIN live_mixcut_formula_speech_results x ON x.stageId=s.id
    JOIN live_mixcut_formula_stages selection ON selection.id=s.selectionStageId
    JOIN live_mixcut_formula_generation_requests r ON r.id=selection.requestId
    WHERE r.projectId=? AND s.assetId=? AND s.contentFingerprint=? AND s.inputJson=? AND s.id<>?
      AND json_extract(x.resultJson,'$.algorithmVersion')='formula-source-speech/1'
      AND json_extract(x.resultJson,'$.status') IN ('transcribed','no_audio_stream','no_speech')
    ORDER BY x.createdAt,s.id LIMIT 1`).get(projectId, source.assetId, source.contentFingerprint, source.inputJson, source.id) as
      { id: string; resultJson: string } | undefined;
  if (!saved) return null;
  const result = JSON.parse(saved.resultJson) as FormulaSourceSpeech;
  if (result.assetId !== source.assetId || result.contentFingerprint !== source.contentFingerprint) return null;
  return { ...result, reusedFromStageId: saved.id };
}

export function readFormulaSpeech(db: Database.Database, projectId: string, batchId: string, planId: string,
  selectionStageId?: string): FormulaSpeechView {
  assertFormulaBatch(db, projectId, batchId);
  const owner = db.prepare(`SELECT r.inputJson FROM live_mixcut_formula_generation_outputs o JOIN live_mixcut_formula_generation_requests r ON r.id=o.requestId
    WHERE o.planId=? AND r.projectId=? AND r.batchId=?`).get(planId, projectId, batchId) as { inputJson: string } | undefined;
  if (!owner) throw new BatchDomainError('not_found', '这条公式制作记录不存在');
  const selected = db.prepare(`SELECT s.id,x.resultJson FROM live_mixcut_formula_stages s LEFT JOIN live_mixcut_formula_selection_results x ON x.stageId=s.id
    WHERE s.planId=? AND s.kind='select' ${selectionStageId ? 'AND s.id=?' : ''} ORDER BY s.revision DESC LIMIT 1`)
    .get(...(selectionStageId ? [planId, selectionStageId] : [planId])) as { id: string; resultJson: string | null } | undefined;
  if (!selected) throw new BatchDomainError('not_found', '这次选片修订不存在');
  const selection: FormulaSelection | null = selected.resultJson ? JSON.parse(selected.resultJson) : null;
  const rows = db.prepare(`SELECT s.id,s.assetId,s.revision,x.resultJson,t.status,a.errorMessage FROM live_mixcut_formula_speech_stages s
    LEFT JOIN live_mixcut_formula_speech_results x ON x.stageId=s.id
    LEFT JOIN live_mixcut_tasks t ON t.id=(SELECT latest.id FROM live_mixcut_tasks latest WHERE latest.workType='formula_stage' AND latest.targetId=s.id
      ORDER BY latest.createdAt DESC,latest.rowid DESC LIMIT 1)
    LEFT JOIN live_mixcut_task_attempts a ON a.taskId=t.id AND a.attemptNumber=t.attemptCount
    WHERE s.selectionStageId=? AND NOT EXISTS (SELECT 1 FROM live_mixcut_formula_speech_stages newer
      WHERE newer.selectionStageId=s.selectionStageId AND newer.assetId=s.assetId AND newer.revision>s.revision) ORDER BY s.assetId`)
    .all(selected.id) as Array<{ id: string; assetId: string; revision: number; resultJson: string | null; status: BatchTaskStatus | null; errorMessage: string | null }>;
  const sources = rows.map(row => ({ id: row.id, assetId: row.assetId, revision: row.revision, taskStatus: row.status, errorMessage: row.errorMessage,
    slotIds: selection?.slots.filter(slot => slot.assetId === row.assetId).map(slot => slot.slotId) ?? [],
    result: row.resultJson ? JSON.parse(row.resultJson) as FormulaSourceSpeech : null }));
  const narrationOnly = JSON.parse(owner.inputJson).settings.settings.production.audio.mode === 'narration';
  const status = !selection ? 'waiting_selection' : selection.status !== 'selected' ? 'needs_attention' : narrationOnly ? 'not_required'
    : sources.some(source => source.result?.status === 'needs_attention' || source.taskStatus === 'failed' || source.taskStatus === 'cancelled') ? 'needs_attention'
    : sources.length && sources.every(source => source.result) ? 'inspected' : 'pending';
  return { planId, selectionStageId: selected.id, executionReady: false, status, sources };
}
