import { canvasVideoMetadataForAsset, type CanvasVideoMetadata } from './video-metadata.ts';
/**
 * 画布导出（技术约定 C8）。
 *
 * - 导出在服务端事务里固定「选中节点 → 当时的 currentAssetId」，形成 manifest；
 *   打包期间节点产出新结果不影响已经开始的这份导出。
 * - 先预检文件可读性，再生成完整临时 ZIP，最后才把状态置为 ready 并交付下载。
 * - 文件名清洗并解决重名；路径从受控资产身份解析；ZIP 不含未选中的输入、历史产物、
 *   密钥或签名 URL；导出不占生成名额、不调用模型。
 */

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { ZipArchive } from 'archiver';
import type Database from 'better-sqlite3';
import { CanvasError } from './errors.ts';
import { canvasAssetAbsolutePath, getCanvasAsset } from './assets.ts';
import { getCanvasNodeState, requireCanvas } from './repository.ts';
import { findGraphNode } from './graph.ts';

export interface CanvasExportManifestItem {
  videoMetadata?: CanvasVideoMetadata;
  outputProbe?: { width: number | null; height: number | null; durationSec: number | null; videoCodec: string | null; pixelFormat: string | null };
  nodeId: string;
  nodeTitle: string;
  assetId: string;
  mediaKind: 'image' | 'video' | 'audio';
  filename: string;
  byteSize: number;
  sha256: string;
}

export interface CanvasExportSkip {
  nodeId: string;
  nodeTitle: string;
  reason: 'no_result' | 'not_exportable' | 'node_deleted';
}

export interface CanvasExportManifest {
  version: 1;
  canvasId: string;
  canvasName: string;
  graphRevision: number;
  createdAt: string;
  items: CanvasExportManifestItem[];
  skipped: CanvasExportSkip[];
}

export interface CanvasExportRecord {
  id: string;
  canvasId: string;
  manifest: CanvasExportManifest;
  status: 'pending' | 'ready' | 'failed';
  zipRelativePath: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/mp4': 'm4a',
};

/** 清洗文件名：去掉路径分隔符与控制字符，保留可读的中文与扩展名。 */
export function sanitizeCanvasExportFilename(input: string): string {
  const base = input
    .replace(/[\\/]/g, '_')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/^\.+/, '')
    .trim();
  const safe = base.length > 0 ? base : 'result';
  return safe.slice(0, 120);
}

