import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { BatchDomainError } from '../errors.ts';
import { assertFormulaBatch, ensureFormulaCollection, getFormulaCollection } from './collection-store.ts';
import { readFormulaInputs } from './import-store.ts';
import { getFormulaMaterialIndex } from './material-bindings.ts';
import { normalizeLogicalCode } from './parse.ts';
import type { FormulaScriptRow } from './workbook.ts';
import { readFormulaAssetRanges } from './asset-ranges.ts';
import type { FormulaSavedAssetRanges } from './range-contract.ts';
import { readFormulaInputEditing } from './input-editing.ts';

export interface FormulaPrimaryChoice { logicalCode: string; assetId: string; contentFingerprint: string }
export interface FormulaSlotChoice extends FormulaPrimaryChoice { scriptKey: string; slotIndex: number; sourceLogicalCode: string }
export interface FormulaRotationChoice { logicalCode: string; candidates: Array<{ assetId: string; contentFingerprint: string; rangeRevisionId: string }> }
export interface FormulaReplacementRule { logicalCode: string; replacementCode: string; reason: string; differences: string[] }
export interface FormulaSelectionRules { primary: FormulaPrimaryChoice[]; overrides: FormulaSlotChoice[]; rotation?: FormulaRotationChoice[]; replacements?: FormulaReplacementRule[] }
export interface FormulaSavedSelectionRules {
  id: string; revision: number; scriptsSessionId: string | null; rules: FormulaSelectionRules; createdAt: string;
  /** 旧生成快照未保存此字段；新保存的规则统一使用格式 2。 */
  formatVersion?: 1 | 2;
}
export interface FormulaSelectionRulesView {
  inputRevision: number; scriptsSessionId: string | null; scripts: FormulaScriptRow[];
  editable: boolean; hasPendingScripts: boolean; stale: boolean; saved: FormulaSavedSelectionRules | null;
  ranges: FormulaSavedAssetRanges[]; rotationStale: boolean;
  materials: ReturnType<typeof getFormulaMaterialIndex>;
}

export function readFormulaSelectionRules(db: Database.Database, projectId: string, batchId: string): FormulaSelectionRulesView {
  const inputs = readFormulaInputs(db, projectId, batchId);
  const collection = getFormulaCollection(db, projectId, batchId);
  const row = collection && db.prepare(`SELECT id,revision,scriptsSessionId,contentJson,createdAt,formatVersion FROM batch_formula_selection_rules
    WHERE collectionId=? ORDER BY revision DESC LIMIT 1`).get(collection.id) as {
      id: string; revision: number; scriptsSessionId: string | null; contentJson: string; createdAt: string; formatVersion: 1 | 2;
    } | undefined;
  const rules = row ? JSON.parse(row.contentJson) as FormulaSelectionRules : null;
  const ranges = readFormulaAssetRanges(db, projectId, batchId).items.flatMap(item => item.saved ? [item.saved] : []);
  return { inputRevision: inputs.revision, scriptsSessionId: inputs.scripts?.sessionId ?? null,
    scripts: (inputs.scripts?.rows ?? []).filter((item): item is FormulaScriptRow => 'scriptNumber' in item),
    editable: readFormulaInputEditing(db, projectId, batchId).editable,
    hasPendingScripts: inputs.drafts.some(draft => draft.kind === 'scripts' && draft.baseRevision === inputs.revision),
    stale: !!rules?.overrides.length && row?.scriptsSessionId !== inputs.scripts?.sessionId,
    ranges, rotationStale: !!rules?.rotation?.some(pool => pool.candidates.some(candidate => !ranges.some(range => range.id === candidate.rangeRevisionId
      && range.assetId === candidate.assetId && range.contentFingerprint === candidate.contentFingerprint && range.ranges.length))),
    saved: row ? { id: row.id, revision: row.revision, scriptsSessionId: row.scriptsSessionId,
      rules: rules!, createdAt: row.createdAt, formatVersion: row.formatVersion } : null,
    materials: getFormulaMaterialIndex(db, projectId, batchId) };
}

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) {
    throw new BatchDomainError('invalid_input', '人工选片设置格式不正确');
  }
  return value as Record<string, unknown>;
}

