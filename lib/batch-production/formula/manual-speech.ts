import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { BatchDomainError } from '../errors.ts';
import { listAssetSources } from '../media-catalog.ts';
import { assertFormulaBatch, getFormulaCollection } from './collection-store.ts';
import { getFormulaMaterialIndex } from './material-bindings.ts';
import { readFormulaInputEditing } from './input-editing.ts';
import { formulaExecutionAvailable } from './execution-gate.ts';
import { verifyFormulaCandidate, recheckFormulaCandidate } from './candidate-media.ts';

export type FormulaManualSpeechMode = 'automatic' | 'speech' | 'no_speech';
export interface FormulaManualSpeechSegment { text: string; startUs: number; endUs: number }
export interface FormulaSavedManualSpeech {
  id: string; assetId: string; contentFingerprint: string; revision: number; baseInputRevision: number; createdAt: string;
  formatVersion: 1; origin: 'manual'; mode: FormulaManualSpeechMode; mediaDurationUs: number;
  segments: FormulaManualSpeechSegment[];
}
export interface FormulaManualSpeechView {
  inputRevision: number; editable: boolean;
  items: Array<{ assetId: string; contentFingerprint: string; names: string[]; available: boolean;
    saved: FormulaSavedManualSpeech | null;
    automatic: { text: string; segments: FormulaManualSpeechSegment[] } | null }>;
}

/** Human timestamps are used exactly as supplied; never invent word timing from a sentence. */
export function parseFormulaManualSpeech(mode: unknown, value: unknown, durationUs: number) {
  if (!['automatic', 'speech', 'no_speech'].includes(mode as string) || !Array.isArray(value) || value.length > 1000
    || (mode === 'speech' ? value.length === 0 : value.length !== 0)) {
    throw new BatchDomainError('invalid_input', '请选择原声处理方式；有人声时须填写台词和时间，其他方式不填写台词');
  }
  let previousEnd = 0, characters = 0;
  const segments: FormulaManualSpeechSegment[] = value.map(segment => {
    if (!segment || typeof segment !== 'object' || Array.isArray(segment) || typeof segment.text !== 'string'
      || !/[\p{L}\p{N}]/u.test(segment.text) || !Number.isSafeInteger(segment.startUs) || !Number.isSafeInteger(segment.endUs)
      || segment.startUs < previousEnd || segment.endUs <= segment.startUs || segment.endUs > durationUs) {
      throw new BatchDomainError('invalid_input', '请填写实际台词，时间须在原片内按先后排列，不能重叠');
    }
    const text = segment.text.trim(); characters += text.length;
    if (characters > 20_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
      throw new BatchDomainError('invalid_input', '台词过长或含无效字符');
    }
    previousEnd = segment.endUs;
    return { text, startUs: segment.startUs, endUs: segment.endUs };
  });
  return { formatVersion: 1 as const, origin: 'manual' as const, mode: mode as FormulaManualSpeechMode, segments };
}

export function readFormulaManualSpeech(db: Database.Database, projectId: string, batchId: string): FormulaManualSpeechView {
  const index = getFormulaMaterialIndex(db, projectId, batchId);
  const collection = getFormulaCollection(db, projectId, batchId);
  const rows = collection ? db.prepare(`SELECT m.* FROM batch_formula_manual_speech m WHERE m.collectionId=? AND NOT EXISTS (
    SELECT 1 FROM batch_formula_manual_speech newer WHERE newer.collectionId=m.collectionId AND newer.assetId=m.assetId AND newer.revision>m.revision)`)
    .all(collection.id) as Array<{ id: string; assetId: string; contentFingerprint: string; revision: number; baseInputRevision: number; contentJson: string; createdAt: string }> : [];
  const bindings = index.bindings.filter(binding => binding.logicalCode && !binding.excludedReason);
  return { inputRevision: index.revision, editable: readFormulaInputEditing(db, projectId, batchId).editable,
    items: [...new Set(bindings.map(binding => binding.assetId))].map(assetId => {
      const aliases = bindings.filter(binding => binding.assetId === assetId), row = rows.find(item => item.assetId === assetId);
      const recognized = db.prepare(`SELECT x.resultJson FROM batch_formula_speech_results x
        JOIN batch_formula_speech_stages s ON s.id=x.stageId JOIN batch_formula_stages t ON t.id=s.selectionStageId
        JOIN batch_formula_generation_requests r ON r.id=t.requestId
        JOIN batch_productions b ON b.id=r.batchId AND b.currentVersionId=r.batchVersionId
        WHERE r.projectId=? AND r.batchId=? AND s.assetId=? AND s.contentFingerprint=?
          AND json_extract(x.resultJson,'$.status')='transcribed'
          AND json_type(x.resultJson,'$.transcriptionIdentity')='object' ORDER BY x.createdAt DESC,s.id LIMIT 1`)
        .get(projectId, batchId, assetId, aliases[0].contentFingerprint) as { resultJson: string } | undefined;
      const automatic = recognized ? JSON.parse(recognized.resultJson) as { text: string; words: FormulaManualSpeechSegment[] } : null;
      return { assetId, contentFingerprint: aliases[0].contentFingerprint, names: aliases.map(item => item.sourcePath),
        available: aliases.some(item => item.available),
        saved: row ? { id: row.id, assetId, contentFingerprint: row.contentFingerprint, revision: row.revision,
          baseInputRevision: row.baseInputRevision, createdAt: row.createdAt, ...JSON.parse(row.contentJson) } : null,
        automatic: automatic ? { text: automatic.text, segments: automatic.words.map(({ text, startUs, endUs }) => ({ text, startUs, endUs })) } : null };
    }) };
}

