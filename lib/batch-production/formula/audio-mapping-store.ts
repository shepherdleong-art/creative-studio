import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { BatchDomainError } from '../errors.ts';
import { createBatchTask, type BatchTaskStatus } from '../tasks.ts';
import { assertFormulaBatch } from './collection-store.ts';
import type { FormulaGenerationRequest } from './generation.ts';
import type { FormulaSelection } from './selection.ts';
import type { FormulaAudioMapping, FormulaAudioMappingInput } from './audio-mapping.ts';
import type { FormulaSourceSpeech } from './source-speech.ts';

export interface FormulaAudioMappingView {
  planId: string; selectionStageId: string; stageId: string | null; taskStatus: BatchTaskStatus | null;
  errorMessage: string | null; result: FormulaAudioMapping | null;
}

/** 调用方与选片/最后一个原声结果在同一事务提交，按份自动续接。 */
export function queueFormulaAudioMapping(db: Database.Database, projectId: string, batchId: string,
  selectionStageId: string, request: FormulaGenerationRequest): void {
  const selectionRow = db.prepare('SELECT resultJson FROM batch_formula_selection_results WHERE stageId=?').get(selectionStageId) as { resultJson: string } | undefined;
  const selection = selectionRow ? JSON.parse(selectionRow.resultJson) as FormulaSelection : null;
  if (selection?.status !== 'selected') return;
  const sourceIds: string[] = [];
  if (request.input.settings.settings.production.audio.mode !== 'narration') {
    for (const assetId of new Set(selection.slots.map(slot => slot.assetId!))) {
      const source = db.prepare(`SELECT s.id,x.stageId AS completed FROM batch_formula_speech_stages s
        LEFT JOIN batch_formula_speech_results x ON x.stageId=s.id WHERE s.selectionStageId=? AND s.assetId=?
        ORDER BY s.revision DESC LIMIT 1`).get(selectionStageId, assetId) as { id: string; completed: string | null } | undefined;
      if (!source?.completed) return;
      sourceIds.push(source.id);
    }
  }
  let row = db.prepare('SELECT id FROM batch_formula_audio_mapping_stages WHERE selectionStageId=? ORDER BY revision DESC LIMIT 1')
    .get(selectionStageId) as { id: string } | undefined;
  if (!row) {
    row = { id: randomUUID() };
    db.prepare(`INSERT INTO batch_formula_audio_mapping_stages (id,selectionStageId,revision,inputJson,createdAt) VALUES (?,?,1,?,?)`)
      .run(row.id, selectionStageId, JSON.stringify({ formatVersion: 1, speechStageIds: sourceIds.sort() }), new Date().toISOString());
  }
  createBatchTask(db, projectId, { batchId, workType: 'formula_stage', targetKind: 'formula_stage', targetId: row.id,
    requestKey: `formula:audio-mapping:${row.id}` });
}

export function readFormulaAudioMappingInput(db: Database.Database, stageId: string, request: FormulaGenerationRequest,
  planId: string): { input: FormulaAudioMappingInput; selection: FormulaSelection } {
  const row = db.prepare(`SELECT a.inputJson,x.resultJson,s.planId,s.requestId FROM batch_formula_audio_mapping_stages a
    JOIN batch_formula_stages s ON s.id=a.selectionStageId JOIN batch_formula_selection_results x ON x.stageId=s.id
    WHERE a.id=?`).get(stageId) as { inputJson: string; resultJson: string; planId: string; requestId: string } | undefined;
  if (!row || row.planId !== planId || row.requestId !== request.id) throw new BatchDomainError('conflict', '声音映射目标与制作请求不一致');
  const frozen = JSON.parse(row.inputJson) as { formatVersion: number; speechStageIds: string[] };
  if (frozen.formatVersion !== 1 || !Array.isArray(frozen.speechStageIds)) throw new BatchDomainError('conflict', '声音映射输入版本无效');
  const selection = JSON.parse(row.resultJson) as FormulaSelection;
  const sources = frozen.speechStageIds.map(id => {
    const saved = db.prepare(`SELECT s.assetId,s.selectionStageId,x.resultJson FROM batch_formula_speech_stages s
      JOIN batch_formula_speech_results x ON x.stageId=s.id JOIN batch_formula_audio_mapping_stages a ON a.selectionStageId=s.selectionStageId
      WHERE s.id=? AND a.id=?`).get(id, stageId) as { assetId: string; resultJson: string } | undefined;
    if (!saved) throw new BatchDomainError('conflict', '声音映射引用的原声依据缺失或不属于本次选片');
    return { id, assetId: saved.assetId, speech: JSON.parse(saved.resultJson) as FormulaSourceSpeech };
  });
  const output = request.outputs.find(output => output.planId === planId)!;
  const script = request.input.scripts.find(script => script.key === output.scriptKey);
  if (!script) throw new BatchDomainError('conflict', '声音映射缺少原脚本文案');
  return { selection, input: { mode: request.input.settings.settings.production.audio.mode, bodyText: script.bodyText,
    packagingEnabled: request.input.settings.settings.production.packaging.mode !== 'none',
    slots: selection.slots.map(slot => ({ slotId: slot.slotId, assetId: slot.assetId!, contentFingerprint: slot.candidate!.contentFingerprint,
      speechStageId: sources.find(source => source.assetId === slot.assetId)?.id ?? null,
      speech: sources.find(source => source.assetId === slot.assetId)?.speech ?? null })) } };
}

export function readFormulaAudioMapping(db: Database.Database, projectId: string, batchId: string, planId: string,
  selectionStageId?: string): FormulaAudioMappingView {
  assertFormulaBatch(db, projectId, batchId);
  const selection = db.prepare(`SELECT s.id FROM batch_formula_stages s JOIN batch_formula_generation_requests r ON r.id=s.requestId
    WHERE s.planId=? AND r.projectId=? AND r.batchId=? AND s.kind='select' ${selectionStageId ? 'AND s.id=?' : ''}
    ORDER BY s.revision DESC LIMIT 1`).get(...[planId, projectId, batchId, ...(selectionStageId ? [selectionStageId] : [])]) as { id: string } | undefined;
  if (!selection) throw new BatchDomainError('not_found', '这条成片的声音映射记录不存在');
  const row = db.prepare(`SELECT s.id,x.resultJson,t.status,a.errorMessage FROM batch_formula_audio_mapping_stages s
    LEFT JOIN batch_formula_audio_mapping_results x ON x.stageId=s.id
    LEFT JOIN batch_tasks t ON t.id=(SELECT id FROM batch_tasks WHERE workType='formula_stage' AND targetId=s.id ORDER BY createdAt DESC,rowid DESC LIMIT 1)
    LEFT JOIN batch_task_attempts a ON a.taskId=t.id AND a.attemptNumber=t.attemptCount
    WHERE s.selectionStageId=? ORDER BY s.revision DESC LIMIT 1`).get(selection.id) as
      { id: string; resultJson: string | null; status: BatchTaskStatus; errorMessage: string | null } | undefined;
  return { planId, selectionStageId: selection.id, stageId: row?.id ?? null, taskStatus: row?.status ?? null,
    errorMessage: row?.errorMessage ?? null, result: row?.resultJson ? JSON.parse(row.resultJson) as FormulaAudioMapping : null };
}
