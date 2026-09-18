import type Database from 'better-sqlite3';
import { createLibraryRevision, getCurrentLibraryRevision, type LibrarySellingPointInput } from './libraries.ts';
import { evidenceRefsOfRecord } from './selling-point-normalize.ts';
import { storedEvidenceIsStructurallyUsable } from './direction-briefs.ts';
import { ScriptStudioError } from './errors.ts';
import { SELLING_POINT_ORGANIZATION_VERSION, type SellingPointOrganizer } from './selling-point-organizer.ts';

/** 旧库显式整理：读取冻结修订，模型完成后 CAS 保存新修订，旧库/脚本引用不改。 */
export async function reorganizeLibrary(
  db: Database.Database,
  projectId: string,
  baseRevisionId: string,
  organizer: SellingPointOrganizer,
  options: { signal?: AbortSignal; providerId: string; model: string },
) {
  const current = getCurrentLibraryRevision(db, projectId);
  if (!current || current.id !== baseRevisionId) throw new ScriptStudioError('conflict', '卖点库已更新，请刷新后重新整理');
  const source = db.prepare('SELECT imageAssetIdsJson FROM script_studio_source_sets WHERE id = ? AND projectId = ?')
    .get(current.sourceSetId, projectId) as { imageAssetIdsJson: string } | undefined;
  const pageCount = source ? (JSON.parse(source.imageAssetIdsJson) as unknown[]).length : undefined;
  const points: LibrarySellingPointInput[] = current.sellingPoints.map((point) => ({
    ...point,
    evidenceRefs: evidenceRefsOfRecord(point),
    usable: point.usable === 1 && storedEvidenceIsStructurallyUsable(point, { pageCount }),
    disabledByUser: point.disabledByUser === 1,
  }));
  const organized = await organizer.organize(points, options.signal);
  if (options.signal?.aborted) throw new DOMException('卖点整理已取消', 'AbortError');
  return db.transaction(() => {
    if (getCurrentLibraryRevision(db, projectId)?.id !== baseRevisionId) {
      throw new ScriptStudioError('conflict', '整理期间卖点库已更新，本次结果未覆盖新版本，请刷新后重试');
    }
    return createLibraryRevision(db, {
      projectId, sourceSetId: current.sourceSetId, sourceFingerprint: current.sourceFingerprint,
      productName: current.productName, category: current.category, brand: current.brand,
      extractProviderId: options.providerId, extractModel: options.model,
      promptContractVersion: Math.max(current.promptContractVersion, SELLING_POINT_ORGANIZATION_VERSION), origin: 'manual_edit', sellingPoints: organized,
    });
  }).immediate();
}