export async function saveFormulaManualSpeech(db: Database.Database, projectId: string, batchId: string, input: {
  assetId: string; contentFingerprint: string; expectedInputRevision: number; expectedSpeechRevision: number;
  confirmed: boolean; mode: unknown; segments: unknown; signal?: AbortSignal;
}): Promise<FormulaManualSpeechView> {
  if (typeof input.assetId !== 'string' || !input.assetId || typeof input.contentFingerprint !== 'string'
    || !Number.isSafeInteger(input.expectedInputRevision) || input.expectedInputRevision < 0
    || !Number.isSafeInteger(input.expectedSpeechRevision) || input.expectedSpeechRevision < 0
    || (input.mode !== 'automatic' && input.confirmed !== true)) {
    throw new BatchDomainError('invalid_input', '请先试听原片并确认台词和时间，提交有效的资料版本');
  }
  const parsed = parseFormulaManualSpeech(input.mode, input.segments, Number.MAX_SAFE_INTEGER);
  const signal = input.signal ?? new AbortController().signal;
  const readExpected = () => {
    signal.throwIfAborted();
    assertFormulaBatch(db, projectId, batchId);
    if (!formulaExecutionAvailable(db)) throw new BatchDomainError('conflict', '实拍公式功能当前不可用');
    const view = readFormulaManualSpeech(db, projectId, batchId), item = view.items.find(item => item.assetId === input.assetId);
    if (!item || item.contentFingerprint !== input.contentFingerprint) throw new BatchDomainError('invalid_input', '原片不属于本批次或内容已变化');
    const saved = item.saved;
    const replay = saved?.revision === input.expectedSpeechRevision + 1 && saved.baseInputRevision === input.expectedInputRevision
      && saved.mode === parsed.mode && JSON.stringify(saved.segments) === JSON.stringify(parsed.segments);
    if (!replay) {
      assertFormulaBatch(db, projectId, batchId, true);
      if (view.inputRevision !== input.expectedInputRevision || (saved?.revision ?? 0) !== input.expectedSpeechRevision) {
        throw new BatchDomainError('conflict', '素材或人工台词已更新，请重新读取后核对');
      }
    }
    return { view, replay };
  };
  const before = readExpected();
  if (before.replay) return before.view;
  const sources = listAssetSources(db, input.assetId).filter(source => source.sourceKind === 'managed')
    .map(source => ({ id: source.id, location: source.locationJson }));
  const media = parsed.mode === 'automatic' ? null : await verifyFormulaCandidate(db, projectId, input.assetId, input.contentFingerprint, sources, signal);
  if (parsed.mode !== 'automatic' && !media) throw new BatchDomainError('conflict', '无法核验原片，请检查文件是否缺失、损坏或已变化');
  if (parsed.mode === 'speech' && !media?.media.hasAudio) throw new BatchDomainError('invalid_input', '原片没有可用音轨，不能登记为真人原声');
  const content = { ...parseFormulaManualSpeech(parsed.mode, parsed.segments, media?.media.durationUs ?? 0), mediaDurationUs: media?.media.durationUs ?? 0 };
  return db.transaction(() => {
    const current = readExpected();
    if (current.replay) return current.view;
    if (media) recheckFormulaCandidate(db, projectId, media);
    const collection = getFormulaCollection(db, projectId, batchId)!;
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO batch_formula_manual_speech
      (id,collectionId,assetId,contentFingerprint,revision,baseInputRevision,contentJson,createdAt) VALUES (?,?,?,?,?,?,?,?)`)
      .run(randomUUID(), collection.id, input.assetId, input.contentFingerprint, input.expectedSpeechRevision + 1,
        input.expectedInputRevision, JSON.stringify(content), now);
    db.prepare('UPDATE batch_formula_collections SET revision=revision+1,updatedAt=? WHERE id=?').run(now, collection.id);
    return readFormulaManualSpeech(db, projectId, batchId);
  }).immediate();
}
