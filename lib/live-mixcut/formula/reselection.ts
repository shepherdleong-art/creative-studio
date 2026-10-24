import { randomBytes, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { BatchApiUnavailableError, BatchDomainError } from '../errors.ts';
import { createBatchTask, type BatchTaskStatus } from '../tasks.ts';
import { assertFormulaBatch } from './collection-store.ts';
import { readFormulaGenerationRequest, type FormulaGenerationRequest, type FormulaGenerationOutput } from './generation.ts';
import { formulaExecutionAvailable } from './execution-gate.ts';
import type { FormulaSlotChoice } from './selection-rules.ts';
import type { FormulaSelection } from './selection.ts';
import { readFormulaSpeech, type FormulaSpeechView } from './speech-store.ts';
import { readFormulaAudioMapping, type FormulaAudioMappingView } from './audio-mapping-store.ts';
import { readFormulaNarration, type FormulaNarrationView } from './narration-store.ts';
import { readFormulaTimeline, type FormulaTimelineView } from './timeline-store.ts';

export interface FormulaReselectionChoice { slotId: string; sourceLogicalCode: string; assetId: string }
export interface FormulaSelectionRevision {
  id: string; revision: number; createdAt: string; result: FormulaSelection | null;
  overrides: FormulaReselectionChoice[];
  task: { id: string; status: BatchTaskStatus; errorMessage: string | null } | null;
  speech: FormulaSpeechView;
  audioMapping: FormulaAudioMappingView;
  narration: FormulaNarrationView;
  timeline: FormulaTimelineView;
}
export interface FormulaSelectionHistory {
  planId: string; requestId: string; scriptNumber: string; copyIndex: number;
  slots: FormulaGenerationOutput['slots']; editable: boolean;
  outputVersion: { id: string; editRevision: number } | null;
  candidates: Array<{ assetId: string; logicalCode: string; sourceName: string }>;
  current: FormulaSelectionRevision; history: FormulaSelectionRevision[];
}
interface ReselectionRow {
  stageId: string; baseStageId: string; planId: string; requestKey: string; seed: string; inputJson: string;
  previousOutputVersionId: string | null; previousEditRevision: number;
}

function context(db: Database.Database, projectId: string, batchId: string, planId: string) {
  assertFormulaBatch(db, projectId, batchId);
  const identity = db.prepare(`SELECT o.requestId FROM live_mixcut_formula_generation_outputs o
    JOIN live_mixcut_formula_generation_requests r ON r.id=o.requestId WHERE o.planId=? AND r.projectId=? AND r.batchId=?`)
    .get(planId, projectId, batchId) as { requestId: string } | undefined;
  if (!identity) throw new BatchDomainError('not_found', '这条公式制作记录不存在');
  const request = readFormulaGenerationRequest(db, projectId, batchId, identity.requestId);
  const output = request.outputs.find(output => output.planId === planId)!;
  const batch = db.prepare('SELECT currentVersionId,controlState FROM live_mixcut_productions WHERE id=?').get(batchId) as { currentVersionId: string; controlState: string };
  const version = db.prepare(`SELECT v.id,v.arrangementJson FROM live_mixcut_output_plans p
    JOIN live_mixcut_output_versions v ON v.id=p.currentVersionId WHERE p.id=?`).get(planId) as { id: string; arrangementJson: string } | undefined;
  const revision: unknown = version ? JSON.parse(version.arrangementJson).editRevision : 0;
  const outputVersion = version ? { id: version.id, editRevision: typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0 ? revision : 0 } : null;
  return { request, output, batch, outputVersion };
}

function initialOverrides(request: FormulaGenerationRequest, output: FormulaGenerationOutput): FormulaSlotChoice[] {
  return request.input.selectionRules?.rules.overrides.filter(choice => choice.scriptKey === output.scriptKey) ?? [];
}

export function readFormulaStageOverrides(db: Database.Database, stageId: string): { seed: string; overrides: FormulaSlotChoice[] } | null {
  const row = db.prepare('SELECT seed,inputJson FROM live_mixcut_formula_reselections WHERE stageId=?').get(stageId) as { seed: string; inputJson: string } | undefined;
  return row ? { seed: row.seed, overrides: JSON.parse(row.inputJson).overrides } : null;
}

export function readFormulaSelectionHistory(db: Database.Database, projectId: string, batchId: string, planId: string): FormulaSelectionHistory {
  const { request, output, batch, outputVersion } = context(db, projectId, batchId, planId);
  const rows = db.prepare(`SELECT s.id,s.revision,s.createdAt,x.resultJson,r.inputJson,
    t.id AS taskId,t.status AS taskStatus,a.errorMessage FROM live_mixcut_formula_stages s
    LEFT JOIN live_mixcut_formula_selection_results x ON x.stageId=s.id LEFT JOIN live_mixcut_formula_reselections r ON r.stageId=s.id
    LEFT JOIN live_mixcut_tasks t ON t.id=(SELECT latest.id FROM live_mixcut_tasks latest
      WHERE latest.targetId=s.id AND latest.workType='formula_stage' ORDER BY latest.createdAt DESC,latest.rowid DESC LIMIT 1)
    LEFT JOIN live_mixcut_task_attempts a ON a.taskId=t.id AND a.attemptNumber=t.attemptCount
    WHERE s.planId=? AND s.kind='select' ORDER BY s.revision DESC`).all(planId) as Array<{
      id: string; revision: number; createdAt: string; resultJson: string | null; inputJson: string | null;
      taskId: string | null; taskStatus: BatchTaskStatus | null; errorMessage: string | null;
    }>;
  if (!rows.length) throw new BatchDomainError('conflict', '这条制作记录还没有选片阶段');
  const history = rows.map(row => {
    const overrides: FormulaSlotChoice[] = row.inputJson ? JSON.parse(row.inputJson).overrides : initialOverrides(request, output);
    return { id: row.id, revision: row.revision, createdAt: row.createdAt,
      result: row.resultJson ? JSON.parse(row.resultJson) as FormulaSelection : null,
      speech: readFormulaSpeech(db, projectId, batchId, planId, row.id),
      audioMapping: readFormulaAudioMapping(db, projectId, batchId, planId, row.id),
      narration: readFormulaNarration(db, projectId, batchId, planId, row.id),
      timeline: readFormulaTimeline(db, projectId, batchId, planId, row.id),
      overrides: overrides.map(choice => ({ slotId: output.slots.find(slot => slot.clipId === choice.slotIndex)!.slotId,
        sourceLogicalCode: choice.sourceLogicalCode, assetId: choice.assetId })),
      task: row.taskId && row.taskStatus ? { id: row.taskId, status: row.taskStatus, errorMessage: row.errorMessage } : null };
  });
  return { planId, requestId: request.id, scriptNumber: output.scriptNumber, copyIndex: output.copyIndex, slots: output.slots,
    editable: request.batchVersionId === batch.currentVersionId && batch.controlState !== 'stopped' && formulaExecutionAvailable(db),
    outputVersion, candidates: request.input.materialIndex.bindings.flatMap(binding => binding.logicalCode && binding.available && !binding.excludedReason
      ? [{ assetId: binding.assetId, logicalCode: binding.logicalCode, sourceName: binding.sourceName }] : []),
    current: history[0], history };
}

function parseOverrides(value: unknown, request: FormulaGenerationRequest, output: FormulaGenerationOutput): FormulaSlotChoice[] {
  if (!Array.isArray(value) || value.length > output.slots.length) throw new BatchDomainError('invalid_input', '重选镜头设置无效');
  const seen = new Set<string>();
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !['slotId','sourceLogicalCode','assetId'].includes(key))) {
      throw new BatchDomainError('invalid_input', '重选镜头设置格式不正确');
    }
    const slot = output.slots.find(slot => slot.slotId === item.slotId);
    if (!slot || seen.has(slot.slotId)) throw new BatchDomainError('invalid_input', '重选镜头不属于当前成片或重复');
    seen.add(slot.slotId);
    const binding = request.input.materialIndex.bindings.find(binding => binding.assetId === item.assetId
      && binding.logicalCode === item.sourceLogicalCode && binding.logicalCode && binding.available && !binding.excludedReason);
    if (!binding) throw new BatchDomainError('invalid_input', '请选择这次制作输入中的正式候选素材');
    return { scriptKey: output.scriptKey, slotIndex: slot.clipId, logicalCode: slot.logicalCode,
      sourceLogicalCode: binding.logicalCode!, assetId: binding.assetId, contentFingerprint: binding.contentFingerprint };
  }).sort((a, b) => a.slotIndex - b.slotIndex);
}

