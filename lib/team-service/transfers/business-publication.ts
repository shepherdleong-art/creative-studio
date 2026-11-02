import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type Database from 'better-sqlite3';
import { dataRoot } from '../../data-root.ts';
import { probeDurationSec, probeVideoMedia, type VideoMediaProbe } from '../../ffmpeg.ts';
import { isDetectedVideoContainerCompatible, SUPPORTED_VIDEO_MIME_BY_EXTENSION } from '../../video-file-format.ts';
import { createAsset } from '../../batch-production/assets.ts';
import {
  CANVAS_ASSET_MAX_BYTES,
  CANVAS_MIME_BY_EXTENSION,
  detectCanvasMediaKind,
} from '../../creative-canvas/assets.ts';
import type { CanvasMediaKind } from '../../creative-canvas/types.ts';
import { createOrFindSourceSet } from '../../script-studio/source-sets.ts';
import { registerInheritedScope } from '../resource-scopes.ts';
import { TransferError } from './errors.ts';

export const TEAM_UPLOAD_TARGET_KINDS = ['project_image', 'batch_asset', 'canvas_asset', 'detail_page_source'] as const;
export type TeamUploadTargetKind = typeof TEAM_UPLOAD_TARGET_KINDS[number];

export interface BusinessUploadTarget {
  fileId: string;
  targetKind: string | null;
  targetResourceType: string;
  targetResourceId: string;
  relativeName: string;
  mimeType: string;
}

export interface PreparedBusinessPublication {
  kind: TeamUploadTargetKind;
  absolutePath: string;
  image?: { width: number; height: number };
  video?: VideoMediaProbe;
  canvas?: {
    mediaKind: CanvasMediaKind;
    mimeType: string;
    width: number | null;
    height: number | null;
    durationSec: number | null;
  };
}

export interface BusinessPublicationResult {
  resourceType: string;
  resourceId: string;
  references: Array<{ resourceType: string; resourceId: string; role: 'input' }>;
}

export function normalizeTeamUploadTargetKind(value: unknown): TeamUploadTargetKind | null {
  if (value === undefined || value === null || value === '') return null;
  if (value === 'image') return 'project_image';
  if (value === 'detail_page') return 'detail_page_source';
  if (typeof value === 'string' && (TEAM_UPLOAD_TARGET_KINDS as readonly string[]).includes(value)) {
    return value as TeamUploadTargetKind;
  }
  throw new TransferError('invalid_input', '上传业务目标类型无效。');
}

export function expectedTeamUploadScope(kind: TeamUploadTargetKind): string {
  return kind === 'canvas_asset' ? 'canvas' : 'project';
}

export function expectedTeamUploadUsage(kind: TeamUploadTargetKind): string {
  switch (kind) {
    case 'project_image': return 'image';
    case 'batch_asset': return 'batch_asset';
    case 'canvas_asset': return 'canvas_asset';
    case 'detail_page_source': return 'detail_page';
  }
}

