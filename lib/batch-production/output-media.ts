import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { dataRoot } from '../data-root.ts';
import { assertNoStorageSymlink, resolveStoragePath } from '../media-core/storage-path.ts';
import { BatchDomainError } from './errors.ts';

export type BatchOutputMediaKind = 'video' | 'cover';
export type BatchOutputMediaSource = 'candidate' | 'artifact';

export interface BatchOutputMediaFile {
  absolutePath: string;
  contentType: 'video/mp4' | 'image/jpeg';
  source: BatchOutputMediaSource;
  productionReady: boolean;
}

function safeMediaPath(storageRoot: string, relativePath: string): string {
  let absolutePath: string;
  let stat: fs.Stats;
  try {
    absolutePath = resolveStoragePath(storageRoot, relativePath);
    assertNoStorageSymlink(storageRoot, relativePath);
    stat = fs.lstatSync(absolutePath);
  } catch (caught) {
    if ((caught as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new BatchDomainError('not_found', '成片媒体文件不存在或不可读');
    }
    throw caught;
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0) {
    throw new BatchDomainError('not_found', '成片媒体文件不存在或不可读');
  }
  return absolutePath;
}

/**
 * 视频与封面的配对键。命名合约里封面比视频多一个「-封面」后缀
 * (`成片-<编码>-<日期>-<序号>.mp4` / `...-封面.jpg`),所以去掉扩展名后
 * 还要去掉这个后缀,两者才归到同一个键。旧命名(视频封面同名不同扩展)
 * 不含该后缀,行为不变。
 */
function mediaPairKey(relativePath: string): string {
  return relativePath.replace(/\.[^./\\]+$/u, '').replace(/-封面$/u, '');
}

function parseCandidate(raw: string | null, expected: {
  projectId: string;
  batchId: string;
  batchVersionId: string;
  planId: string;
  outputVersionId: string;
}): {
  videoRelativePath: string;
  coverRelativePath: string;
  productionReady: boolean;
} | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      value.projectId !== expected.projectId
      || value.batchId !== expected.batchId
      || value.batchVersionId !== expected.batchVersionId
      || value.planId !== expected.planId
      || value.outputVersionId !== expected.outputVersionId
      || typeof value.videoRelativePath !== 'string'
      || typeof value.coverRelativePath !== 'string'
      || (value.audioMode !== 'narration' && value.audioMode !== 'silent_placeholder')
      || typeof value.productionReady !== 'boolean'
      || value.productionReady !== (value.audioMode === 'narration')
    ) return null;
    return {
      videoRelativePath: value.videoRelativePath,
      coverRelativePath: value.coverRelativePath,
      productionReady: value.productionReady,
    };
  } catch {
    return null;
  }
}

