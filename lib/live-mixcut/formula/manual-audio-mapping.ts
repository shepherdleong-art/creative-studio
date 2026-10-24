import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { BatchApiUnavailableError, BatchDomainError } from '../errors.ts';
import { formulaExecutionAvailable } from './execution-gate.ts';
import { readFormulaSelectionHistory, reselectFormulaOutput } from './reselection.ts';
import { readFormulaGenerationRequest } from './generation.ts';
import { readFormulaAudioMappingInput } from './audio-mapping-store.ts';
import { mapFormulaAudio, type FormulaAudioMappingInput, type FormulaMappedBlock } from './audio-mapping.ts';
import { verifyFormulaCandidate, recheckFormulaCandidate, type FormulaVerifiedCandidate } from './candidate-media.ts';

export interface FormulaManualAudioBlock {
  text: string; kind: FormulaMappedBlock['kind']; slotId?: string; slotIds?: string[]; displayText?: string;
}
interface ManualRecord { stageId: string; baseMappingStageId: string; inputJson: string; createdAt: string }
interface ManualInput { formatVersion: 1; blocks: FormulaManualAudioBlock[]; sourceSignature: string }
export interface FormulaManualAudioView {
  editable: boolean; reason: string | null; bodyText: string; blocks: FormulaManualAudioBlock[];
  expected: { expectedStageId: string; expectedMappingStageId: string | null; expectedOutputVersionId: string | null; expectedEditRevision: number };
  sources: Array<{ slotId: string; label: string; text: string }>;
  windows: Array<{ slotIds: string[]; label: string }>;
  pictures: Array<{ slotId: string; label: string }>;
  packagingEnabled: boolean;
  saved: { revisionId: string; confirmedAt: string } | null;
}
function cleanBlocks(blocks: FormulaMappedBlock[]): FormulaManualAudioBlock[] {
  return blocks.map(block => ({ text: block.text, kind: block.kind,
    ...(block.slotId ? { slotId: block.slotId } : {}), ...(block.slotIds ? { slotIds: block.slotIds } : {}),
    ...(block.displayText ? { displayText: block.displayText } : {}) }));
}
function sourceSignature(input: FormulaAudioMappingInput): string {
  return createHash('sha256').update(JSON.stringify({ mode: input.mode, bodyText: input.bodyText,
    slots: input.slots.map(slot => ({ slotId: slot.slotId, assetId: slot.assetId, contentFingerprint: slot.contentFingerprint,
      speech: slot.speech ? { ...slot.speech, reusedFromStageId: undefined } : null })) })).digest('hex');
}
function readRecord(db: Database.Database, stageId: string): ManualRecord | undefined {
  return db.prepare('SELECT * FROM live_mixcut_formula_manual_audio_inputs WHERE stageId=?').get(stageId) as ManualRecord | undefined;
}