export async function prepareBusinessPublication(
  upload: BusinessUploadTarget,
  absolutePath: string,
): Promise<PreparedBusinessPublication | null> {
  const kind = normalizeTeamUploadTargetKind(upload.targetKind);
  if (!kind) return null;
  if (kind === 'project_image' || kind === 'detail_page_source') {
    try {
      const metadata = await sharp(absolutePath, { failOn: 'error' }).metadata();
      if (!metadata.width || !metadata.height) throw new Error('missing dimensions');
      return { kind, absolutePath, image: { width: metadata.width, height: metadata.height } };
    } catch {
      throw new TransferError('media_type_mismatch', '图片文件已损坏或无法读取尺寸。');
    }
  }
  if (kind === 'batch_asset') {
    if (!SUPPORTED_VIDEO_MIME_BY_EXTENSION[path.extname(absolutePath).toLowerCase()]) {
      throw new TransferError('invalid_input', '批量素材仅支持 MP4、MOV、AVI、WebM 视频。');
    }
    const media = await probeVideoMedia(absolutePath);
    if (media.errorMessage || media.durationUs <= 0 || media.width <= 0 || media.height <= 0
      || !isDetectedVideoContainerCompatible(absolutePath, media.format)) {
      throw new TransferError('media_type_mismatch', '无法读取视频容器或媒体信息。');
    }
    return { kind, absolutePath, video: media };
  }
  if (kind === 'canvas_asset') {
    const extension = path.extname(upload.relativeName).replace('.', '').toLowerCase();
    const mediaKind = detectCanvasMediaKind(upload.relativeName, upload.mimeType);
    if (!mediaKind) throw new TransferError('invalid_input', '画布素材文件类型不受支持。');
    if (fs.statSync(absolutePath).size > CANVAS_ASSET_MAX_BYTES[mediaKind]) {
      throw new TransferError('invalid_input', '画布素材超过大小上限。');
    }
    const mimeType = CANVAS_MIME_BY_EXTENSION[extension] ?? upload.mimeType;
    if (mediaKind === 'image') {
      try {
        const metadata = await sharp(absolutePath, { failOn: 'error' }).metadata();
        return {
          kind, absolutePath,
          canvas: {
            mediaKind, mimeType, width: metadata.width ?? null, height: metadata.height ?? null, durationSec: null,
          },
        };
      } catch {
        throw new TransferError('media_type_mismatch', '画布图片已损坏或无法解码。');
      }
    }
    const durationSec = await probeDurationSec(absolutePath).then((value) => (
      Number.isFinite(value) && value > 0 ? value : null
    )).catch(() => null);
    return {
      kind, absolutePath,
      canvas: { mediaKind, mimeType, width: null, height: null, durationSec },
    };
  }
  throw new TransferError('invalid_input', '该上传业务目标尚未实现发布适配。');
}