/** 解决重名：追加 -2、-3 … 直到唯一，保留扩展名。 */
export function uniqueCanvasExportFilename(desired: string, used: Set<string>): string {
  if (!used.has(desired)) {
    used.add(desired);
    return desired;
  }
  const extension = path.extname(desired);
  const stem = path.basename(desired, extension);
  let index = 2;
  for (;;) {
    const candidate = `${stem}-${index}${extension}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
    index += 1;
  }
}

function extensionFor(mimeType: string, mediaKind: string): string {
  return EXTENSION_BY_MIME[mimeType] ?? (mediaKind === 'video' ? 'mp4' : mediaKind === 'audio' ? 'mp3' : 'png');
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

export interface CreateCanvasExportParams {
  db: Database.Database;
  canvasId: string;
  storageRoot: string;
  nodeIds: ReadonlyArray<string>;
  now?: () => Date;
}

/**
 * 固定 manifest 并生成 ZIP。任何一项缺失都会明确报出，不会静默少文件后报告成功。
 */
export async function createCanvasExport(params: CreateCanvasExportParams): Promise<CanvasExportRecord> {
  const { db, canvasId, storageRoot, nodeIds } = params;
  const now = params.now ?? (() => new Date());
  const canvas = requireCanvas(db, canvasId);
  if (nodeIds.length === 0) {
    throw new CanvasError('invalid_input', '请先选中要打包的结果节点。');
  }

  const items: CanvasExportManifestItem[] = [];
  const skipped: CanvasExportSkip[] = [];
  const usedNames = new Set<string>();

  for (const nodeId of nodeIds) {
    const graphNode = findGraphNode(canvas.graph, nodeId);
    const state = getCanvasNodeState(db, canvasId, nodeId);
    const nodeTitle = graphNode
      ? graphNode.kind === 'material' || graphNode.kind === 'prompt'
        ? graphNode.data.title
        : graphNode.data.title
      : nodeId;
    if (!graphNode || state?.deleted) {
      skipped.push({ nodeId, nodeTitle, reason: 'node_deleted' });
      continue;
    }
    if (graphNode.kind === 'material' || graphNode.kind === 'prompt') {
      skipped.push({ nodeId, nodeTitle, reason: 'not_exportable' });
      continue;
    }
    const assetId = state?.currentAssetId ?? null;
    if (!assetId) {
      skipped.push({ nodeId, nodeTitle, reason: 'no_result' });
      continue;
    }
    const asset = getCanvasAsset(db, assetId);
    if (!asset) {
      throw new CanvasError('conflict', `节点「${nodeTitle}」的当前结果文件已不存在。`, { nodeId, assetId });
    }
    const absolutePath = canvasAssetAbsolutePath(asset, storageRoot);
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
      throw new CanvasError('conflict', `节点「${nodeTitle}」的当前结果文件缺失，导出未生成。`, { nodeId, assetId });
    }
    const extension = extensionFor(asset.mimeType, asset.mediaKind);
    const desired = sanitizeCanvasExportFilename(`${nodeTitle}.${extension}`);
    items.push({
      nodeId,
      nodeTitle,
      assetId,
      mediaKind: asset.mediaKind,
      filename: uniqueCanvasExportFilename(desired, usedNames),
      byteSize: fs.statSync(absolutePath).size,
      sha256: await sha256File(absolutePath),
      ...(asset.mediaKind === 'video' ? { videoMetadata: canvasVideoMetadataForAsset(db, assetId) ?? undefined, outputProbe: { width: asset.width, height: asset.height, durationSec: asset.durationSec, videoCodec: asset.videoCodec ?? null, pixelFormat: asset.pixelFormat ?? null } } : {}),
    });
  }

  if (items.length === 0) {
    throw new CanvasError('invalid_input', '选中的节点里没有可导出的当前结果。', { skipped });
  }

  const exportId = randomUUID();
  const createdAt = now().toISOString();
  const manifest: CanvasExportManifest = {
    version: 1,
    canvasId,
    canvasName: canvas.name,
    graphRevision: canvas.graphRevision,
    createdAt,
    items,
    skipped,
  };

  db.prepare(`
    INSERT INTO creative_canvas_exports (id, canvasId, manifestJson, status, zipRelativePath, errorCode, errorMessage, createdAt, updatedAt)
    VALUES (?, ?, ?, 'pending', NULL, NULL, NULL, ?, ?)
  `).run(exportId, canvasId, JSON.stringify(manifest), createdAt, createdAt);

  const relativeZipPath = path.posix.join('canvas', canvasId, 'exports', `${exportId}.zip`);
  const absoluteZipPath = path.join(storageRoot, relativeZipPath);
  try {
    await fsPromises.mkdir(path.dirname(absoluteZipPath), { recursive: true });
    await writeZip(absoluteZipPath, items, (assetId) => {
      const asset = getCanvasAsset(db, assetId);
      if (!asset) throw new Error(`资产不存在：${assetId}`);
      return canvasAssetAbsolutePath(asset, storageRoot);
    });
    const at = now().toISOString();
    db.prepare(
      `UPDATE creative_canvas_exports SET status = 'ready', zipRelativePath = ?, updatedAt = ? WHERE id = ?`,
    ).run(relativeZipPath, at, exportId);
  } catch (error) {
    const at = now().toISOString();
    db.prepare(
      `UPDATE creative_canvas_exports SET status = 'failed', errorCode = 'zip_failed', errorMessage = ?, updatedAt = ? WHERE id = ?`,
    ).run(error instanceof Error ? error.message : String(error), at, exportId);
    throw new CanvasError('conflict', `导出打包失败：${error instanceof Error ? error.message : String(error)}`, {
      exportId,
    });
  }

  return requireCanvasExport(db, exportId);
}

async function writeZip(
  absoluteZipPath: string,
  items: ReadonlyArray<CanvasExportManifestItem>,
  resolvePath: (assetId: string) => string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(absoluteZipPath);
    // 与 lib/zip-download.ts 使用同一入口（仓库依赖的 archiver 只导出 ZipArchive）
    const archive = new ZipArchive({ zlib: { level: 9 } });
    output.on('close', () => resolve());
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    for (const item of items) {
      archive.file(resolvePath(item.assetId), { name: item.filename });
    }
    archive.append(`${JSON.stringify({
      version: 1,
      createdAt: new Date().toISOString(),
      items: items.map(({ filename, nodeId, nodeTitle, mediaKind, byteSize, sha256 }) => ({
        filename, nodeId, nodeTitle, mediaKind, byteSize, sha256,
      })),
    }, null, 2)}\n`, { name: 'manifest.json' });
    void archive.finalize();
  });
}

export function requireCanvasExport(db: Database.Database, exportId: string): CanvasExportRecord {
  const row = db.prepare(`SELECT * FROM creative_canvas_exports WHERE id = ?`).get(exportId) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw new CanvasError('not_found', '导出不存在。');
  return {
    id: String(row.id),
    canvasId: String(row.canvasId),
    manifest: JSON.parse(String(row.manifestJson)) as CanvasExportManifest,
    status: row.status as CanvasExportRecord['status'],
    zipRelativePath: row.zipRelativePath === null || row.zipRelativePath === undefined
      ? null
      : String(row.zipRelativePath),
    errorCode: row.errorCode === null || row.errorCode === undefined ? null : String(row.errorCode),
    errorMessage: row.errorMessage === null || row.errorMessage === undefined ? null : String(row.errorMessage),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

export function canvasExportAbsolutePath(record: CanvasExportRecord, storageRoot: string): string {
  if (!record.zipRelativePath) {
    throw new CanvasError('conflict', '导出还没有完成。');
  }
  return path.join(storageRoot, record.zipRelativePath);
}