export function readFormulaManualAudio(db: Database.Database, projectId: string, batchId: string, planId: string): FormulaManualAudioView {
  const history = readFormulaSelectionHistory(db, projectId, batchId, planId);
  const request = readFormulaGenerationRequest(db, projectId, batchId, history.requestId);
  const mappingId = history.current.audioMapping.stageId;
  const input = mappingId ? readFormulaAudioMappingInput(db, mappingId, request, planId).input : null;
  const output = request.outputs.find(output => output.planId === planId)!;
  const bodyText = request.input.scripts.find(script => script.key === output.scriptKey)!.bodyText;
  const saved = readRecord(db, history.current.id);
  const result = history.current.audioMapping.result;
  const available = input?.mode === 'narration' || (input?.mode === 'mixed' && input.slots.every(slot => slot.speech && slot.speech.status !== 'needs_attention'));
  const sources: FormulaManualAudioView['sources'] = [], windows: FormulaManualAudioView['windows'] = [];
  let currentWindow: string[] = [];
  const label = (slotIds: string[]) => '镜头 ' + history.slots.filter(slot => slotIds.includes(slot.slotId)).map(slot => `${slot.clipId + 1}（${slot.logicalCode}）`).join('、');
  const finishWindow = () => { if (currentWindow.length) windows.push({ slotIds: currentWindow, label: label(currentWindow) }); currentWindow = []; };
  for (const slot of input?.slots ?? []) {
    if (slot.speech?.status === 'transcribed') {
      finishWindow(); sources.push({ slotId: slot.slotId, label: label([slot.slotId]), text: slot.speech.text });
    } else if (slot.speech?.status === 'no_audio_stream' || slot.speech?.status === 'no_speech') currentWindow.push(slot.slotId);
    else finishWindow();
  }
  finishWindow();
  if (input?.mode === 'narration') windows.push({ slotIds: input.slots.map(slot => slot.slotId), label: label(input.slots.map(slot => slot.slotId)) });
  return { editable: history.editable && !!available,
    reason: !history.editable ? '当前批次或历史版本不能修改声音用途。' : request.input.settings.settings.production.audio.mode === 'original'
      ? '人工用途分配用于原声优先或统一配音模式。' : !available ? '请先完成本条原片的台词和声音检查。' : null,
    bodyText, sources, windows, pictures: history.slots.map(slot => ({ slotId: slot.slotId, label: label([slot.slotId]) })),
    packagingEnabled: request.input.settings.settings.production.packaging.mode !== 'none',
    blocks: saved ? (JSON.parse(saved.inputJson) as ManualInput).blocks : result?.status === 'mapped' ? cleanBlocks(result.blocks) : [],
    expected: { expectedStageId: history.current.id, expectedMappingStageId: mappingId,
      expectedOutputVersionId: history.outputVersion?.id ?? null, expectedEditRevision: history.outputVersion?.editRevision ?? 0 },
    saved: saved ? { revisionId: saved.stageId, confirmedAt: saved.createdAt } : null };
}

/** Worker 按原片与真实台词重验人工选择，缓存来源的变化不改变实际台词身份。 */
export function readFrozenFormulaManualAudio(db: Database.Database, selectionStageId: string, input: FormulaAudioMappingInput) {
  const row = readRecord(db, selectionStageId);
  if (!row) return null;
  const saved = JSON.parse(row.inputJson) as ManualInput;
  if (saved.formatVersion !== 1 || saved.sourceSignature !== sourceSignature(input)) {
    throw new BatchDomainError('conflict', '实际原声或脚本文案与人工确认时不同，请重新核对声音用途');
  }
  return { manual: { confirmed: true, blocks: saved.blocks }, verification: { revisionId: row.stageId, confirmedAt: row.createdAt } };
}

