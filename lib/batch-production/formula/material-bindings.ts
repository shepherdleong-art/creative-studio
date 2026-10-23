import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { BatchDomainError } from '../errors.ts';
import { verifyAssetSources } from '../media-catalog.ts';
import { assertFormulaBatch, ensureFormulaCollection, getFormulaCollection } from './collection-store.ts';
import { readFormulaInputs } from './import-store.ts';
import { normalizeLogicalCode, parseMaterialFilename } from './parse.ts';

export interface FormulaAssetBinding {
  id: string; assetId: string; sourceName: string; sourcePath: string;
  contentFingerprint: string; detectedCode: string | null; logicalCode: string | null;
  excludedReason: 'preview' | null;
}
export interface FormulaMaterialIndex {
  revision: number;
  bindings: Array<FormulaAssetBinding & { available: boolean }>;
  codes: Array<{
    logicalCode: string; defined: boolean; description: string; candidateAssetIds: string[];
    referencedBy: string[]; status: 'available' | 'missing_file' | 'undefined';
  }>;
}

/** 只保存用户选择文件的相对来源名，不能将它作为服务器读盘路径。 */
export function normalizeFormulaSourcePath(value: string): string {
  if (typeof value !== 'string') throw new BatchDomainError('invalid_input', '素材来源必须是文件相对路径');
  const normalized = value.replaceAll('\\', '/');
  if (!normalized || normalized.length > 1024 || /[\u0000-\u001f\u007f:]/.test(normalized)
    || normalized.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new BatchDomainError('invalid_input', '素材来源必须是文件相对路径，不能包含越级或绝对路径');
  }
  return normalized;
}

export function registerFormulaAssetBinding(db: Database.Database, projectId: string, batchId: string, input: {
  assetId: string; sourcePath: string;
}): FormulaAssetBinding {
  const sourcePath = normalizeFormulaSourcePath(input.sourcePath);
  const sourceName = sourcePath.split('/').at(-1)!;
  const parsed = parseMaterialFilename(sourceName);
  return db.transaction(() => {
    assertFormulaBatch(db, projectId, batchId, true);
    const asset = db.prepare(`SELECT a.contentFingerprint FROM batch_assets a WHERE a.id=? AND a.projectId=?
      AND a.mediaKind='video' AND a.status='online' AND EXISTS (
        SELECT 1 FROM batch_asset_sources s WHERE s.assetId=a.id AND s.sourceKind='managed' AND s.health='healthy')`)
      .get(input.assetId, projectId) as { contentFingerprint: string } | undefined;
    if (!asset) throw new BatchDomainError('invalid_input', '素材尚未完成本项目的托管导入或已不可用');
    const current = ensureFormulaCollection(db, projectId, batchId);
    const existing = db.prepare('SELECT * FROM batch_formula_asset_bindings WHERE collectionId=? AND assetId=? AND sourcePath=?')
      .get(current.id, input.assetId, sourcePath) as FormulaAssetBinding | undefined;
    if (existing) return existing;
    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO batch_formula_asset_bindings
      (id,collectionId,assetId,contentFingerprint,sourceName,sourcePath,detectedCode,logicalCode,excludedReason,createdAt,updatedAt)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, current.id, input.assetId, asset.contentFingerprint, sourceName, sourcePath,
      parsed.logicalCode, parsed.logicalCode, parsed.excludedReason, now, now);
    db.prepare('UPDATE batch_formula_collections SET revision=revision+1, updatedAt=? WHERE id=?').run(now, current.id);
    return { id, assetId: input.assetId, contentFingerprint: asset.contentFingerprint, sourceName, sourcePath,
      detectedCode: parsed.logicalCode, ...parsed };
  }).immediate();
}

