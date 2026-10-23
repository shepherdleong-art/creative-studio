import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { BatchDomainError } from '../errors.ts';
import { listAssetSources } from '../media-catalog.ts';
import { assertFormulaBatch, getFormulaCollection } from './collection-store.ts';
import { getFormulaMaterialIndex } from './material-bindings.ts';
import { verifyFormulaCandidate, recheckFormulaCandidate } from './candidate-media.ts';
import { parseFormulaAvailableRanges, type FormulaSavedAssetRanges } from './range-contract.ts';
import { readFormulaInputEditing } from './input-editing.ts';

export interface FormulaAssetRangesView {
  inputRevision: number; editable: boolean;
  items: Array<{ assetId: string; contentFingerprint: string; names: string[]; logicalCodes: string[]; available: boolean;
    saved: FormulaSavedAssetRanges | null }>;
}

export function readFormulaAssetRanges(db: Database.Database, projectId: string, batchId: string): FormulaAssetRangesView {
  const index = getFormulaMaterialIndex(db, projectId, batchId);
  const collection = getFormulaCollection(db, projectId, batchId);
  const rows = collection ? db.prepare(`SELECT r.* FROM batch_formula_asset_ranges r WHERE r.collectionId=? AND NOT EXISTS (
    SELECT 1 FROM batch_formula_asset_ranges newer WHERE newer.collectionId=r.collectionId AND newer.assetId=r.assetId AND newer.revision>r.revision)`)
    .all(collection.id) as Array<{ id: string; assetId: string; contentFingerprint: string; revision: number; contentJson: string; createdAt: string }> : [];
  const bindings = index.bindings.filter(binding => binding.logicalCode && !binding.excludedReason);
  return { inputRevision: index.revision,
    editable: readFormulaInputEditing(db, projectId, batchId).editable,
    items: [...new Set(bindings.map(binding => binding.assetId))].map(assetId => {
      const aliases = bindings.filter(binding => binding.assetId === assetId);
      const row = rows.find(item => item.assetId === assetId);
      return { assetId, contentFingerprint: aliases[0].contentFingerprint, names: aliases.map(item => item.sourcePath),
        logicalCodes: [...new Set(aliases.map(item => item.logicalCode!))], available: aliases.some(item => item.available),
        saved: row ? { id: row.id, assetId, contentFingerprint: row.contentFingerprint, revision: row.revision,
          createdAt: row.createdAt, ...JSON.parse(row.contentJson) } : null };
    }) };
}

export async function saveFormulaAssetRanges(db: Database.Database, projectId: string, batchId: string, input: {
  assetId: string; contentFingerprint: string; expectedInputRevision: number; expectedRangeRevision: number;
  confirmed: boolean; ranges: unknown; signal?: AbortSignal;
}): Promise<FormulaAssetRangesView> {
  if (typeof input.assetId !== 'string' || typeof input.contentFingerprint !== 'string'
    || !Number.isSafeInteger(input.expectedInputRevision) || input.expectedInputRevision < 0
    || !Number.isSafeInteger(input.expectedRangeRevision) || input.expectedRangeRevision < 0
    || !Array.isArray(input.ranges) || input.ranges.length > 100 || (input.ranges.length > 0 && input.confirmed !== true)) {
    throw new BatchDomainError('invalid_input', '请先预览原片并确认可用区间，提交有效的区间和资料版本');
  }
  const signal = input.signal ?? new AbortController().signal;
  const readExpected = () => {
    signal.throwIfAborted();
    assertFormulaBatch(db, projectId, batchId, true);
    const view = readFormulaAssetRanges(db, projectId, batchId);
    const item = view.items.find(item => item.assetId === input.assetId);
    if (!item || item.contentFingerprint !== input.contentFingerprint) throw new BatchDomainError('invalid_input', '原片不属于本批次的正式编号素材或内容已变化');
    if (view.inputRevision !== input.expectedInputRevision || (item.saved?.revision ?? 0) !== input.expectedRangeRevision) {
      throw new BatchDomainError('conflict', '素材或区间已更新，请重新读取后核对');
    }
    return item;
  };
  readExpected();
  const sources = listAssetSources(db, input.assetId).filter(source => source.sourceKind === 'managed')
    .map(source => ({ id: source.id, location: source.locationJson }));
  const media = input.ranges.length ? await verifyFormulaCandidate(db, projectId, input.assetId, input.contentFingerprint, sources, signal) : null;
  if (input.ranges.length && !media) throw new BatchDomainError('conflict', '无法核验原片，文件可能缺失、损坏或内容已变化');
  const ranges = parseFormulaAvailableRanges(input.ranges, media?.media.durationUs ?? 0);
  return db.transaction(() => {
    const current = readExpected();
    if (media) recheckFormulaCandidate(db, projectId, media);
    const previous = current.saved?.ranges.map(({ label, inUs, outUs, protected: protection }) => ({ inUs, outUs, label, protected: protection }));
    if (current.saved && JSON.stringify(previous) === JSON.stringify(ranges)) return readFormulaAssetRanges(db, projectId, batchId);
    const now = new Date().toISOString();
    const collection = getFormulaCollection(db, projectId, batchId)!;
    const content = { origin: 'manual', audioStatus: 'pending', mediaDurationUs: media?.media.durationUs ?? null,
      ranges: ranges.map(range => ({ ...range, id: randomUUID() })) };
    db.prepare(`INSERT INTO batch_formula_asset_ranges (id,collectionId,assetId,contentFingerprint,revision,contentJson,createdAt)
      VALUES (?,?,?,?,?,?,?)`).run(randomUUID(), collection.id, input.assetId, input.contentFingerprint,
        input.expectedRangeRevision + 1, JSON.stringify(content), now);
    db.prepare('UPDATE batch_formula_collections SET revision=revision+1,updatedAt=? WHERE id=?').run(now, collection.id);
    return readFormulaAssetRanges(db, projectId, batchId);
  }).immediate();
}
