import type Database from 'better-sqlite3';
import { extractMatchKeywords } from '../media-core/match-keywords.ts';
import { createAnalysisVersionAndSetCurrent, getAsset } from './assets.ts';
import { getCurrentAssetAnalysis } from './asset-preparation.ts';
import { BatchDomainError } from './errors.ts';
import { listAssetSources } from './media-catalog.ts';
import { assertProjectAssetFileIdentity, resolveVerifiedProjectAssetMedia } from './project-asset-media.ts';

const ANALYZER_VERSION = 'batch-filename-analysis-v1';

/** 文件名是用户提供的描述，不是画面观察；不推断动作时间或画质。 */
export function parseFilenameDescription(filename: string): { filename: string; description: string; labels: string[] } {
  const leaf = filename.replaceAll('\\', '/').split('/').at(-1)!
    .replace(/[\u0000-\u001f\u007f]/g, '').trim();
  const stem = leaf.normalize('NFKC').replace(/\.(mp4|mov|avi|webm)$/i, '');
  const description = stem.replace(/^G\d+[\s_-]+/i, '')
    .replace(/[_\s]+|[-—–]+/g, '，').replace(/，+/g, '，').replace(/^，|，$/g, '');
  if (description.length < 2 || !/[\p{L}]/u.test(description)
    || /^(?:(?:IMG|VID|DSC|MVI|MOV|G)[，\d]+|[a-f0-9，]{16,})$/i.test(description)) {
    throw new BatchDomainError('invalid_input', '文件名缺少内容描述，请先补充描述或使用画面内容分析');
  }
  return { filename: leaf, description, labels: extractMatchKeywords(description) };
}

export interface FilenameAnalysisResult {
  items: Array<{ assetId: string; analysisId: string; description: string; reused: boolean }>;
  errors: Array<{ assetId: string; message: string }>;
}

/** 项目素材级本地操作：发布新的分析版本，历史批次引用的分析版本保持不变。 */
export async function extractAssetFilenameDescriptions(
  db: Database.Database,
  projectId: string,
  assetIds: string[],
  signal?: AbortSignal,
): Promise<FilenameAnalysisResult> {
  if (!Array.isArray(assetIds) || !assetIds.length || assetIds.length > 500
    || assetIds.some((id) => typeof id !== 'string' || !id.trim())) {
    throw new BatchDomainError('invalid_input', '请选择 1–500 条素材');
  }
  // 先校验全部归属，跨项目请求不能部分写入。
  const assets = [...new Set(assetIds)].map((id) => {
    const asset = getAsset(db, projectId, id);
    if (!asset) throw new BatchDomainError('not_found', '素材不存在');
    return asset;
  });
  const result: FilenameAnalysisResult = { items: [], errors: [] };
  for (const asset of assets) {
    signal?.throwIfAborted();
    try {
      if (asset.status !== 'online') throw new BatchDomainError('conflict', '素材已离线或归档');
      if (!listAssetSources(db, asset.id).some((source) => source.sourceKind !== 'module4')) {
        throw new BatchDomainError('invalid_input', '文件名提取仅用于外部导入素材');
      }
      const media = asset.mediaJson as { displayName?: string; filename?: string };
      const parsed = parseFilenameDescription(media.displayName || media.filename || '');
      const verified = await resolveVerifiedProjectAssetMedia(db, projectId, asset.id);
      signal?.throwIfAborted();
      const item = db.transaction(() => {
        const latest = getAsset(db, projectId, asset.id);
        if (!latest || latest.status !== 'online' || latest.contentFingerprint !== asset.contentFingerprint
          || JSON.stringify(latest.mediaJson) !== JSON.stringify(asset.mediaJson)) {
          throw new BatchDomainError('conflict', '素材已变化，请刷新后重新提取');
        }
        assertProjectAssetFileIdentity(verified.filePath, verified.fileIdentity);
        const current = getCurrentAssetAnalysis(db, projectId, asset.id);
        const currentJson = current?.analysisJson as { analyzer?: string; filename?: string; summary?: string } | undefined;
        if (current?.status === 'ready' && current.analysisLevel === 'content') {
          if (currentJson?.analyzer !== 'filename') {
            throw new BatchDomainError('conflict', '已有画面内容分析，已保留原分析结果');
          }
          if (currentJson.filename === parsed.filename) {
            return { assetId: asset.id, analysisId: current.id, description: currentJson.summary || parsed.description, reused: true };
          }
        }
        const active = db.prepare(`SELECT id FROM batch_tasks WHERE projectId = ? AND targetId = ?
          AND workType = 'asset_prepare' AND status IN ('queued', 'running', 'paused') LIMIT 1`).get(projectId, asset.id);
        if (active) throw new BatchDomainError('conflict', '素材分析任务尚未结束，请结束后再提取文件名');
        const { durationUs, width, height } = verified.media;
        const analysisId = createAnalysisVersionAndSetCurrent(db, {
          assetId: asset.id,
          analyzerVersion: ANALYZER_VERSION,
          providerId: 'local-filename',
          model: ANALYZER_VERSION,
          analysisJson: {
            analysisLevel: 'content', analyzer: 'filename', filename: parsed.filename,
            summary: parsed.description, semanticTags: parsed.labels, sellingPoints: [],
            durationUs, width, height, qualityAssessed: false, temporalCoverage: 'whole_asset',
            usableRanges: [{ startUs: 0, endUs: durationUs, qualityScore: 0.5 }],
            scenes: [{ startUs: 0, endUs: durationUs, description: parsed.description, labels: parsed.labels, qualityScore: 0.5 }],
            qualityIssues: [], coverFrameTimesUs: [],
          },
        });
        return { assetId: asset.id, analysisId, description: parsed.description, reused: false };
      }).immediate();
      result.items.push(item);
    } catch (error) {
      signal?.throwIfAborted();
      result.errors.push({ assetId: asset.id, message: error instanceof BatchDomainError
        ? error.message : '素材文件核验失败，请确认原片在线且可正常播放' });
    }
  }
  return result;
}
