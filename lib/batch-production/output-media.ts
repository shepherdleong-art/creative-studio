import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { dataRoot } from '../data-root.ts';
import { assertNoStorageSymlink, resolveStoragePath } from '../media-core/storage-path.ts';
import { BatchDomainError } from './errors.ts';
import { batchArtifactPathsArePaired } from './artifact-pair.ts';

export type BatchOutputMediaKind = 'video' | 'cover';
export type BatchOutputMediaSource = 'candidate' | 'artifact';

export interface BatchOutputMediaFile {
  absolutePath: string;
  contentType: 'video/mp4' | 'image/jpeg';
  source: BatchOutputMediaSource;
  productionReady: boolean;
  /** 成片序号:下载文件名由服务端拼接(成片-<序号>-v<版本>-预览.*) */
  planSeq: number;
  /** 当前解析的成片版本号,供下载文件名使用。 */
  outputVersionNumber: number;
}

export interface BatchOutputNarrationFile {
  absolutePath: string;
  contentType: 'audio/wav';
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

function parseCoverCandidate(raw: string | null, expected: {
  projectId: string;
  batchId: string;
  batchVersionId: string;
  planId: string;
  outputVersionId: string;
}): {
  coverRelativePath: string;
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
      || typeof value.coverRelativePath !== 'string'
    ) return null;
    return {
      coverRelativePath: value.coverRelativePath,
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
  /**
   * 绑定到某个具体成功渲染尝试:传入时只解析该 attempt 的产物(同 URL 的所有
   * Range 请求固定同一文件);不传保持「最近一次成功候选」行为。
   */
  renderAttemptId?: string,
  /**
   * 绑定到某个已登记的正式视频 artifact:传入时只解析该 artifact(及其配对封面);
   * 不传保持「当前指针/按版本」行为。
   */
  artifactId?: string,
): BatchOutputMediaFile {
  const storageRoot = path.resolve(storageRootInput ?? path.join(dataRoot(), 'storage'));
  const plan = db.prepare(`
    SELECT p.batchVersionId, p.currentVersionId, p.currentArtifactId, p.seq
    FROM batch_output_plans p
    JOIN batch_production_versions v ON v.id = p.batchVersionId
    JOIN batch_productions b ON b.id = v.batchId
    WHERE p.id = ? AND b.id = ? AND b.projectId = ? AND b.deletedAt IS NULL
  `).get(planId, batchId, projectId) as {
    batchVersionId: string;
    currentVersionId: string | null;
    currentArtifactId: string | null;
    seq: number;
  } | undefined;
  if (!plan) throw new BatchDomainError('not_found', '成片计划不存在');

  // 历史版本必须属于该计划;指定版本时校验谱系,避免跨计划读取
  let targetVersionId = plan.currentVersionId;
  let outputVersionNumber = 0;
  if (outputVersionId) {
    const version = db.prepare(`
      SELECT versionNumber FROM batch_output_versions WHERE id = ? AND planId = ?
    `).get(outputVersionId, planId) as { versionNumber: number } | undefined;
    if (!version) throw new BatchDomainError('not_found', '指定的成片版本不存在');
    targetVersionId = outputVersionId;
    outputVersionNumber = version.versionNumber;
  } else {
    const version = targetVersionId ? db.prepare(`
      SELECT versionNumber FROM batch_output_versions WHERE id = ?
    `).get(targetVersionId) as { versionNumber: number } | undefined : undefined;
    outputVersionNumber = version?.versionNumber ?? 0;
  }

  let relativePath: string | null = null;
  let productionReady = true;
  if (source === 'candidate') {
    if (!targetVersionId) throw new BatchDomainError('conflict', '成片计划还没有当前候选版本');
    // 传了 renderAttemptId:只解析该成功尝试,并校验它确实属于
    // project→batch→plan→outputVersion 谱系;不传则取"最近一次成功的尝试"。
    // 两种路径 resultJson 与身份必须来自同一 attempt 行。
    if (kind === 'cover') {
      const coverAttempt = renderAttemptId
        ? db.prepare(`
            SELECT a.resultJson
            FROM batch_task_attempts a
            JOIN batch_tasks t ON t.id = a.taskId
            WHERE a.id = ? AND a.status = 'succeeded'
              AND t.projectId = ? AND t.batchId = ? AND t.workType = 'render'
              AND t.targetKind = 'output_version_cover' AND t.targetId = ?
          `).get(renderAttemptId, projectId, batchId, targetVersionId) as { resultJson: string | null } | undefined
        : db.prepare(`
            SELECT a.resultJson
            FROM batch_tasks t
            JOIN batch_task_attempts a ON a.id = (
              SELECT id FROM batch_task_attempts
              WHERE taskId = t.id AND status = 'succeeded'
              ORDER BY attemptNumber DESC LIMIT 1
            )
            WHERE t.projectId = ? AND t.batchId = ? AND t.workType = 'render'
              AND t.targetKind = 'output_version_cover' AND t.targetId = ?
            ORDER BY t.createdAt DESC, t.id DESC LIMIT 1
          `).get(projectId, batchId, targetVersionId) as { resultJson: string | null } | undefined;

      const coverCandidate = coverAttempt ? parseCoverCandidate(coverAttempt.resultJson, {
        projectId,
        batchId,
        batchVersionId: plan.batchVersionId,
        planId,
        outputVersionId: targetVersionId,
      }) : null;
      if (coverCandidate) {
        relativePath = coverCandidate.coverRelativePath;
        productionReady = true;
      }
    }

    if (!relativePath) {
      const attempt = renderAttemptId
        ? db.prepare(`
            SELECT a.resultJson
            FROM batch_task_attempts a
            JOIN batch_tasks t ON t.id = a.taskId
            WHERE a.id = ? AND a.status = 'succeeded'
              AND t.projectId = ? AND t.batchId = ? AND t.workType = 'render'
              AND t.targetKind = 'output_version' AND t.targetId = ?
          `).get(renderAttemptId, projectId, batchId, targetVersionId) as { resultJson: string | null } | undefined
        : db.prepare(`
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
      if (!attempt) {
        throw new BatchDomainError(
          'not_found',
          renderAttemptId ? '指定的渲染尝试不存在、非成功或不属于该成片' : (kind === 'video' ? '该成片版本没有可播放的视频' : '该成片版本没有封面'),
        );
      }
      const candidate = parseCandidate(attempt.resultJson, {
        projectId,
        batchId,
        batchVersionId: plan.batchVersionId,
        planId,
        outputVersionId: targetVersionId,
      });
      if (!candidate) throw new BatchDomainError('not_found', kind === 'video' ? '该成片版本没有可播放的视频' : '该成片版本没有封面');
      relativePath = kind === 'video' ? candidate.videoRelativePath : candidate.coverRelativePath;
      productionReady = candidate.productionReady;
    }
  } else {
    // 传了 artifactId:只解析该已登记视频 artifact(及同导出对的封面),校验谱系;
    // 否则按指定版本查历史正式产物,再回落到当前指针。
    let video: {
      id: string;
      outputVersionId: string;
      createdAt: string;
      relativePath: string;
    } | undefined;
    if (artifactId) {
      video = db.prepare(`
          SELECT id, outputVersionId, createdAt, relativePath
          FROM batch_artifacts
          WHERE id = ? AND projectId = ? AND batchId = ? AND outputPlanId = ? AND kind = 'video'
            ${outputVersionId ? 'AND outputVersionId = ?' : ''}
        `).get(...(outputVersionId
          ? [artifactId, projectId, batchId, planId, outputVersionId]
          : [artifactId, projectId, batchId, planId])) as {
            id: string;
            outputVersionId: string;
            createdAt: string;
            relativePath: string;
          } | undefined;
    } else if (outputVersionId) {
      video = db.prepare(`
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
        } | undefined;
    } else if (plan.currentArtifactId) {
      video = db.prepare(`
          SELECT id, outputVersionId, createdAt, relativePath
          FROM batch_artifacts
          WHERE id = ? AND projectId = ? AND batchId = ? AND outputPlanId = ? AND kind = 'video'
        `).get(plan.currentArtifactId, projectId, batchId, planId) as {
          id: string;
          outputVersionId: string;
          createdAt: string;
          relativePath: string;
        } | undefined;
    }
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
      const cover = covers.find(({ relativePath }) => batchArtifactPathsArePaired(video.relativePath, relativePath));
      if (!cover) throw new BatchDomainError('not_found', '该版本正式产物缺少配对封面');
      relativePath = cover.relativePath;
    }
  }
  return {
    absolutePath: safeMediaPath(storageRoot, relativePath),
    contentType: kind === 'video' ? 'video/mp4' : 'image/jpeg',
    source,
    productionReady,
    planSeq: plan.seq,
    outputVersionNumber,
  };
}