/** 追加这一条的制作修订，沿用原片选择；旧阶段、编辑版本、正式文件与其他份保留。 */
export async function saveFormulaManualAudio(db: Database.Database, projectId: string, batchId: string, planId: string, values: {
  requestKey: string; expectedStageId: string; expectedMappingStageId: string | null;
  expectedOutputVersionId: string | null; expectedEditRevision: number; confirmed: boolean; blocks: unknown;
}, signal: AbortSignal = new AbortController().signal): Promise<{ selectionStageId: string }> {
  if (!formulaExecutionAvailable(db)) throw new BatchApiUnavailableError('formula_unavailable', '实拍公式制作暂不可用');
  if (typeof values.requestKey !== 'string' || !values.requestKey.trim() || values.requestKey.length > 180 || /[\u0000-\u001f\u007f]/.test(values.requestKey)
    || typeof values.expectedStageId !== 'string' || !values.expectedStageId || typeof values.expectedMappingStageId !== 'string'
    || !values.expectedMappingStageId || (values.expectedOutputVersionId !== null && typeof values.expectedOutputVersionId !== 'string')
    || !Number.isSafeInteger(values.expectedEditRevision) || values.expectedEditRevision < 0) throw new BatchDomainError('invalid_input', '缺少有效的声音用途版本信息');
  const history = readFormulaSelectionHistory(db, projectId, batchId, planId);
  const request = readFormulaGenerationRequest(db, projectId, batchId, history.requestId);
  const owner = db.prepare('SELECT selectionStageId FROM live_mixcut_formula_audio_mapping_stages WHERE id=?').get(values.expectedMappingStageId) as { selectionStageId: string } | undefined;
  if (owner?.selectionStageId !== values.expectedStageId) throw new BatchDomainError('conflict', '声音依据已更新，请重新读取');
  const { input, selection } = readFormulaAudioMappingInput(db, values.expectedMappingStageId, request, planId);
  const validated = await mapFormulaAudio({ ...input, manual: { confirmed: values.confirmed, blocks: values.blocks } },
    async () => { throw new Error('人工声音用途不应调用模型'); }, signal);
  if (validated.status !== 'mapped') throw new BatchDomainError('invalid_input', validated.status === 'needs_attention'
    ? validated.issues.map(issue => issue.message).join('；') : '请先完成实际台词检查');
  const payload: ManualInput = { formatVersion: 1, blocks: cleanBlocks(validated.blocks), sourceSignature: sourceSignature(input) };
  const inputJson = JSON.stringify(payload), requestKey = `manual-audio:${values.requestKey}`;
  const replay = () => {
    const existing = db.prepare(`SELECT m.*,r.baseStageId,r.previousOutputVersionId,r.previousEditRevision
      FROM live_mixcut_formula_reselections r JOIN live_mixcut_formula_manual_audio_inputs m ON m.stageId=r.stageId
      WHERE r.planId=? AND r.requestKey=?`).get(planId, requestKey) as (ManualRecord & {
        baseStageId: string; previousOutputVersionId: string | null; previousEditRevision: number }) | undefined;
    if (!existing) return null;
    if (existing.inputJson !== inputJson || existing.baseStageId !== values.expectedStageId || existing.baseMappingStageId !== values.expectedMappingStageId
      || existing.previousOutputVersionId !== values.expectedOutputVersionId || existing.previousEditRevision !== values.expectedEditRevision) {
      throw new BatchDomainError('conflict', '同一次保存不能用于不同的声音用途或版本');
    }
    return { selectionStageId: existing.stageId };
  };
  const saved = replay(); if (saved) return saved;
  if (selection.status !== 'selected' || !history.editable || history.current.id !== values.expectedStageId
    || history.current.audioMapping.stageId !== values.expectedMappingStageId || (history.outputVersion?.id ?? null) !== values.expectedOutputVersionId
    || (history.outputVersion?.editRevision ?? 0) !== values.expectedEditRevision) throw new BatchDomainError('conflict', '这条成片已更新，请重新读取后保存');
  const verified: FormulaVerifiedCandidate[] = [];
  for (const slot of selection.slots) {
    if (verified.some(item => item.assetId === slot.assetId)) continue;
    const candidate = slot.candidate!;
    const actual = await verifyFormulaCandidate(db, projectId, candidate.assetId, candidate.contentFingerprint,
      [{ id: candidate.sourceId, location: candidate.location }], signal);
    if (!actual) throw new BatchDomainError('conflict', '原片无法核验，请恢复原片后再保存声音用途');
    verified.push(actual);
  }
  signal.throwIfAborted();
  return db.transaction(() => {
    const previous = replay(); if (previous) return previous;
    for (const candidate of verified) recheckFormulaCandidate(db, projectId, candidate);
    const next = reselectFormulaOutput(db, projectId, batchId, planId, { ...values, requestKey,
      overrides: selection.slots.map(slot => ({ slotId: slot.slotId, assetId: slot.assetId!, sourceLogicalCode: slot.sourceLogicalCode ?? slot.logicalCode })) });
    const createdAt = new Date().toISOString();
    db.prepare('INSERT INTO live_mixcut_formula_selection_results (stageId,resultJson,createdAt) VALUES (?,?,?)')
      .run(next.current.id, JSON.stringify(selection), createdAt);
    db.prepare('INSERT INTO live_mixcut_formula_manual_audio_inputs (stageId,baseMappingStageId,inputJson,createdAt) VALUES (?,?,?,?)')
      .run(next.current.id, values.expectedMappingStageId, inputJson, createdAt);
    return { selectionStageId: next.current.id };
  }).immediate();
}
