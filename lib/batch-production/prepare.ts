import type Database from 'better-sqlite3';
import {
  listProjectAssets,
  type BatchAssetMediaKind,
  type BatchAssetRow,
  type BatchAssetSourceKind,
  type BatchAssetStatus,
} from './assets.ts';
import {
  listAssetSources,
  registerModule4Video,
  verifyAssetSources,
  type BatchAssetSourceHealth,
  type BatchAssetSourceLocation,
} from './media-catalog.ts';
import { listProjectScripts } from './scripts.ts';
import { syncProjectScripts } from './script-catalog.ts';

export interface PrepareScriptView {
  id: string;
  title: string;
  bodyText: string;
  coverTitle: PrepareCoverTitle;
  shotSetId: string;
  sourceVersion: string;
  contentRevision: string;
  updatedAt: string;
}

export interface PrepareCoverTitle {
  primary: string;
  secondary: string;
}

export interface PrepareSourceView {
  id: string;
  sourceKind: BatchAssetSourceKind;
  health: BatchAssetSourceHealth;
  location: BatchAssetSourceLocation;
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
  media: PrepareAssetMedia;
  sources: PrepareSourceView[];
}

export interface BatchPreparationResult {
  project: { id: string; name: string };
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
    SELECT id, name FROM projects WHERE id = ?
  `).get(projectId) as { id: string; name: string } | undefined;
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
  }));

  const assetViews: PrepareAssetView[] = listProjectAssets(db, projectId).map((row: BatchAssetRow) => ({
    id: row.id,
    status: row.status,
    mediaKind: row.mediaKind,
    currentAnalysisId: row.currentAnalysisId,
    media: JSON.parse(row.mediaJson) as PrepareAssetMedia,
    sources: listAssetSources(db, row.id).map((source) => ({
      id: source.id,
      sourceKind: source.sourceKind,
      health: source.health,
      location: source.locationJson,
    })),
  }));

  return {
    project: { id: project.id, name: project.name },
    scripts,
    assets: assetViews,
    warnings,
  };
}