/** 人工选择只保存本集合中的确切素材身份，不把文件名说明当成可用区间证明。 */
export function saveFormulaSelectionRules(db: Database.Database, projectId: string, batchId: string, input: {
  expectedInputRevision: number; expectedRulesRevision: number; scriptsSessionId: string | null; rules: unknown;
}): FormulaSelectionRulesView {
  if (!Number.isSafeInteger(input.expectedInputRevision) || input.expectedInputRevision < 0
    || !Number.isSafeInteger(input.expectedRulesRevision) || input.expectedRulesRevision < 0
    || (input.scriptsSessionId !== null && typeof input.scriptsSessionId !== 'string')) {
    throw new BatchDomainError('invalid_input', '缺少有效的资料或人工选片版本');
  }
  return db.transaction(() => {
    assertFormulaBatch(db, projectId, batchId, true);
    const current = readFormulaSelectionRules(db, projectId, batchId);
    if (current.inputRevision !== input.expectedInputRevision || current.scriptsSessionId !== input.scriptsSessionId
      || (current.saved?.revision ?? 0) !== input.expectedRulesRevision) {
      throw new BatchDomainError('conflict', '资料或人工选片已更新，请重新读取后保存');
    }
    const data = object(input.rules, ['primary', 'overrides', 'rotation', 'replacements']);
    if (!Array.isArray(data.primary) || data.primary.length > 10000 || !Array.isArray(data.overrides) || data.overrides.length > 10000) {
      throw new BatchDomainError('invalid_input', '人工选片列表不正确');
    }
    if (current.hasPendingScripts && data.overrides.length) throw new BatchDomainError('conflict', '请先确认脚本表，再指定其中的镜头素材');
    const seen = new Set<string>();
    const primary = data.primary.map(value => {
      const item = object(value, ['logicalCode', 'assetId']);
      let logicalCode: string;
      try { logicalCode = normalizeLogicalCode(item.logicalCode as string); }
      catch { throw new BatchDomainError('invalid_input', '请选择完整的素材编号'); }
      if (seen.has(logicalCode)) throw new BatchDomainError('invalid_input', '同一编号只能指定一份主片');
      seen.add(logicalCode);
      const binding = current.materials.bindings.find(candidate => candidate.logicalCode === logicalCode
        && candidate.assetId === item.assetId && !candidate.excludedReason && candidate.available);
      if (!binding) throw new BatchDomainError('invalid_input', `${logicalCode} 的主片不是本批次可用的同号素材`);
      return { logicalCode, assetId: binding.assetId, contentFingerprint: binding.contentFingerprint };
    }).sort((a, b) => a.logicalCode.localeCompare(b.logicalCode, 'en', { numeric: true }));
    const seenSlots = new Set<string>();
    const overrides = data.overrides.map(value => {
      const item = object(value, ['scriptKey', 'slotIndex', 'logicalCode', 'sourceLogicalCode', 'assetId']);
      const script = current.scripts.find(script => script.key === item.scriptKey);
      const slotIndex = item.slotIndex as number;
      if (!script || !Number.isSafeInteger(slotIndex) || slotIndex < 0 || script.codes[slotIndex] !== item.logicalCode) {
        throw new BatchDomainError('invalid_input', '指定的脚本或镜头已变化，请核对当前公式');
      }
      const slotKey = `${script.key}:${slotIndex}`;
      if (seenSlots.has(slotKey)) throw new BatchDomainError('invalid_input', '同一镜头不能重复指定素材');
      seenSlots.add(slotKey);
      const binding = current.materials.bindings.find(candidate => candidate.logicalCode === item.sourceLogicalCode
        && candidate.assetId === item.assetId && !candidate.excludedReason && candidate.available);
      if (!binding?.logicalCode) throw new BatchDomainError('invalid_input', '指定镜头必须使用本批次已编号的可用原片');
      return { scriptKey: script.key, slotIndex, logicalCode: script.codes[slotIndex], sourceLogicalCode: binding.logicalCode,
        assetId: binding.assetId, contentFingerprint: binding.contentFingerprint };
    }).sort((a, b) => a.scriptKey.localeCompare(b.scriptKey) || a.slotIndex - b.slotIndex);
    // 旧客户端未提交轮换字段时保留已保存配置，不能因只改主片而清空批准集合。
    const rawRotation = data.rotation === undefined ? (current.saved?.rules.rotation ?? []).map(pool => ({ logicalCode: pool.logicalCode,
      candidates: pool.candidates.map(({ assetId, rangeRevisionId }) => ({ assetId, rangeRevisionId })) })) : data.rotation;
    if (!Array.isArray(rawRotation) || rawRotation.length > 10000) throw new BatchDomainError('invalid_input', '轮换候选设置无效');
    const rotationCodes = new Set<string>();
    const rotation = rawRotation.map(value => {
      const item = object(value, ['logicalCode', 'candidates']);
      let logicalCode: string;
      try { logicalCode = normalizeLogicalCode(item.logicalCode as string); }
      catch { throw new BatchDomainError('invalid_input', '轮换必须指定完整编号'); }
      if (seen.has(logicalCode) || rotationCodes.has(logicalCode)) throw new BatchDomainError('invalid_input', '同一编号只能选择固定主片或候选轮换中的一种方式');
      rotationCodes.add(logicalCode);
      if (!Array.isArray(item.candidates) || !item.candidates.length || item.candidates.length > 1000) throw new BatchDomainError('invalid_input', '轮换至少需要勾选一份已确认区间的候选');
      const assetIds = new Set<string>();
      const candidates = item.candidates.map(value => {
        const candidate = object(value, ['assetId', 'rangeRevisionId']);
        const binding = current.materials.bindings.find(binding => binding.logicalCode === logicalCode
          && binding.assetId === candidate.assetId && !binding.excludedReason && binding.available);
        const approval = current.ranges.find(range => range.assetId === candidate.assetId && range.id === candidate.rangeRevisionId
          && range.contentFingerprint === binding?.contentFingerprint && range.ranges.length > 0);
        if (!binding || !approval) throw new BatchDomainError('invalid_input', `${logicalCode} 的轮换候选需要本批次可用原片和当前已确认区间`);
        if (assetIds.has(binding.assetId)) throw new BatchDomainError('invalid_input', '轮换候选不能重复勾选同一份原片');
        assetIds.add(binding.assetId);
        return { assetId: binding.assetId, contentFingerprint: binding.contentFingerprint, rangeRevisionId: approval.id };
      }).sort((a, b) => a.assetId.localeCompare(b.assetId));
      return { logicalCode, candidates };
    }).sort((a, b) => a.logicalCode.localeCompare(b.logicalCode, 'en', { numeric: true }));
    // 兼容尚未提供统一替换编辑器的客户端：省略字段保留，显式空数组才清除。
    const rawReplacements = data.replacements === undefined ? current.saved?.rules.replacements ?? [] : data.replacements;
    if (!Array.isArray(rawReplacements) || rawReplacements.length > 10000) throw new BatchDomainError('invalid_input', '统一替换列表无效');
    const replacementCodes = new Set<string>();
    const replacements: FormulaReplacementRule[] = rawReplacements.map(value => {
      const item = object(value, ['logicalCode', 'replacementCode', 'reason', 'differences']);
      let logicalCode: string, replacementCode: string;
      try { logicalCode = normalizeLogicalCode(item.logicalCode as string); replacementCode = normalizeLogicalCode(item.replacementCode as string); }
      catch { throw new BatchDomainError('invalid_input', '统一替换需填写完整编号'); }
      if (logicalCode === replacementCode || replacementCodes.has(logicalCode)) throw new BatchDomainError('invalid_input', '同一原编号只能指定一个不同的直接替代编号');
      replacementCodes.add(logicalCode);
      if (!current.materials.codes.some(code => code.logicalCode === logicalCode && code.defined)) {
        throw new BatchDomainError('invalid_input', `${logicalCode} 没有素材定义，请先补充资料或修正公式`);
      }
      if (!current.materials.bindings.some(binding => binding.logicalCode === replacementCode && binding.available && !binding.excludedReason)) {
        throw new BatchDomainError('invalid_input', `${replacementCode} 不是本集合可用的正式素材编号`);
      }
      const validText = (value: unknown, limit: number): value is string => typeof value === 'string' && !!value.trim()
        && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value);
      if (!validText(item.reason, 500) || !Array.isArray(item.differences) || item.differences.length > 20
        || item.differences.some(value => !validText(value, 300))) throw new BatchDomainError('invalid_input', '请填写替换原因；差异最多 20 条，每条不超过 300 字');
      return { logicalCode, replacementCode, reason: item.reason.trim(), differences: [...new Set(item.differences.map(value => (value as string).trim()))] };
    }).sort((a, b) => a.logicalCode.localeCompare(b.logicalCode, 'en', { numeric: true }));
    if (replacements.some(rule => replacementCodes.has(rule.replacementCode))) {
      throw new BatchDomainError('invalid_input', '统一替换不能循环或多跳，请直接指定最终素材编号');
    }
    const rules: FormulaSelectionRules = { primary, overrides, rotation, replacements };
    if (current.saved?.formatVersion === 2 && current.saved.scriptsSessionId === input.scriptsSessionId
      && JSON.stringify(current.saved.rules) === JSON.stringify(rules)) return current;
    const collection = ensureFormulaCollection(db, projectId, batchId);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO batch_formula_selection_rules (id,collectionId,revision,scriptsSessionId,contentJson,createdAt,formatVersion)
      VALUES (?,?,?,?,?,?,2)`).run(randomUUID(), collection.id, input.expectedRulesRevision + 1, input.scriptsSessionId, JSON.stringify(rules), now);
    db.prepare('UPDATE batch_formula_collections SET revision=revision+1,updatedAt=? WHERE id=?').run(now, collection.id);
    return readFormulaSelectionRules(db, projectId, batchId);
  }).immediate();
}
