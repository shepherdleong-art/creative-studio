import type Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { supportsFilter } from '../ffmpeg.ts';
import { computeFingerprintFromFile, fingerprintsEqual } from './fingerprint.ts';
import { resolveSourceFilePath } from './media-catalog.ts';
import { resolveManagedLutPath } from './lut-catalog.ts';
import { upgradeColorSnapshot } from './color-pipeline.ts';

/**
 * 正式输出前置检查(交接文档 §4.3):Phase D 只验证这个合同,不建立正式 render 任务。
 * 任何一项不满足都返回可操作的阻塞原因;绝不为了"能导出"而回退到代理、关闭 LUT、
 * 采用同名新 LUT,或者继续信任已经变化的路径——每次都重新核验完整内容指纹。
 */
export interface ExportPreflightBlocker {
  assetId: string;
  code: 'source_offline' | 'source_content_changed' | 'lut_missing' | 'lut_content_changed' | 'color_chain_unsupported';
  message: string;
}

export type ExportPreflightResult =
  | { ready: true }
  | { ready: false; blockers: ExportPreflightBlocker[] };

interface PoolItemForPreflight {
  assetId: string;
  colorJson: string;
  contentFingerprint: string;
}

async function verifyOriginalSource(
  db: Database.Database,
  item: PoolItemForPreflight,
): Promise<ExportPreflightBlocker | null> {
  const sources = db.prepare(`
    SELECT locationJson FROM batch_asset_sources WHERE assetId = ?
  `).all(item.assetId) as Array<{ locationJson: string }>;
  let anyFileExists = false;
  for (const { locationJson } of sources) {
    try {
      const filePath = resolveSourceFilePath(JSON.parse(locationJson));
      if (!existsSync(filePath)) continue;
      anyFileExists = true;
      const fingerprint = await computeFingerprintFromFile(filePath);
      if (fingerprintsEqual(fingerprint, item.contentFingerprint)) {
        return null; // 至少一个来源在线且重新核验的内容指纹匹配
      }
    } catch {
      continue;
    }
  }
  return {
    assetId: item.assetId,
    code: anyFileExists ? 'source_content_changed' : 'source_offline',
    message: anyFileExists
      ? '原片来源存在但重新核验的内容指纹与素材身份不一致,不能用于正式导出'
      : '没有在线的原片来源,不能用于正式导出',
  };
}

async function verifyFrozenLut(
  db: Database.Database,
  item: PoolItemForPreflight,
): Promise<ExportPreflightBlocker | null> {
  const snapshot = upgradeColorSnapshot(JSON.parse(item.colorJson));
  if (snapshot.lutId === null) return null;
  if (!snapshot.lutFingerprint || snapshot.lutFingerprint.startsWith('unresolved:')) {
    return {
      assetId: item.assetId,
      code: 'lut_content_changed',
      message: '冻结快照没有锁定可解析的 LUT 内容指纹,不能用于正式导出',
    };
  }
  const lut = db.prepare(`
    SELECT relativePath, contentFingerprint FROM batch_luts WHERE id = ?
  `).get(snapshot.lutId) as { relativePath: string; contentFingerprint: string } | undefined;
  if (!lut) {
    return { assetId: item.assetId, code: 'lut_missing', message: '冻结引用的 LUT 记录不存在' };
  }
  let absolutePath: string;
  try {
    absolutePath = resolveManagedLutPath(lut.relativePath);
  } catch {
    return { assetId: item.assetId, code: 'lut_missing', message: '冻结引用的 LUT 受管路径非法' };
  }
  if (!existsSync(absolutePath)) {
    return { assetId: item.assetId, code: 'lut_missing', message: '冻结引用的 LUT 受管文件不存在' };
  }
  const fingerprint = await computeFingerprintFromFile(absolutePath);
  // 实际文件指纹必须同时匹配冻结快照与 LUT 目录记录——不能只信当前数据库行,
  // 也不能只信历史快照:任一侧与真实内容不一致都拒绝,不采用同名新 LUT。
  if (
    !fingerprintsEqual(fingerprint, snapshot.lutFingerprint)
    || !fingerprintsEqual(fingerprint, lut.contentFingerprint)
  ) {
    return {
      assetId: item.assetId,
      code: 'lut_content_changed',
      message: '冻结引用的 LUT 文件内容已变化,不能用于正式导出(不得采用同名新 LUT 替代)',
    };
  }
  return null;
}

/**
 * 对一个已冻结的批次版本执行正式输出前置检查。
 * 只读校验,不修改任何数据、不生成任何产物、不建立 render 任务。
 */
export async function checkFormalExportPreflight(
  db: Database.Database,
  batchVersionId: string,
): Promise<ExportPreflightResult> {
  const version = db.prepare(`
    SELECT inputState FROM batch_production_versions WHERE id = ?
  `).get(batchVersionId) as { inputState: 'draft' | 'frozen' } | undefined;
  if (!version) {
    return {
      ready: false,
      blockers: [{ assetId: '', code: 'source_offline', message: '批次版本不存在' }],
    };
  }

  const poolItems = db.prepare(`
    SELECT assetId, colorJson, (SELECT contentFingerprint FROM batch_assets WHERE id = pool.assetId) AS contentFingerprint
    FROM batch_asset_pool_items pool
    WHERE pool.batchVersionId = ?
  `).all(batchVersionId) as PoolItemForPreflight[];

  const blockers: ExportPreflightBlocker[] = [];
  const usesLut = poolItems.some((item) => {
    const snapshot = upgradeColorSnapshot(JSON.parse(item.colorJson));
    return snapshot.lutId !== null;
  });
  if (usesLut && !(await supportsFilter('lut3d'))) {
    blockers.push({
      assetId: '',
      code: 'color_chain_unsupported',
      message: '当前 FFmpeg 不支持冻结的色彩链(缺少 lut3d filter)',
    });
  }

  for (const item of poolItems) {
    const sourceBlocker = await verifyOriginalSource(db, item);
    if (sourceBlocker) blockers.push(sourceBlocker);
    const lutBlocker = await verifyFrozenLut(db, item);
    if (lutBlocker) blockers.push(lutBlocker);
  }

  if (blockers.length > 0) {
    return { ready: false, blockers };
  }
  return { ready: true };
}
