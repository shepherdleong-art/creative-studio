import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { mkdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { dataRoot } from '../data-root.ts';
import { runFfmpeg, probeVideoMedia, type VideoMediaProbe } from '../ffmpeg.ts';
import {
  isDetectedVideoContainerCompatible,
  SUPPORTED_VIDEO_MIME_BY_EXTENSION,
} from '../video-file-format.ts';
import { BatchDomainError } from './errors.ts';
import {
  computeFileSha256,
  listAssetSources,
  resolveSourceFilePath,
  type BatchAssetSourceView,
} from './media-catalog.ts';
import { getAsset, syncAssetStatusFromSources, type BatchAssetRow } from './assets.ts';
import { assertNoStorageSymlink } from '../final-edit/storage-path.ts';

export interface VerifiedProjectAssetMedia {
  asset: BatchAssetRow;
  source: BatchAssetSourceView;
  filePath: string;
  fingerprint: string;
  fileIdentity: ProjectAssetFileIdentity;
  media: VideoMediaProbe;
}

export interface ProjectAssetFileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

export interface MaterializedAssetThumbnail {
  absolutePath: string;
  relativePath: string;
  fingerprint: string;
}

const thumbnailJobs = new Map<string, Promise<MaterializedAssetThumbnail>>();

function storageRoot(): string {
  return path.join(dataRoot(), 'storage');
}

function thumbnailRelativePath(projectId: string, assetId: string, fingerprint: string): string {
  const safeProject = createHash('sha256').update(projectId).digest('hex');
  const safeAsset = createHash('sha256').update(assetId).digest('hex');
  return path.join('batch-media', 'thumbnails', safeProject, safeAsset, `${fingerprint.slice(0, 64)}.jpg`);
}

function assertRegularFile(filePath: string): fs.Stats {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('素材不是安全的普通文件');
  return stat;
}

export function projectAssetFileIdentity(stat: fs.Stats): ProjectAssetFileIdentity {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
}

export function matchesProjectAssetFileIdentity(
  stat: fs.Stats,
  expected: ProjectAssetFileIdentity,
): boolean {
  const actual = projectAssetFileIdentity(stat);
  return actual.dev === expected.dev
    && actual.ino === expected.ino
    && actual.size === expected.size
    && actual.mtimeMs === expected.mtimeMs;
}

export function assertProjectAssetFileIdentity(
  filePath: string,
  expected: ProjectAssetFileIdentity,
): void {
  if (!matchesProjectAssetFileIdentity(assertRegularFile(filePath), expected)) {
    throw new BatchDomainError('conflict', '素材文件在核验后发生变化,请重新登记素材');
  }
}

function assertVideoContainer(filePath: string, media: VideoMediaProbe): void {
  const extension = path.extname(filePath).toLowerCase();
  if (!SUPPORTED_VIDEO_MIME_BY_EXTENSION[extension]) {
    throw new Error('仅支持 MP4、MOV、AVI、WebM 视频文件');
  }
  if (media.errorMessage || media.durationUs <= 0 || media.width <= 0 || media.height <= 0) {
    throw new Error('无法读取视频容器或媒体信息');
  }
  if (!isDetectedVideoContainerCompatible(filePath, media.format)) {
    throw new Error('视频内容与文件扩展名不一致');
  }
}

function markSourceHealth(
  db: Database.Database,
  source: BatchAssetSourceView,
  health: 'healthy' | 'offline' | 'changed',
): void {
  if (source.health !== health) {
    db.prepare(`UPDATE batch_asset_sources SET health = ? WHERE id = ?`).run(health, source.id);
  }
}

/**
 * 从项目素材库解析并重新核验一个来源。调用方不能传入路径；这里只读
 * projectId + assetId，重新检查来源健康、普通文件、完整内容指纹与容器。
 */
export async function resolveVerifiedProjectAssetMedia(
  db: Database.Database,
  projectId: string,
  assetId: string,
): Promise<VerifiedProjectAssetMedia> {
  const asset = getAsset(db, projectId, assetId);
  if (!asset) throw new BatchDomainError('not_found', '素材不存在');
  if (asset.status !== 'online') {
    throw new BatchDomainError(
      'conflict',
      asset.status === 'archived' ? '素材已归档' : '素材来源离线,请先重新同步或定位原片',
    );
  }

  const sources = listAssetSources(db, assetId);
  let sawChanged = false;
  let sawOffline = false;
  for (const source of sources) {
    let filePath: string;
    try {
      filePath = resolveSourceFilePath(source.locationJson);
      // linked 文件可以位于系统的符号链接目录（例如 macOS /var -> /private/var），
      // 受控 storage 来源的父级安全性已由 resolveSourceFilePath/resolveStoragePath
      // 核验；这里统一再核验最终路径本身不是符号链接。
      assertRegularFile(filePath);
    } catch {
      sawOffline = true;
      markSourceHealth(db, source, 'offline');
      continue;
    }

    let fingerprint: string;
    try {
      fingerprint = await computeFileSha256(filePath);
    } catch {
      sawOffline = true;
      markSourceHealth(db, source, 'offline');
      continue;
    }
    if (asset.contentFingerprint !== `sha256:${fingerprint}`) {
      sawChanged = true;
      markSourceHealth(db, source, 'changed');
      continue;
    }

    let media: VideoMediaProbe;
    try {
      media = await probeVideoMedia(filePath);
      if (asset.mediaKind === 'video') assertVideoContainer(filePath, media);
    } catch {
      sawChanged = true;
      markSourceHealth(db, source, 'changed');
      continue;
    }
    // FFprobe 读取期间文件仍可能变化；在最终 SHA-256 前后固定同一普通
    // 文件身份，并再次比对登记指纹，后续打开时还会用该身份复核 fd。
    let beforeFinalHash: fs.Stats;
    let finalFingerprint: string;
    let afterFinalHash: fs.Stats;
    try {
      beforeFinalHash = assertRegularFile(filePath);
      finalFingerprint = await computeFileSha256(filePath);
      afterFinalHash = assertRegularFile(filePath);
    } catch {
      sawOffline = true;
      markSourceHealth(db, source, 'offline');
      continue;
    }
    if (
      !matchesProjectAssetFileIdentity(afterFinalHash, projectAssetFileIdentity(beforeFinalHash))
      || asset.contentFingerprint !== `sha256:${finalFingerprint}`
    ) {
      sawChanged = true;
      markSourceHealth(db, source, 'changed');
      continue;
    }
    markSourceHealth(db, source, 'healthy');
    const finalAssetState = getAsset(db, projectId, assetId);
    if (finalAssetState?.status !== 'online') {
      throw new BatchDomainError('conflict', '素材在核验期间变为离线或归档');
    }

    // 返回的内容指纹与文件身份是后续最终打开/发布必须再次匹配的边界。
    return {
      asset,
      source,
      filePath,
      fingerprint: finalFingerprint,
      fileIdentity: projectAssetFileIdentity(afterFinalHash),
      media,
    };
  }

  syncAssetStatusFromSources(db, assetId);
  if (sawChanged) {
    throw new BatchDomainError('conflict', '素材内容已变化,请重新登记素材');
  }
  if (sawOffline || sources.length === 0) {
    throw new BatchDomainError('conflict', '素材来源离线或不可读,请重新定位原片');
  }
  throw new BatchDomainError('conflict', '素材没有可用来源');
}

async function materializeThumbnail(
  source: VerifiedProjectAssetMedia,
  absolutePath: string,
  relativePath: string,
): Promise<MaterializedAssetThumbnail> {
  if (fs.existsSync(absolutePath)) {
    assertRegularFile(absolutePath);
    return { absolutePath, relativePath, fingerprint: source.fingerprint };
  }
  await mkdir(path.dirname(absolutePath), { recursive: true });
  const temporaryPath = `${absolutePath}.${randomUUID()}.tmp.jpg`;
  try {
    assertProjectAssetFileIdentity(source.filePath, source.fileIdentity);
    const frameUs = Math.max(0, Math.min(1_000_000, Math.floor(source.media.durationUs * 0.1)));
    await runFfmpeg([
      '-ss', (frameUs / 1_000_000).toFixed(6),
      '-i', source.filePath,
      '-frames:v', '1',
      '-vf', 'scale=960:540:force_original_aspect_ratio=increase,crop=960:540',
      '-q:v', '3',
      '-y', temporaryPath,
    ], { timeoutMs: 60_000 });

    // Do not publish a frame derived from a file that changed while FFmpeg read it.
    const beforeAfterHash = assertRegularFile(source.filePath);
    const afterFingerprint = await computeFileSha256(source.filePath);
    const afterAfterHash = assertRegularFile(source.filePath);
    if (
      afterFingerprint !== source.fingerprint
      || !matchesProjectAssetFileIdentity(beforeAfterHash, source.fileIdentity)
      || !matchesProjectAssetFileIdentity(afterAfterHash, source.fileIdentity)
    ) {
      throw new BatchDomainError('conflict', '素材在缩略图生成期间发生变化');
    }
    assertRegularFile(temporaryPath);
    await rename(temporaryPath, absolutePath).catch((error: unknown) => {
      // Another request may have atomically published the same deterministic cache.
      if (!fs.existsSync(absolutePath)) throw error;
    });
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
  return { absolutePath, relativePath, fingerprint: source.fingerprint };
}

/**
 * 生成受控、稳定身份的缩略图。缓存 key 只依赖项目/素材/完整指纹，临时
 * 文件原子发布，原片永远不被改写。
 */
export async function materializeProjectAssetThumbnail(
  db: Database.Database,
  projectId: string,
  assetId: string,
): Promise<MaterializedAssetThumbnail> {
  const source = await resolveVerifiedProjectAssetMedia(db, projectId, assetId);
  const relativePath = thumbnailRelativePath(projectId, assetId, source.fingerprint);
  const absolutePath = assertNoStorageSymlink(storageRoot(), relativePath);
  if (!absolutePath.startsWith(`${path.resolve(storageRoot())}${path.sep}`)) {
    throw new Error('缩略图缓存路径越界');
  }
  const key = absolutePath;
  let job = thumbnailJobs.get(key);
  if (!job) {
    job = materializeThumbnail(source, absolutePath, relativePath);
    thumbnailJobs.set(key, job);
    void job.finally(() => {
      if (thumbnailJobs.get(key) === job) thumbnailJobs.delete(key);
    }).catch(() => undefined);
  }
  return job;
}

export function projectAssetMimeType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.mov': return 'video/quicktime';
    case '.webm': return 'video/webm';
    case '.avi': return 'video/x-msvideo';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.png': return 'image/png';
    case '.webp': return 'image/webp';
    default: return 'video/mp4';
  }
}
