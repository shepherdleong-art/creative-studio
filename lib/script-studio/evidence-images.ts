import type Database from 'better-sqlite3';
import { getLibraryRevision } from './libraries.ts';
import { getSourceSet } from './source-sets.ts';
import { evidenceRefsOfRecord } from './selling-point-normalize.ts';
import { tileSourceImages, parseTileRefIndex } from './tiling.ts';
import { DIRECT_VISION_VERSION } from './direct-vision-contract.ts';
import { ScriptStudioError } from './errors.ts';

/** 只在用户展开核对时读取图片，按修订版本还原当时的切片坐标。 */
export async function loadSellingPointEvidenceImages(db: Database.Database, projectId: string, revisionId: string, pointId: string, signal?: AbortSignal) {
  const revision = getLibraryRevision(db, projectId, revisionId);
  const point = revision?.sellingPoints.find((item) => item.id === pointId);
  if (!revision || !point) throw new ScriptStudioError('not_found', '该卖点不属于当前项目或修订');
  const source = getSourceSet(db, projectId, revision.sourceSetId);
  if (!source) throw new ScriptStudioError('not_found', '原始素材来源不存在');
  const ids = JSON.parse(source.imageAssetIdsJson) as string[];
  const refs = evidenceRefsOfRecord(point).filter((ref) => ref.pageIndex !== null && ref.pageIndex >= 0 && ref.pageIndex < ids.length);
  const selected = refs.slice(0, 6);
  if (!selected.length) throw new ScriptStudioError('invalid_input', '该卖点没有可定位的图片来源');
  const pages = [...new Set(selected.map((ref) => ref.pageIndex!))];
  const tiles = await tileSourceImages(db, projectId, pages.map((index) => ids[index]!), { signal, directVision: revision.promptContractVersion >= DIRECT_VISION_VERSION });
  // tileSourceImages 会重新编号；按资产 ID 还原，不能让缺失资产导致后续引用错位。
  const images = selected.flatMap((ref) => {
    const page = tiles.pages.find((item) => item.imageAssetId === ids[ref.pageIndex!]);
    const index = ref.tileRef ? parseTileRefIndex(ref.tileRef) : 0;
    const tile = index === null ? undefined : page?.tiles[index];
    return tile && page ? [{ filename: page.filename, pageIndex: ref.pageIndex!, tileRef: `tile_${index! + 1}`, imageUrl: `data:${tile.mimeType};base64,${tile.imageBase64}` }] : [];
  });
  if (!images.length) throw new ScriptStudioError('not_found', '对应图片已删除或无法定位，请重新导入原始素材');
  return { images, truncated: refs.length > selected.length, evidenceQuote: point.evidenceQuote };
}
