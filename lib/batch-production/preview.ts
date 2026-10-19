import type Database from 'better-sqlite3';
import { computeProxyKey } from './proxy-cache.ts';
import { resolveSourceFilePath } from './media-catalog.ts';

/**
 * 预览来源解析(共识 2/9/13/15):代理与 LUT 完全正交、各自独立;
 * 色彩/LUT 是预览层实时效果,不参与代理身份,解析顺序只有三步:
 * 1. 存在与当前原片内容、代理规格匹配的可用代理时,使用代理
 *    (即使原片当前离线,已就绪的代理仍然可以预览,但明确标注原片离线、正式导出不可用)。
 * 2. 原片在线时,直接使用原片。
 * 3. 原片和匹配代理都不可用时,预览不可用并引导重新定位原片。
 *
 * 页面、route、分析代码不得自行拼代理路径或重新判断匹配关系——一律通过这个函数。
 */
export type PreviewSource =
  | { kind: 'proxy'; cacheItemId: string; relativePath: string; originalOnline: boolean }
  | { kind: 'original'; sourcePath: string }
  | { kind: 'unavailable'; reason: string };

export interface ResolvePreviewSourceInput {
  assetId: string;
  /** 原片当前完整内容指纹(调用方通过项目素材库读取,不是任意传入的路径) */
  contentFingerprint: string;
  profileVersion: string;
}

function findHealthyOriginalSourcePath(db: Database.Database, assetId: string): string | null {
  const source = db.prepare(`
    SELECT locationJson FROM batch_asset_sources
    WHERE assetId = ? AND health = 'healthy'
    ORDER BY createdAt, id LIMIT 1
  `).get(assetId) as { locationJson: string } | undefined;
  if (!source) return null;
  return resolveSourceFilePath(JSON.parse(source.locationJson));
}

export function resolvePreviewSource(
  db: Database.Database,
  projectId: string,
  input: ResolvePreviewSourceInput,
): PreviewSource {
  // 代理身份 = 素材 + 原片指纹 + 代理规格;色彩快照不再参与(共识 9/13)。
  const proxyKey = computeProxyKey({
    assetId: input.assetId,
    contentFingerprint: input.contentFingerprint,
    profileVersion: input.profileVersion,
  });
  const readyProxy = db.prepare(`
    SELECT id, relativePath FROM batch_proxy_cache_items
    WHERE proxyKey = ? AND projectId = ? AND status = 'ready' AND pendingDeleteAt IS NULL
  `).get(proxyKey, projectId) as { id: string; relativePath: string } | undefined;

  const originalSourcePath = findHealthyOriginalSourcePath(db, input.assetId);

  if (readyProxy) {
    return {
      kind: 'proxy',
      cacheItemId: readyProxy.id,
      relativePath: readyProxy.relativePath,
      originalOnline: originalSourcePath !== null,
    };
  }
  if (originalSourcePath) {
    return { kind: 'original', sourcePath: originalSourcePath };
  }
  return { kind: 'unavailable', reason: '原片离线,且没有可用代理,请重新定位原片' };
}