/**
 * 口播音频(检查成片实时预览的数据源):相对路径就地存在当前候选版本
 * arrangement 的 narration.audioRelativePath(口播执行器写入)。
 * 正式产物不单独交付口播,所以只按 arrangement 当前值解析,无 artifact 形态。
 */
export function resolveBatchOutputNarrationAudio(
  db: Database.Database,
  projectId: string,
  batchId: string,
  planId: string,
  storageRootInput?: string,
): BatchOutputNarrationFile {
  const storageRoot = path.resolve(storageRootInput ?? path.join(dataRoot(), 'storage'));
  const plan = db.prepare(`
    SELECT p.currentVersionId
    FROM batch_output_plans p
    JOIN batch_production_versions v ON v.id = p.batchVersionId
    JOIN batch_productions b ON b.id = v.batchId
    WHERE p.id = ? AND b.id = ? AND b.projectId = ? AND b.deletedAt IS NULL
  `).get(planId, batchId, projectId) as { currentVersionId: string | null } | undefined;
  if (!plan) throw new BatchDomainError('not_found', '成片计划不存在');
  if (!plan.currentVersionId) throw new BatchDomainError('conflict', '成片计划还没有当前候选版本');
  const version = db.prepare(`
    SELECT arrangementJson FROM batch_output_versions WHERE id = ? AND planId = ?
  `).get(plan.currentVersionId, planId) as { arrangementJson: string } | undefined;
  if (!version) throw new BatchDomainError('not_found', '成片版本不存在');
  let audioRelativePath: string | null = null;
  try {
    const arrangement = JSON.parse(version.arrangementJson) as { narration?: { audioRelativePath?: unknown } };
    const value = arrangement?.narration?.audioRelativePath;
    if (typeof value === 'string' && value.trim()) audioRelativePath = value.trim();
  } catch {
    audioRelativePath = null;
  }
  if (!audioRelativePath) throw new BatchDomainError('not_found', '该成片版本还没有可用的口播音频');
  return { absolutePath: safeMediaPath(storageRoot, audioRelativePath), contentType: 'audio/wav' };
}