/** Resolve by stable ids only; no browser-supplied filesystem path is accepted. */
export function resolveBatchOutputMedia(
  db: Database.Database,
  projectId: string,
  batchId: string,
  planId: string,
  kind: BatchOutputMediaKind,
  source: BatchOutputMediaSource,
  storageRootInput?: string,
  /** 指定成片版本(历史版本切换);缺省用当前版本 */
  outputVersionId?: string,
): BatchOutputMediaFile {
  const storageRoot = path.resolve(storageRootInput ?? path.join(dataRoot(), 'storage'));
  const plan = db.prepare(`
    SELECT p.batchVersionId, p.currentVersionId, p.currentArtifactId
    FROM batch_output_plans p
    JOIN batch_production_versions v ON v.id = p.batchVersionId
    JOIN batch_productions b ON b.id = v.batchId
    WHERE p.id = ? AND b.id = ? AND b.projectId = ? AND b.deletedAt IS NULL
  `).get(planId, batchId, projectId) as {
    batchVersionId: string;
    currentVersionId: string | null;
    currentArtifactId: string | null;
  } | undefined;
  if (!plan) throw new BatchDomainError('not_found', '成片计划不存在');

  // 历史版本必须属于该计划;指定版本时校验谱系,避免跨计划读取
  let targetVersionId = plan.currentVersionId;
  if (outputVersionId) {
    const version = db.prepare(`
      SELECT 1 FROM batch_output_versions WHERE id = ? AND planId = ?
    `).get(outputVersionId, planId);
    if (!version) throw new BatchDomainError('not_found', '指定的成片版本不存在');
    targetVersionId = outputVersionId;
  }

  let relativePath: string | null = null;
  let productionReady = true;
  if (source === 'candidate') {
    if (!targetVersionId) throw new BatchDomainError('conflict', '成片计划还没有当前候选版本');
    // 候选一律取"最近一次成功的尝试",不要求任务当前处于 succeeded:
    // 重渲染(queued/running/failed)期间与之后,老版本仍然可播放、可预览。
    const attempt = db.prepare(`
      SELECT a.resultJson
      FROM batch_tasks t
      JOIN batch_task_attempts a ON a.id = (
        SELECT id FROM batch_task_attempts
        WHERE taskId = t.id AND status = 'succeeded'
        ORDER BY attemptNumber DESC LIMIT 1
      )
      WHERE t.projectId = ? AND t.batchId = ? AND t.workType = 'render'
        AND t.targetKind = 'output_version' AND t.targetId = ?
      ORDER BY t.createdAt DESC, t.id DESC LIMIT 1
    `).get(projectId, batchId, targetVersionId) as { resultJson: string | null } | undefined;
    const candidate = parseCandidate(attempt?.resultJson ?? null, {
      projectId,
      batchId,
      batchVersionId: plan.batchVersionId,
      planId,
      outputVersionId: targetVersionId,
    });
    if (!candidate) throw new BatchDomainError('not_found', '该成片版本没有可播放的渲染候选');
    relativePath = kind === 'video' ? candidate.videoRelativePath : candidate.coverRelativePath;
    productionReady = candidate.productionReady;
  } else {
    // 指定版本时按版本查正式产物(历史导出的 artifact 按版本保留);缺省用当前指针。
    const video = outputVersionId
      ? db.prepare(`
          SELECT id, outputVersionId, createdAt, relativePath
          FROM batch_artifacts
          WHERE projectId = ? AND batchId = ? AND outputPlanId = ?
            AND outputVersionId = ? AND kind = 'video'
          ORDER BY createdAt DESC, id DESC LIMIT 1
        `).get(projectId, batchId, planId, outputVersionId) as {
          id: string;
          outputVersionId: string;
          createdAt: string;
          relativePath: string;
        } | undefined
      : plan.currentArtifactId
        ? db.prepare(`
            SELECT id, outputVersionId, createdAt, relativePath
            FROM batch_artifacts
            WHERE id = ? AND projectId = ? AND batchId = ? AND outputPlanId = ? AND kind = 'video'
          `).get(plan.currentArtifactId, projectId, batchId, planId) as {
            id: string;
            outputVersionId: string;
            createdAt: string;
            relativePath: string;
          } | undefined
        : undefined;
    if (!video) throw new BatchDomainError('not_found', '该版本没有正式视频产物');
    if (kind === 'video') {
      relativePath = video.relativePath;
    } else {
      const covers = db.prepare(`
        SELECT relativePath FROM batch_artifacts
        WHERE projectId = ? AND batchId = ? AND outputPlanId = ?
          AND outputVersionId = ? AND kind = 'cover'
        ORDER BY createdAt DESC, id DESC
      `).all(projectId, batchId, planId, video.outputVersionId) as Array<{ relativePath: string }>;
      const cover = covers.find(({ relativePath }) => mediaPairKey(relativePath) === mediaPairKey(video.relativePath));
      if (!cover) throw new BatchDomainError('not_found', '该版本正式产物缺少配对封面');
      relativePath = cover.relativePath;
    }
  }
  return {
    absolutePath: safeMediaPath(storageRoot, relativePath),
    contentType: kind === 'video' ? 'video/mp4' : 'image/jpeg',
    source,
    productionReady,
  };
}
