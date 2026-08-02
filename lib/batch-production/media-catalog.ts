import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { createAsset } from './assets.ts';

export type BatchAssetSourceKind = 'module4' | 'managed' | 'linked';
export type BatchAssetSourceHealth = 'healthy' | 'offline' | 'changed';

export interface BatchAssetSourceRow {
  id: string;
  assetId: string;
  sourceKind: BatchAssetSourceKind;
  locationJson: string;
  health: BatchAssetSourceHealth;
  createdAt: string;
}

function nowIso(now?: () => Date): string {
  return (now ?? (() => new Date()))().toISOString();
}

/** 完整内容核验：顺序读取整个文件计算 SHA-256（V1 的正确性基准）。 */
export async function computeFileSha256(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk as Buffer));
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });
  return hash.digest('hex');
}

function insertSource(
  db: Database.Database,
  assetId: string,
  sourceKind: BatchAssetSourceKind,
  location: unknown,
  createdAt: string,
): void {
  db.prepare(`
    INSERT INTO batch_asset_sources (id, assetId, sourceKind, locationJson, health, createdAt)
    VALUES (?, ?, ?, ?, 'healthy', ?)
  `).run(randomUUID(), assetId, sourceKind, JSON.stringify(location), createdAt);
}

/** 按内容指纹复用素材身份；同项目同指纹只建一份素材。 */
function resolveAssetId(
  db: Database.Database,
  projectId: string,
  fingerprint: string,
  sourceKind: BatchAssetSourceKind,
  location: unknown,
  createdAt: string,
): string {
  const assetId = createAsset(db, {
    projectId,
    sourceKind: sourceKind === 'linked' ? 'linked' : 'managed',
    locationJson: location,
    contentFingerprint: `sha256:${fingerprint}`,
    mediaKind: 'video',
    now: () => new Date(createdAt),
  });
  insertSource(db, assetId, sourceKind, location, createdAt);
  return assetId;
}

/**
 * 登记第 4 步成功视频为项目素材（模块 4 Adapter）。
 * 只引用现有产物文件，不复制、不移动、不越权删除模块 4 文件。
 */
export async function registerModule4Video(
  db: Database.Database,
  projectId: string,
  input: {
    videoJobId: string;
    shotSetId: string;
    filename?: string;
    /** 模块 4 产物文件路径（已通过调用方安全路径校验） */
    localVideoPath: string;
    now?: () => Date;
  },
): Promise<string> {
  const createdAt = nowIso(input.now);
  const fingerprint = await computeFileSha256(input.localVideoPath);
  const location = {
    videoJobId: input.videoJobId,
    shotSetId: input.shotSetId,
    filename: input.filename ?? input.videoJobId,
    relativePath: input.localVideoPath,
  };
  return db.transaction(() => resolveAssetId(db, projectId, fingerprint, 'module4', location, createdAt))();
}

/**
 * 登记用户原文件位置为链接来源（链接 Adapter）。
 * 素材身份是内容指纹；用户原文件永远只被引用，任何项目操作都不删除它。
 */
export async function registerLinkedSource(
  db: Database.Database,
  projectId: string,
  input: {
    filePath: string;
    displayName?: string;
    now?: () => Date;
  },
): Promise<string> {
  const createdAt = nowIso(input.now);
  const fingerprint = await computeFileSha256(input.filePath);
  const location = {
    absolutePath: input.filePath,
    displayName: input.displayName ?? path.basename(input.filePath),
  };
  return db.transaction(() => resolveAssetId(db, projectId, fingerprint, 'linked', location, createdAt))();
}

/**
 * 把用户选择的文件安全复制进项目数据根作为托管副本（托管 Adapter）。
 * 源文件不动；副本按内容指纹命名，同一内容只保留一份受管副本。
 */
export async function registerManagedCopy(
  db: Database.Database,
  projectId: string,
  input: {
    sourcePath: string;
    /** 项目数据根下的受控目录（来自 dataRoot()），由调用方提供 */
    managedRoot: string;
    now?: () => Date;
  },
): Promise<string> {
  const createdAt = nowIso(input.now);
  const fingerprint = await computeFileSha256(input.sourcePath);
  const extension = path.extname(input.sourcePath);
  const projectManagedRoot = path.join(input.managedRoot, projectId);
  const targetPath = path.join(projectManagedRoot, `${fingerprint.slice(0, 16)}${extension}`);
  if (!existsSync(targetPath)) {
    const { mkdir, copyFile } = await import('node:fs/promises');
    await mkdir(projectManagedRoot, { recursive: true });
    await copyFile(input.sourcePath, targetPath);
  }
  const location = { relativePath: path.join(projectId, `${fingerprint.slice(0, 16)}${extension}`) };
  return db.transaction(() => resolveAssetId(db, projectId, fingerprint, 'managed', location, createdAt))();
}

export function listAssetSources(db: Database.Database, assetId: string): Array<BatchAssetSourceRow & { locationJson: unknown }> {
  return (db.prepare(`
    SELECT * FROM batch_asset_sources WHERE assetId = ? ORDER BY createdAt, id
  `).all(assetId) as BatchAssetSourceRow[]).map((row) => ({
    ...row,
    locationJson: JSON.parse(row.locationJson),
  }));
}

/**
 * 核验素材各来源的健康状态：文件不存在标记离线；内容与登记指纹不一致
 * 标记已变化（禁止冒充旧素材）。素材身份和批次引用不受影响。
 */
export async function verifyAssetSources(db: Database.Database, assetId: string): Promise<void> {
  const rows = db.prepare(`
    SELECT * FROM batch_asset_sources WHERE assetId = ?
  `).all(assetId) as BatchAssetSourceRow[];
  for (const row of rows) {
    const location = JSON.parse(row.locationJson) as { absolutePath?: string; relativePath?: string };
    const filePath = location.absolutePath ?? location.relativePath;
    let health: BatchAssetSourceHealth;
    if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) {
      health = 'offline';
    } else {
      try {
        const fingerprint = await computeFileSha256(filePath);
        const asset = db.prepare(`SELECT contentFingerprint FROM batch_assets WHERE id = ?`).get(assetId) as
          { contentFingerprint: string } | undefined;
        health = asset && asset.contentFingerprint === `sha256:${fingerprint}` ? 'healthy' : 'changed';
      } catch {
        health = 'offline';
      }
    }
    if (health !== row.health) {
      db.prepare(`UPDATE batch_asset_sources SET health = ? WHERE id = ?`).run(health, row.id);
    }
  }
}
