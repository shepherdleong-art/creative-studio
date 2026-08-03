import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { dataRoot } from '../data-root.ts';
import { assertNoStorageSymlink, resolveStoragePath } from '../final-edit/storage-path.ts';
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

function mediaPairKey(relativePath: string): string {
  return relativePath.replace(/\.[^./\\]+$/u, '');
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

  let relativePath: string | null = null;
  let productionReady = true;
  if (source === 'candidate') {
    if (!plan.currentVersionId) throw new BatchDomainError('conflict', '成片计划还没有当前候选版本');
    const attempt = db.prepare(`
      SELECT a.resultJson
      FROM batch_tasks t
      JOIN batch_task_attempts a ON a.taskId = t.id
        AND a.attemptNumber = t.attemptCount AND a.status = 'succeeded'
      WHERE t.projectId = ? AND t.batchId = ? AND t.workType = 'render'
        AND t.targetKind = 'output_version' AND t.targetId = ? AND t.status = 'succeeded'
      ORDER BY t.createdAt DESC, t.id DESC LIMIT 1
    `).get(projectId, batchId, plan.currentVersionId) as { resultJson: string | null } | undefined;
    const candidate = parseCandidate(attempt?.resultJson ?? null, {
      projectId,
      batchId,
      batchVersionId: plan.batchVersionId,
      planId,
      outputVersionId: plan.currentVersionId,
    });
    if (!candidate) throw new BatchDomainError('not_found', '当前成片版本没有可播放的渲染候选');
    relativePath = kind === 'video' ? candidate.videoRelativePath : candidate.coverRelativePath;
    productionReady = candidate.productionReady;
  } else {
    if (!plan.currentArtifactId) throw new BatchDomainError('not_found', '成片计划还没有正式产物');
    const currentVideo = db.prepare(`
      SELECT id, outputVersionId, createdAt, relativePath
      FROM batch_artifacts
      WHERE id = ? AND projectId = ? AND batchId = ? AND outputPlanId = ? AND kind = 'video'
    `).get(plan.currentArtifactId, projectId, batchId, planId) as {
      id: string;
      outputVersionId: string;
      createdAt: string;
      relativePath: string;
    } | undefined;
    if (!currentVideo) throw new BatchDomainError('not_found', '当前正式视频产物不存在');
    if (kind === 'video') {
      relativePath = currentVideo.relativePath;
    } else {
      const covers = db.prepare(`
        SELECT relativePath FROM batch_artifacts
        WHERE projectId = ? AND batchId = ? AND outputPlanId = ?
          AND outputVersionId = ? AND kind = 'cover'
        ORDER BY createdAt DESC, id DESC
      `).all(projectId, batchId, planId, currentVideo.outputVersionId) as Array<{ relativePath: string }>;
      const cover = covers.find(({ relativePath }) => mediaPairKey(relativePath) === mediaPairKey(currentVideo.relativePath));
      if (!cover) throw new BatchDomainError('not_found', '当前正式产物缺少配对封面');
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
