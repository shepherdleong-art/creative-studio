import type Database from 'better-sqlite3';
import {
  listProjectAssets,
  type BatchAssetMediaKind,
  type BatchAssetRow,
  type BatchAssetSourceKind,
  type BatchAssetStatus,
} from './assets.ts';
import { parseStoredNarrationConfig } from './scripts.ts';
import {
  listAssetSources,
  isBatchAssetEligible,
  registerModule4Video,
  verifyAssetSources,
  type BatchAssetSourceHealth,
} from './media-catalog.ts';
import { listProjectScripts } from './scripts.ts';
import { syncProjectScripts } from './script-catalog.ts';
import { getCurrentAssetAnalysis, type AssetAnalysisLevel } from './asset-preparation.ts';
import { videoJobNotRejectedSql } from '../media-core/video-job-rejection.ts';

export interface PrepareScriptView {
  id: string;
  title: string;
  bodyText: string;
  coverTitle: PrepareCoverTitle;
  shotSetId: string;
  sourceVersion: string;
  contentRevision: string;
  updatedAt: string;
  /** 脚本自身设定的目标成片时长(秒);旧脚本可能没有,展示层回落 15 */
  targetDurationSec?: number | null;
  /** 已存储的口播配置(服务商/音色/语速);无配置时为 null */
  narrationConfig?: import('./scripts.ts').BatchNarrationConfig | null;
  /** 手动导入的自定义脚本(sourceId 为 manual: 命名空间);只暴露语义,不泄露 sourceId/sourceKind */
  manual: boolean;
}

export interface PrepareCoverTitle {
  primary: string;
  secondary: string;
}

export interface PrepareSourceView {
  id: string;
  sourceKind: BatchAssetSourceKind;
  health: BatchAssetSourceHealth;
  /** 仅供界面识别来源；不得包含绝对或相对本地路径。 */
  displayName: string;
}

export interface PrepareAssetMedia {
  filename?: string;
  displayName?: string;
  durationSec?: number;
  width?: number;
  height?: number;
  format?: string;
}

export interface PrepareAssetView {
  id: string;
  status: BatchAssetStatus;
  mediaKind: BatchAssetMediaKind;
  /** 快照时必须提交的真实素材分析版本；为空时 UI 不得允许选择。 */
  currentAnalysisId: string | null;
  /** 当前分析能力级别；当前本地实现只会产生 technical。 */
  analysisLevel: AssetAnalysisLevel;
  /** 由项目素材 id 稳定派生的安全媒体访问地址。 */
  thumbnailUrl: string;
  previewUrl: string;
  media: PrepareAssetMedia;
  sources: PrepareSourceView[];
}

export interface BatchPreparationResult {
  /** productCode 参与正式导出的文件名,为空时批量导出会被服务端拒绝 */
  project: { id: string; name: string; productCode: string };
  scripts: PrepareScriptView[];
  assets: PrepareAssetView[];
  /** 单条模块 4 产物登记失败等非致命问题,逐条说明,不阻塞整体展示 */
  warnings: string[];
}

function parseCoverTitle(value: string): PrepareCoverTitle {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { primary: '', secondary: '' };
    }
    const record = parsed as Record<string, unknown>;
    return {
      primary: typeof record.primary === 'string' ? record.primary : '',
      secondary: typeof record.secondary === 'string' ? record.secondary : '',
    };
  } catch {
    return { primary: '', secondary: '' };
  }
}

function safeSourceDisplayName(value: string | undefined, fallback: string): string {
  const leaf = value?.split(/[\\/]/).at(-1)?.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return leaf || fallback;
}

/**
 * 批量准备区数据入口(选择前的输入准备与展示):
 * 自动同步第 3 步有效脚本、自动登记第 4 步成功视频、核验所有素材来源
 * 的健康状态,返回可展示的脚本与素材列表。
 *
 * 不建立批次快照、不开始任何生产;批次快照与开跑属于 Phase B。
 * 只处理当前项目的脚本与视频,不跨项目取材。
 */
