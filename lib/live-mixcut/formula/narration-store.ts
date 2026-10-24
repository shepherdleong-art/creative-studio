import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type Database from 'better-sqlite3';
import { BatchDomainError } from '../errors.ts';
import { createBatchTask, type BatchTaskStatus } from '../tasks.ts';
import { assertFormulaBatch } from './collection-store.ts';
import type { FormulaGenerationRequest } from './generation.ts';
import type { FormulaAudioMapping } from './audio-mapping.ts';
import { assertFormulaNarrationAudio, formulaNarrationReuseKey, type FormulaNarrationAudio, type FormulaTtsService } from './narration.ts';
import { projectAssetFileIdentity } from '../project-asset-media.ts';
import type { FormulaExternalNarration } from './external-narration.ts';
import { speechContent } from '../../media-core/adapters/alignment.ts';

type Narration = Extract<FormulaAudioMapping, { status: 'mapped' }>['narrations'][number];
export interface FormulaNarrationStageInput {
  formatVersion: 1; service: FormulaTtsService | null; narrations: Narration[]; reuseKeys: string[];
  externalNarration?: FormulaExternalNarration;
}
export interface FormulaNarrationStageResult {
  status: 'ready'; executionReady: false; algorithmVersion: 'formula-narration-stage/1';
  items: Array<Narration & { audio: FormulaNarrationAudio }>;
}
export interface FormulaNarrationView {
  selectionStageId: string; stageId: string | null; taskStatus: BatchTaskStatus | null; errorMessage: string | null;
  status: 'waiting_mapping' | 'not_required' | 'unconfigured' | 'pending' | 'ready' | 'needs_attention';
  result: FormulaNarrationStageResult | null;
}

function frozenInput(mapping: FormulaAudioMapping, request: FormulaGenerationRequest, planId: string): FormulaNarrationStageInput | null {
  if (mapping.status !== 'mapped' || !mapping.narrations.length) return null;
  const scriptKey = request.outputs.find(item => item.planId === planId)?.scriptKey;
  const external = request.input.externalNarrations?.find(item => item.scriptKey === scriptKey);
  if (external) {
    if (!external.audio || mapping.mode !== 'narration' || mapping.narrations.length !== 1
      || speechContent(mapping.narrations[0].text) !== speechContent(external.text)) {
      throw new BatchDomainError('conflict', '外部配音与实际朗读文案不一致，请重新核对整篇配音和声音用途分配');
    }
    return { formatVersion: 1, service: null, narrations: mapping.narrations, reuseKeys: [], externalNarration: external };
  }
  if (!request.input.ttsService) return null;
  return { formatVersion: 1, service: request.input.ttsService, narrations: mapping.narrations,
    reuseKeys: [...new Set(mapping.narrations.map(item => formulaNarrationReuseKey(item.text, request.input.ttsService!)))].sort() };
}

/** 与映射结果同事务入队；每份单独保存声音，缓存复用不广播修改其他份。 */
export function queueFormulaNarration(db: Database.Database, projectId: string, batchId: string,
  selectionStageId: string, request: FormulaGenerationRequest): void {
  const mapping = db.prepare(`SELECT a.id,x.resultJson,s.planId FROM live_mixcut_formula_audio_mapping_stages a
    JOIN live_mixcut_formula_stages s ON s.id=a.selectionStageId
    JOIN live_mixcut_formula_audio_mapping_results x ON x.stageId=a.id WHERE a.selectionStageId=? ORDER BY a.revision DESC LIMIT 1`)
    .get(selectionStageId) as { id: string; resultJson: string; planId: string } | undefined;
  if (!mapping) return;
  const input = frozenInput(JSON.parse(mapping.resultJson), request, mapping.planId);
  if (!input) return;
  let stage = db.prepare('SELECT id FROM live_mixcut_formula_narration_stages WHERE audioMappingStageId=?').get(mapping.id) as { id: string } | undefined;
  if (!stage) {
    stage = { id: randomUUID() };
    db.prepare('INSERT INTO live_mixcut_formula_narration_stages (id,audioMappingStageId,inputJson,createdAt) VALUES (?,?,?,?)')
      .run(stage.id, mapping.id, JSON.stringify(input), new Date().toISOString());
  }
  createBatchTask(db, projectId, { batchId, workType: 'formula_stage', targetKind: 'formula_stage', targetId: stage.id,
    requestKey: `formula:narration:${stage.id}` });
}

