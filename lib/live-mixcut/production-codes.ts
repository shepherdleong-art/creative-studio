import type Database from 'better-sqlite3';
import { normalizeProductionCode, packagingCode, type ProductionCodes } from '../media-core/production-codes.ts';
import { resolveVideoOpeningCode } from '../media-core/production-code-reader.ts';

/** 在渲染时读取已冻结脚本及实际首个视频片段，结果随本次渲染产物保存。 */
export function readBatchProductionCodes(db: Database.Database, input: {
  projectId: string; planId: string; outputVersionId: string; firstAssetId: string;
  packaging: { enabled?: boolean; template?: string };
}): ProductionCodes {
  const script = db.prepare(`SELECT s.* FROM live_mixcut_script_snapshots s
    JOIN live_mixcut_output_plans p ON p.scriptSnapshotId=s.id
    JOIN live_mixcut_output_versions o ON o.planId=p.id
    JOIN live_mixcut_production_versions v ON v.id=p.batchVersionId
    JOIN live_mixcut_productions b ON b.id=v.batchId
    WHERE p.id=? AND o.id=? AND b.projectId=?`).get(input.planId, input.outputVersionId, input.projectId) as { scriptCode?: string } | undefined;
  const sources = db.prepare(`SELECT s.locationJson FROM live_mixcut_asset_sources s
    JOIN live_mixcut_assets a ON a.id=s.assetId
    WHERE a.id=? AND a.projectId=? AND s.sourceKind='module4'`).all(input.firstAssetId, input.projectId) as Array<{ locationJson: string }>;
  const openings = new Set(sources.map(source => {
    try {
      const location = JSON.parse(source.locationJson);
      if (location.kind !== 'module4' || typeof location.videoJobId !== 'string' || typeof location.shotSetId !== 'string') return '';
      return resolveVideoOpeningCode(db, input.projectId, location.videoJobId, location.shotSetId);
    } catch { return ''; }
  }));
  return {
    scriptCode: normalizeProductionCode(script?.scriptCode, 'J'),
    openingCode: openings.size === 1 ? [...openings][0] : '',
    packagingCode: packagingCode(input.packaging),
  };
}