/** 只为这条输出追加选片修订，旧结果/正式文件保留；同一请求重复提交不再建修订。 */
export function reselectFormulaOutput(db: Database.Database, projectId: string, batchId: string, planId: string, input: {
  requestKey: string; expectedStageId: string; expectedOutputVersionId: string | null; expectedEditRevision: number; overrides?: unknown;
}): FormulaSelectionHistory {
  if (!formulaExecutionAvailable(db)) throw new BatchApiUnavailableError('formula_unavailable', '公式制作尚未启用或数据结构未就绪');
  if (typeof input.requestKey !== 'string' || !input.requestKey.trim() || input.requestKey.length > 200 || /[\u0000-\u001f\u007f]/.test(input.requestKey)
    || typeof input.expectedStageId !== 'string' || !input.expectedStageId || (input.expectedOutputVersionId !== null && typeof input.expectedOutputVersionId !== 'string')
    || !Number.isSafeInteger(input.expectedEditRevision) || input.expectedEditRevision < 0) throw new BatchDomainError('invalid_input', '重选请求缺少有效的版本信息');
  return db.transaction(() => {
    const { request, output, batch, outputVersion } = context(db, projectId, batchId, planId);
    const base = db.prepare("SELECT id FROM live_mixcut_formula_stages WHERE id=? AND planId=? AND kind='select'")
      .get(input.expectedStageId, planId);
    if (!base) throw new BatchDomainError('conflict', '选片记录已经变化，请重新读取');
    const baseOverrides = readFormulaStageOverrides(db, input.expectedStageId)?.overrides ?? initialOverrides(request, output);
    const overrides = input.overrides === undefined ? baseOverrides : parseOverrides(input.overrides, request, output);
    const inputJson = JSON.stringify({ version: 1, overrides });
    const existing = db.prepare('SELECT * FROM live_mixcut_formula_reselections WHERE planId=? AND requestKey=?').get(planId, input.requestKey) as ReselectionRow | undefined;
    if (existing) {
      if (existing.baseStageId !== input.expectedStageId || existing.inputJson !== inputJson || existing.previousOutputVersionId !== input.expectedOutputVersionId
        || existing.previousEditRevision !== input.expectedEditRevision) throw new BatchDomainError('conflict', '同一个重选请求不能用于不同的镜头或版本');
      return readFormulaSelectionHistory(db, projectId, batchId, planId);
    }
    const view = readFormulaSelectionHistory(db, projectId, batchId, planId);
    if (!view.editable || batch.currentVersionId !== request.batchVersionId) throw new BatchDomainError('conflict', '旧批次输入或已停止的批次不能重选');
    if (view.current.id !== input.expectedStageId || (outputVersion?.id ?? null) !== input.expectedOutputVersionId
      || (outputVersion?.editRevision ?? 0) !== input.expectedEditRevision) throw new BatchDomainError('conflict', '这条成片已更新，请重新读取后重选');
    const stageId = randomUUID();
    const now = new Date().toISOString();
    db.prepare('INSERT INTO live_mixcut_formula_stages (id,requestId,planId,kind,revision,createdAt) VALUES (?,?,?,\'select\',?,?)')
      .run(stageId, request.id, planId, view.current.revision + 1, now);
    db.prepare(`INSERT INTO live_mixcut_formula_reselections (stageId,baseStageId,planId,requestKey,seed,inputJson,previousOutputVersionId,previousEditRevision)
      VALUES (?,?,?,?,?,?,?,?)`).run(stageId, view.current.id, planId, input.requestKey, randomBytes(32).toString('hex'), inputJson,
      input.expectedOutputVersionId, input.expectedEditRevision);
    db.prepare(`UPDATE live_mixcut_tasks SET expectedState='stopped',status=CASE WHEN status='running' THEN status ELSE 'cancelled' END,updatedAt=?
      WHERE batchId=? AND status IN ('queued','running','failed') AND (
        (workType='formula_stage' AND targetId IN (SELECT id FROM live_mixcut_formula_execution_stages WHERE planId=? AND id<>?))
        OR (workType='render' AND targetId IN (SELECT id FROM live_mixcut_output_versions WHERE planId=?)))`).run(now, batchId, planId, stageId, planId);
    // 保留旧版本和正式产物指针；新修订完成前不继续使用旧的可审核/导出候选。
    db.prepare('UPDATE live_mixcut_output_plans SET currentVersionId=NULL WHERE id=?').run(planId);
    createBatchTask(db, projectId, { batchId, workType: 'formula_stage', targetKind: 'formula_stage', targetId: stageId, requestKey: `formula:select:${stageId}` });
    return readFormulaSelectionHistory(db, projectId, batchId, planId);
  }).immediate();
}