export function readFormulaNarrationInput(db: Database.Database, stageId: string, request: FormulaGenerationRequest,
  planId: string): FormulaNarrationStageInput {
  const row = db.prepare(`SELECT n.inputJson,x.resultJson,s.planId,s.requestId FROM live_mixcut_formula_narration_stages n
    JOIN live_mixcut_formula_audio_mapping_stages a ON a.id=n.audioMappingStageId
    JOIN live_mixcut_formula_audio_mapping_results x ON x.stageId=a.id JOIN live_mixcut_formula_stages s ON s.id=a.selectionStageId
    WHERE n.id=?`).get(stageId) as { inputJson: string; resultJson: string; planId: string; requestId: string } | undefined;
  if (!row || row.planId !== planId || row.requestId !== request.id) throw new BatchDomainError('conflict', '配音目标与制作请求不一致');
  const expected = frozenInput(JSON.parse(row.resultJson), request, planId);
  if (!expected || JSON.stringify(expected) !== row.inputJson) throw new BatchDomainError('conflict', '配音文案或声音设置与冻结记录不一致');
  return expected;
}

export function readFormulaNarration(db: Database.Database, projectId: string, batchId: string, planId: string,
  selectionStageId?: string): FormulaNarrationView {
  assertFormulaBatch(db, projectId, batchId);
  const selection = db.prepare(`SELECT s.id,r.inputJson FROM live_mixcut_formula_stages s JOIN live_mixcut_formula_generation_requests r ON r.id=s.requestId
    WHERE s.planId=? AND r.projectId=? AND r.batchId=? AND s.kind='select' ${selectionStageId ? 'AND s.id=?' : ''}
    ORDER BY s.revision DESC LIMIT 1`).get(...[planId, projectId, batchId, ...(selectionStageId ? [selectionStageId] : [])]) as
      { id: string; inputJson: string } | undefined;
  if (!selection) throw new BatchDomainError('not_found', '这条成片的配音记录不存在');
  const row = db.prepare(`SELECT n.id,m.resultJson AS mappingJson,x.resultJson,t.status,a.errorMessage FROM live_mixcut_formula_audio_mapping_stages s
    LEFT JOIN live_mixcut_formula_audio_mapping_results m ON m.stageId=s.id
    LEFT JOIN live_mixcut_formula_narration_stages n ON n.audioMappingStageId=s.id
    LEFT JOIN live_mixcut_formula_narration_results x ON x.stageId=n.id
    LEFT JOIN live_mixcut_tasks t ON t.id=(SELECT id FROM live_mixcut_tasks WHERE workType='formula_stage' AND targetId=n.id ORDER BY createdAt DESC,rowid DESC LIMIT 1)
    LEFT JOIN live_mixcut_task_attempts a ON a.taskId=t.id AND a.attemptNumber=t.attemptCount
    WHERE s.selectionStageId=? ORDER BY s.revision DESC LIMIT 1`).get(selection.id) as
      { id: string | null; mappingJson: string | null; resultJson: string | null; status: BatchTaskStatus | null; errorMessage: string | null } | undefined;
  const mapping: FormulaAudioMapping | null = row?.mappingJson ? JSON.parse(row.mappingJson) : null;
  const result: FormulaNarrationStageResult | null = row?.resultJson ? JSON.parse(row.resultJson) : null;
  const status = result ? 'ready' : mapping?.status === 'needs_attention' ? 'needs_attention' : mapping?.status !== 'mapped' ? 'waiting_mapping'
    : !mapping.narrations.length ? 'not_required' : !row?.id && !JSON.parse(selection.inputJson).ttsService ? 'unconfigured'
    : row?.status === 'failed' || row?.status === 'cancelled' ? 'needs_attention' : 'pending';
  return { selectionStageId: selection.id, stageId: row?.id ?? null, taskStatus: row?.status ?? null,
    errorMessage: row?.errorMessage ?? null, status, result };
}

export function resolveFormulaNarrationMedia(db: Database.Database, projectId: string, batchId: string, planId: string,
  selectionStageId: string, narrationId: string) {
  if (!selectionStageId || !narrationId) throw new BatchDomainError('invalid_input', '缺少要试听的配音记录');
  const view = readFormulaNarration(db, projectId, batchId, planId, selectionStageId);
  const item = view.result?.items.find(item => item.id === narrationId);
  if (!item) throw new BatchDomainError('not_found', '这段配音尚未完成或不属于当前记录');
  const absolutePath = assertFormulaNarrationAudio(projectId, item.text, item.audio);
  return { absolutePath, identity: projectAssetFileIdentity(fs.statSync(absolutePath)) };
}