export function publishBusinessEntity(
  db: Database.Database,
  upload: BusinessUploadTarget,
  prepared: PreparedBusinessPublication,
): BusinessPublicationResult {
  if (prepared.kind === 'project_image') {
    if (!prepared.image) throw new TransferError('publish_conflict', '缺少图片发布元数据。');
    const projectId = upload.targetResourceId;
    if (!db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId)) {
      throw new TransferError('upload_not_found', '上传目标项目不存在。');
    }
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    db.prepare(`INSERT INTO image_assets (
      id, projectId, role, filename, path, originalPath, processedPath, mimeType,
      originalWidth, originalHeight, originalSizeBytes, preprocessingEnabled, usage, createdAt
    ) VALUES (?, ?, 'input', ?, ?, ?, NULL, ?, ?, ?, ?, 0, '', ?)`).run(
      id, projectId, path.basename(upload.relativeName), prepared.absolutePath, prepared.absolutePath,
      upload.mimeType, prepared.image.width, prepared.image.height,
      db.prepare('SELECT byteSize FROM team_files WHERE id = ?').pluck().get(upload.fileId), createdAt,
    );
    registerInheritedScope(db, {
      resourceType: 'image', resourceId: id,
      parent: { resourceType: 'project', resourceId: projectId },
    });
    return {
      resourceType: 'image', resourceId: id,
      references: [{ resourceType: 'image', resourceId: id, role: 'input' }],
    };
  }
  if (prepared.kind === 'batch_asset') {
    if (!prepared.video) throw new TransferError('publish_conflict', '缺少视频发布元数据。');
    const projectId = upload.targetResourceId;
    if (!db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId)) {
      throw new TransferError('upload_not_found', '上传目标项目不存在。');
    }
    const file = db.prepare('SELECT sha256 FROM team_files WHERE id = ?').get(upload.fileId) as { sha256: string };
    const displayName = path.basename(upload.relativeName);
    const location = { kind: 'managed' as const, relativePath: path.relative(dataRoot(), prepared.absolutePath) };
    const createdAt = new Date().toISOString();
    const assetId = createAsset(db, {
      projectId,
      sourceKind: 'managed',
      locationJson: location,
      contentFingerprint: `sha256:${file.sha256}`,
      mediaKind: 'video',
      mediaJson: {
        displayName,
        filename: displayName,
        durationSec: prepared.video.durationUs / 1_000_000,
        width: prepared.video.width,
        height: prepared.video.height,
        format: prepared.video.format ?? '',
      },
      now: () => new Date(createdAt),
    });
    db.prepare(`INSERT OR IGNORE INTO batch_asset_sources (
      id, assetId, sourceKind, locationJson, health, createdAt
    ) VALUES (?, ?, 'managed', ?, 'healthy', ?)`).run(
      randomUUID(), assetId, JSON.stringify(location), createdAt,
    );
    return {
      resourceType: 'batch_asset', resourceId: assetId,
      references: [{ resourceType: 'batch_asset', resourceId: assetId, role: 'input' }],
    };
  }
  if (prepared.kind === 'detail_page_source') {
    if (!prepared.image) throw new TransferError('publish_conflict', '缺少详情页图片发布元数据。');
    const projectId = upload.targetResourceId;
    if (!db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId)) {
      throw new TransferError('upload_not_found', '上传目标项目不存在。');
    }
    const imageId = randomUUID();
    const createdAt = new Date().toISOString();
    const byteSize = db.prepare('SELECT byteSize FROM team_files WHERE id = ?').pluck().get(upload.fileId) as number;
    db.prepare(`INSERT INTO image_assets (
      id, projectId, role, filename, path, originalPath, processedPath, mimeType,
      originalWidth, originalHeight, originalSizeBytes, preprocessingEnabled, usage, createdAt
    ) VALUES (?, ?, 'input', ?, ?, ?, NULL, ?, ?, ?, ?, 0, 'detail_page', ?)`).run(
      imageId, projectId, path.basename(upload.relativeName), prepared.absolutePath, prepared.absolutePath,
      upload.mimeType, prepared.image.width, prepared.image.height, byteSize, createdAt,
    );
    registerInheritedScope(db, {
      resourceType: 'image', resourceId: imageId,
      parent: { resourceType: 'project', resourceId: projectId },
    });
    const sourceSet = createOrFindSourceSet(db, projectId, [imageId]);
    return {
      resourceType: 'script_source_set', resourceId: sourceSet.sourceSetId,
      references: [
        { resourceType: 'image', resourceId: imageId, role: 'input' },
        { resourceType: 'script_source_set', resourceId: sourceSet.sourceSetId, role: 'input' },
      ],
    };
  }
  if (prepared.kind === 'canvas_asset') {
    if (!prepared.canvas) throw new TransferError('publish_conflict', '缺少画布素材发布元数据。');
    const canvasId = upload.targetResourceId;
    if (!db.prepare('SELECT id FROM creative_canvases WHERE id = ?').get(canvasId)) {
      throw new TransferError('upload_not_found', '上传目标画布不存在。');
    }
    const file = db.prepare('SELECT sha256, byteSize FROM team_files WHERE id = ?').get(upload.fileId) as {
      sha256: string; byteSize: number;
    };
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const relativePath = path.relative(path.join(dataRoot(), 'storage'), prepared.absolutePath).split(path.sep).join('/');
    db.prepare(`INSERT INTO creative_canvas_assets (
      id, canvasId, mediaKind, relativePath, contentHash, mimeType, byteSize,
      width, height, durationSec, sourceTaskId, ready, createdAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?)`).run(
      id, canvasId, prepared.canvas.mediaKind, relativePath, file.sha256, prepared.canvas.mimeType, file.byteSize,
      prepared.canvas.width, prepared.canvas.height, prepared.canvas.durationSec, createdAt,
    );
    registerInheritedScope(db, {
      resourceType: 'canvas_asset', resourceId: id,
      parent: { resourceType: 'canvas', resourceId: canvasId },
    });
    return {
      resourceType: 'canvas_asset', resourceId: id,
      references: [{ resourceType: 'canvas_asset', resourceId: id, role: 'input' }],
    };
  }
  throw new TransferError('invalid_input', '该上传业务目标尚未实现发布适配。');
}