export async function prepareBatchProductionInputs(
  db: Database.Database,
  projectId: string,
): Promise<BatchPreparationResult> {
  const project = db.prepare(`
    SELECT id, name, productCode FROM projects WHERE id = ?
  `).get(projectId) as { id: string; name: string; productCode: string | null } | undefined;
  if (!project) {
    throw new Error('项目不存在');
  }

  // 1. 第 3 步有效脚本自动进入脚本目录
  syncProjectScripts(db, projectId);

  // 2. 第 4 步成功视频自动登记为项目素材(单条失败不阻塞整体)
  const warnings: string[] = [];
  const succeededJobs = db.prepare(`
    SELECT id FROM video_jobs
    WHERE projectId = ? AND status = 'succeeded' AND localVideoPath IS NOT NULL
      AND ${videoJobNotRejectedSql(db)}
    ORDER BY createdAt, id
  `).all(projectId) as Array<{ id: string }>;
  for (const { id } of succeededJobs) {
    try {
      await registerModule4Video(db, { videoJobId: id });
    } catch (error) {
      warnings.push(`视频任务 ${id} 登记失败:${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 3. 核验所有素材来源健康并聚合可用状态
  const assets = listProjectAssets(db, projectId);
  for (const asset of assets) {
    await verifyAssetSources(db, asset.id);
  }

  // 4. 组装展示数据
  const scripts: PrepareScriptView[] = listProjectScripts(db, projectId).map((row) => ({
    id: row.id,
    title: row.title,
    bodyText: row.bodyText,
    coverTitle: parseCoverTitle(row.coverTitleJson),
    shotSetId: row.shotSetId,
    sourceVersion: row.sourceVersion,
    contentRevision: row.contentRevision,
    updatedAt: row.updatedAt,
    targetDurationSec: row.targetDurationSec,
    narrationConfig: parseStoredNarrationConfig(row.narrationConfigJson),
    manual: row.sourceId.startsWith('manual:'),
  }));

  const assetViews: PrepareAssetView[] = listProjectAssets(db, projectId)
    .filter((row) => isBatchAssetEligible(db, row.id))
    .map((row: BatchAssetRow) => {
      const current = getCurrentAssetAnalysis(db, projectId, row.id);
      const encodedProjectId = encodeURIComponent(projectId);
      const encodedAssetId = encodeURIComponent(row.id);
      // 缩略图 URL 携带登记指纹前 16 位作为缓存版本:内容不变时 URL 稳定,
      // 内容替换后指纹变化,URL 变化,配合 immutable 长缓存不会吐旧图。
      const fingerprintVersion = (row.contentFingerprint.startsWith('sha256:')
        ? row.contentFingerprint.slice('sha256:'.length)
        : row.contentFingerprint).slice(0, 16);
      const media = JSON.parse(row.mediaJson) as PrepareAssetMedia;
      return {
        id: row.id,
        status: row.status,
        mediaKind: row.mediaKind,
        currentAnalysisId: current?.status === 'ready' ? current.id : null,
        analysisLevel: current?.status === 'ready' ? current.analysisLevel : 'none',
        thumbnailUrl: `/api/batch-production/assets/${encodedAssetId}/thumbnail?projectId=${encodedProjectId}&v=${encodeURIComponent(fingerprintVersion)}`,
        previewUrl: `/api/batch-production/assets/${encodedAssetId}/preview?projectId=${encodedProjectId}`,
        media,
        sources: listAssetSources(db, row.id).map((source) => {
          const fallbackName = source.sourceKind === 'module4'
            ? `视频任务 ${source.locationJson.kind === 'module4' ? source.locationJson.videoJobId : source.id}`
            : source.sourceKind === 'managed' ? '托管文件' : '用户文件';
          return {
            id: source.id,
            sourceKind: source.sourceKind,
            health: source.health,
            displayName: safeSourceDisplayName(media.displayName || media.filename, fallbackName),
          };
        }),
      };
    });

  return {
    project: { id: project.id, name: project.name, productCode: project.productCode ?? '' },
    scripts,
    assets: assetViews,
    warnings,
  };
}