export function getFormulaMaterialIndex(db: Database.Database, projectId: string, batchId: string): FormulaMaterialIndex {
  const inputs = readFormulaInputs(db, projectId, batchId);
  const collection = getFormulaCollection(db, projectId, batchId);
  const rows = collection ? db.prepare(`SELECT f.*, (a.status='online' AND a.contentFingerprint=f.contentFingerprint AND EXISTS (
    SELECT 1 FROM batch_asset_sources s WHERE s.assetId=a.id AND s.sourceKind='managed' AND s.health='healthy')) AS available
    FROM batch_formula_asset_bindings f JOIN batch_assets a ON a.id=f.assetId AND a.projectId=?
    WHERE f.collectionId=? ORDER BY f.sourcePath, f.id`).all(projectId, collection.id) as Array<FormulaAssetBinding & { available: number }> : [];
  const bindings = rows.map(row => ({ ...row, available: Boolean(row.available) }));
  const codes = new Map<string, FormulaMaterialIndex['codes'][number]>();
  const item = (logicalCode: string) => {
    let found = codes.get(logicalCode);
    if (!found) { found = { logicalCode, defined: false, description: '', candidateAssetIds: [], referencedBy: [], status: 'undefined' }; codes.set(logicalCode, found); }
    return found;
  };
  for (const row of inputs.materials?.rows ?? []) {
    if (!('logicalCode' in row)) continue;
    Object.assign(item(row.logicalCode), { defined: true, description: row.fields['画面描述'] ?? '', status: 'missing_file' });
  }
  for (const binding of bindings) {
    if (!binding.logicalCode) continue;
    const target = item(binding.logicalCode);
    if (!binding.excludedReason && binding.available && !target.candidateAssetIds.includes(binding.assetId)) {
      target.candidateAssetIds.push(binding.assetId); target.status = 'available';
    }
  }
  for (const row of inputs.scripts?.rows ?? []) {
    if (!('codes' in row)) continue;
    for (const code of new Set(row.codes)) item(code).referencedBy.push(row.scriptNumber);
  }
  return { revision: inputs.revision, bindings, codes: [...codes.values()].sort((a, b) => a.logicalCode.localeCompare(b.logicalCode, 'en', { numeric: true })) };
}

/** 页面回读和补传判断须重验受控副本，不能仅信任上次导入留下的 healthy。 */
export async function refreshFormulaMaterialIndex(db: Database.Database, projectId: string, batchId: string, signal?: AbortSignal): Promise<FormulaMaterialIndex> {
  const current = getFormulaMaterialIndex(db, projectId, batchId);
  for (const assetId of new Set(current.bindings.map(binding => binding.assetId))) {
    signal?.throwIfAborted();
    await verifyAssetSources(db, assetId);
  }
  signal?.throwIfAborted();
  return getFormulaMaterialIndex(db, projectId, batchId);
}

export function mapFormulaAssetBinding(db: Database.Database, projectId: string, batchId: string, bindingId: string, input: {
  logicalCode: string; expectedRevision: number;
}): void {
  let code: string;
  try { code = normalizeLogicalCode(input.logicalCode); } catch { throw new BatchDomainError('invalid_input', '请输入完整编号，例如 G1、VO13'); }
  db.transaction(() => {
    assertFormulaBatch(db, projectId, batchId, true);
    const current = getFormulaCollection(db, projectId, batchId);
    if (!current || current.revision !== input.expectedRevision) throw new BatchDomainError('conflict', '资料已更新，请刷新后重试');
    const row = db.prepare('SELECT * FROM batch_formula_asset_bindings WHERE id=? AND collectionId=?').get(bindingId, current.id) as FormulaAssetBinding | undefined;
    if (!row) throw new BatchDomainError('not_found', '素材绑定不存在');
    if (row.logicalCode === code) return;
    const now = new Date().toISOString();
    db.prepare('UPDATE batch_formula_asset_bindings SET logicalCode=?, updatedAt=? WHERE id=?').run(code, now, bindingId);
    db.prepare('UPDATE batch_formula_collections SET revision=revision+1, updatedAt=? WHERE id=?').run(now, current.id);
  }).immediate();
}
