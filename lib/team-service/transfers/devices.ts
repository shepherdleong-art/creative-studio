import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { AccessActor } from '../../media-core/access-context.ts';
import { isAutomaticDeliverySuppressed } from '../lifecycle/index.ts';
import { teamFileEtag, type TeamFileRecord } from '../files/index.ts';
import { TransferError } from './errors.ts';
import { displayNameFromRelativePath } from './names.ts';
import type { TeamFileManifest } from './uploads.ts';

interface TeamDeviceRow {
  id: string;
  userId: string;
  deploymentId: string;
  clientDeviceId: string;
  displayName: string;
  platform: string;
  subscriptionCursor: number;
  createdAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
}

interface ReceiptRow {
  userId: string;
  deviceId: string;
  fileId: string;
  artifactVersion: number;
  state: 'pending' | 'downloading' | 'completed' | 'failed' | 'suppressed';
  etag: string | null;
  verifiedSha256: string | null;
  failureCode: string | null;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

function now(): string {
  return new Date().toISOString();
}

function safeDeviceText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function ownedDevice(db: Database.Database, actor: AccessActor, deviceId: string): TeamDeviceRow {
  const device = db.prepare('SELECT * FROM team_devices WHERE id = ?').get(deviceId) as TeamDeviceRow | undefined;
  if (!device || device.userId !== actor.userId || device.revokedAt) {
    throw new TransferError('device_not_found', '设备不存在或不可用。');
  }
  return device;
}

export function registerTeamDevice(
  db: Database.Database,
  actor: AccessActor,
  input: { deploymentId: string; clientDeviceId: string; displayName: string; platform: string },
): TeamDeviceRow {
  if (!safeDeviceText(input.deploymentId, 200) || !safeDeviceText(input.clientDeviceId, 200)
    || !safeDeviceText(input.displayName, 200) || !safeDeviceText(input.platform, 100)) {
    throw new TransferError('invalid_input', '设备标识、名称或平台无效。');
  }
  const user = db.prepare('SELECT status FROM team_users WHERE id = ?').get(actor.userId) as { status: string } | undefined;
  if (user?.status !== 'active') throw new TransferError('device_not_found', '设备不存在或不可用。');
  const at = now();
  const existing = db.prepare(`SELECT * FROM team_devices
    WHERE deploymentId = ? AND userId = ? AND clientDeviceId = ?`).get(
    input.deploymentId, actor.userId, input.clientDeviceId,
  ) as TeamDeviceRow | undefined;
  if (existing) {
    if (existing.revokedAt) throw new TransferError('device_not_found', '设备已撤销。');
    db.prepare('UPDATE team_devices SET displayName = ?, platform = ?, lastSeenAt = ? WHERE id = ?')
      .run(input.displayName, input.platform, at, existing.id);
    return ownedDevice(db, actor, existing.id);
  }
  const id = randomUUID();
  const cursor = (db.prepare('SELECT MAX(readySeq) FROM team_files').pluck().get() as number | null) ?? 0;
  db.prepare(`INSERT INTO team_devices (
    id, userId, deploymentId, clientDeviceId, displayName, platform, subscriptionCursor, createdAt, lastSeenAt
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, actor.userId, input.deploymentId, input.clientDeviceId, input.displayName,
    input.platform, cursor, at, at,
  );
  return ownedDevice(db, actor, id);
}

export function listTeamDevices(db: Database.Database, actor: AccessActor): TeamDeviceRow[] {
  return db.prepare('SELECT * FROM team_devices WHERE userId = ? AND revokedAt IS NULL ORDER BY createdAt, id')
    .all(actor.userId) as TeamDeviceRow[];
}

function manifest(file: TeamFileRecord): TeamFileManifest {
  return {
    fileId: file.id,
    seriesId: file.seriesId,
    version: file.version,
    size: file.byteSize,
    sha256: file.sha256,
    etag: teamFileEtag(file),
    displayName: displayNameFromRelativePath(file.relativePath.split(path.sep).join('/')),
  };
}

function deliveryReference(db: Database.Database, fileId: string): {
  resourceType: string;
  resourceId: string;
  rootType: string;
  rootId: string;
  deletedAt: string | null;
} | undefined {
  return db.prepare(`SELECT r.resourceType, r.resourceId, s.rootType, s.rootId, s.deletedAt
    FROM team_file_references r
    JOIN team_resource_scopes s ON s.resourceType = r.resourceType AND s.resourceId = r.resourceId
    WHERE r.fileId = ? AND r.role = 'delivery' AND r.releasedAt IS NULL
    ORDER BY r.createdAt, r.resourceType, r.resourceId LIMIT 1`).get(fileId) as
    | { resourceType: string; resourceId: string; rootType: string; rootId: string; deletedAt: string | null }
    | undefined;
}

function deliverySuppressed(db: Database.Database, reference: ReturnType<typeof deliveryReference>): boolean {
  if (!reference || reference.deletedAt) return true;
  return reference.rootType === 'project' && isAutomaticDeliverySuppressed(db, reference.rootId);
}

export function listTeamDownloads(
  db: Database.Database,
  actor: AccessActor,
  input: { deviceId: string; after?: number; limit?: number },
): {
  items: Array<{
    manifest: TeamFileManifest;
    readySeq: number;
    sourceResource: { resourceType: string; resourceId: string };
    deliveryState: ReceiptRow['state'];
  }>;
  nextCursor: number;
} {
  const device = ownedDevice(db, actor, input.deviceId);
  const requestedAfter = input.after ?? device.subscriptionCursor;
  if (!Number.isSafeInteger(requestedAfter) || requestedAfter < 0
    || (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 200))) {
    throw new TransferError('invalid_input', '下载游标或分页大小无效。');
  }
  const after = Math.max(device.subscriptionCursor, requestedAfter);
  const limit = input.limit ?? 50;
  const files = db.prepare(`SELECT f.* FROM team_files f
    WHERE f.state = 'ready' AND f.ownerUserId = ? AND f.readySeq > ?
      AND EXISTS (SELECT 1 FROM team_file_references r
        WHERE r.fileId = f.id AND r.role = 'delivery' AND r.releasedAt IS NULL)
      AND NOT EXISTS (SELECT 1 FROM team_download_receipts d
        WHERE d.fileId = f.id AND d.deviceId = ? AND d.userId = ? AND d.state IN ('completed', 'suppressed'))
    ORDER BY f.readySeq LIMIT ?`).all(actor.userId, after, device.id, actor.userId, limit) as TeamFileRecord[];
  const items = files.map((file) => {
    const reference = deliveryReference(db, file.id)!;
    const receipt = db.prepare('SELECT state FROM team_download_receipts WHERE userId = ? AND deviceId = ? AND fileId = ?')
      .get(actor.userId, device.id, file.id) as { state: ReceiptRow['state'] } | undefined;
    const suppressed = deliverySuppressed(db, reference);
    return {
      manifest: manifest(file),
      readySeq: file.readySeq!,
      sourceResource: { resourceType: reference.resourceType, resourceId: reference.resourceId },
      deliveryState: suppressed ? 'suppressed' as const : receipt?.state ?? 'pending' as const,
    };
  });
  db.prepare('UPDATE team_devices SET lastSeenAt = ? WHERE id = ?').run(now(), device.id);
  return { items, nextCursor: items.at(-1)?.readySeq ?? after };
}

function deliverableFile(db: Database.Database, actor: AccessActor, deviceId: string, fileId: string): TeamFileRecord {
  ownedDevice(db, actor, deviceId);
  const file = db.prepare("SELECT * FROM team_files WHERE id = ? AND state = 'ready' AND ownerUserId = ?")
    .get(fileId, actor.userId) as TeamFileRecord | undefined;
  if (!file || !deliveryReference(db, fileId)) throw new TransferError('download_not_found', '交付文件不存在或不可用。');
  return file;
}

export function recordTeamDownloadReceipt(
  db: Database.Database,
  actor: AccessActor,
  input: {
    deviceId: string;
    fileId: string;
    artifactVersion: number;
    state: ReceiptRow['state'];
    etag?: string;
    verifiedSha256?: string;
    failureCode?: string;
  },
): ReceiptRow {
  if (!safeDeviceText(input.deviceId, 200) || !safeDeviceText(input.fileId, 200)
    || !['pending', 'downloading', 'completed', 'failed', 'suppressed'].includes(input.state)) {
    throw new TransferError('invalid_input', '下载回执设备、文件或状态无效。');
  }
  const file = deliverableFile(db, actor, input.deviceId, input.fileId);
  if (!Number.isSafeInteger(input.artifactVersion) || input.artifactVersion !== file.version) {
    throw new TransferError('receipt_conflict', '回执版本与不可变文件版本不一致。');
  }
  const reference = deliveryReference(db, file.id);
  const suppressed = deliverySuppressed(db, reference);
  if (input.state === 'completed' && (suppressed || input.etag !== teamFileEtag(file) || input.verifiedSha256 !== file.sha256)) {
    throw new TransferError('receipt_conflict', '完成回执必须匹配已落盘校验的版本、ETag 与 SHA-256。');
  }
  if (input.state === 'suppressed' && !suppressed) {
    throw new TransferError('receipt_conflict', '只有被删除资源抑制的交付才能登记 suppressed。');
  }
  if (input.state === 'failed' && !safeDeviceText(input.failureCode, 100)) {
    throw new TransferError('invalid_input', '失败回执需要稳定 failureCode。');
  }
  const at = now();
  return db.transaction(() => {
    const existing = db.prepare('SELECT * FROM team_download_receipts WHERE userId = ? AND deviceId = ? AND fileId = ?')
      .get(actor.userId, input.deviceId, file.id) as ReceiptRow | undefined;
    if (existing?.state === 'completed') {
      if (input.state === 'completed' && existing.artifactVersion === input.artifactVersion
        && existing.etag === input.etag && existing.verifiedSha256 === input.verifiedSha256) return existing;
      throw new TransferError('receipt_conflict', '已完成回执不能被覆盖或回退。');
    }
    if (existing?.state === 'suppressed' && input.state === 'suppressed') return existing;
    const attemptCount = (existing?.attemptCount ?? 0) + 1;
    db.prepare(`INSERT INTO team_download_receipts (
      userId, deviceId, fileId, artifactVersion, state, etag, verifiedSha256, failureCode,
      attemptCount, createdAt, updatedAt, completedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(userId, deviceId, fileId) DO UPDATE SET
      artifactVersion = excluded.artifactVersion, state = excluded.state, etag = excluded.etag,
      verifiedSha256 = excluded.verifiedSha256, failureCode = excluded.failureCode,
      attemptCount = excluded.attemptCount, updatedAt = excluded.updatedAt, completedAt = excluded.completedAt`).run(
      actor.userId, input.deviceId, file.id, input.artifactVersion, input.state,
      input.etag ?? null, input.verifiedSha256 ?? null, input.failureCode ?? null,
      attemptCount, existing?.createdAt ?? at, at, input.state === 'completed' ? at : null,
    );
    return db.prepare('SELECT * FROM team_download_receipts WHERE userId = ? AND deviceId = ? AND fileId = ?')
      .get(actor.userId, input.deviceId, file.id) as ReceiptRow;
  }).immediate();
}
