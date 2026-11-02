import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type Database from 'better-sqlite3';
import { runWithAccessContext, type AccessActor } from '../../media-core/access-context.ts';
import { assertNoStorageSymlink, resolveStoragePath } from '../../media-core/storage-path.ts';
import { createTeamAccessContext, requireResourceAccess } from '../resource-scopes.ts';
import { teamFileEtag, type TeamFileRecord } from '../files/index.ts';
import { TransferError, transferError } from './errors.ts';
import type { TeamTransferSpace } from './space.ts';
import { displayNameFromRelativePath, normalizeRelativeName } from './names.ts';
import {
  expectedTeamUploadScope,
  expectedTeamUploadUsage,
  normalizeTeamUploadTargetKind,
  prepareBusinessPublication,
  publishBusinessEntity,
  type PreparedBusinessPublication,
  type TeamUploadTargetKind,
} from './business-publication.ts';

export const DEFAULT_TEAM_UPLOAD_PART_SIZE = 8 * 1024 * 1024;
const MIN_PART_SIZE = 64 * 1024;
const MAX_PART_SIZE = 64 * 1024 * 1024;
const MAX_PART_COUNT = 10_000;
const MAX_UPLOAD_SIZE = 1024 * 1024 * 1024 * 1024;
const USAGES = new Set([
  'input', 'output', 'export', 'delivery', 'image', 'video', 'audio', 'canvas_asset',
  'batch_asset', 'detail_page', 'document', 'font', 'lut', 'archive',
]);

export type TeamUploadState = 'receiving' | 'validating' | 'staged' | 'ready' | 'cancelled' | 'failed';
export type ByteBody = AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>;

interface TeamUploadRow {
  id: string;
  userId: string;
  deviceId: string | null;
  targetKind: TeamUploadTargetKind | null;
  targetResourceType: string;
  targetResourceId: string;
  usage: string;
  relativeName: string;
  mimeType: string;
  expectedSize: number;
  expectedSha256: string;
  sourceFingerprint: string;
  partSize: number;
  idempotencyKey: string;
  state: TeamUploadState;
  fileId: string;
  resultResourceType: string | null;
  resultResourceId: string | null;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface TeamUploadView {
  id: string;
  state: TeamUploadState;
  targetKind: TeamUploadTargetKind | null;
  fileId: string;
  relativeName: string;
  mimeType: string;
  expectedSize: number;
  expectedSha256: string;
  sourceFingerprint: string;
  partSize: number;
  idempotencyKey: string;
  missingParts: number[];
  receivedParts: Array<{ partNumber: number; byteSize: number; sha256: string }>;
  errorCode: string | null;
  resultResourceType: string | null;
  resultResourceId: string | null;
}

export interface TeamFileManifest {
  fileId: string;
  seriesId: string;
  version: number;
  size: number;
  sha256: string;
  etag: string;
  displayName: string;
}

export interface CreateTeamUploadInput {
  storageRoot: string;
  target?: { resourceType: string; resourceId: string };
  targetKind?: string;
  targetScope?: { resourceType: string; resourceId: string };
  deviceId?: string;
  relativeName: string;
  mimeType: string;
  usage: string;
  expectedSize: number;
  expectedSha256: string;
  sourceFingerprint: string;
  idempotencyKey: string;
  partSize?: number;
}

export interface TeamUploadPartResult {
  uploadId: string;
  partNumber: number;
  byteSize: number;
  sha256: string;
  replayed: boolean;
}

type SpaceProbe = (requiredBytes: number) => void | Promise<void>;

const completionLocks = new Map<string, Promise<unknown>>();

function now(): string {
  return new Date().toISOString();
}

function readUpload(db: Database.Database, uploadId: string): TeamUploadRow | undefined {
  return db.prepare('SELECT * FROM team_uploads WHERE id = ?').get(uploadId) as TeamUploadRow | undefined;
}

function ownedUpload(db: Database.Database, actor: AccessActor, uploadId: string): TeamUploadRow {
  const upload = readUpload(db, uploadId);
  if (!upload || upload.userId !== actor.userId) {
    throw new TransferError('upload_not_found', '上传不存在或不可用。');
  }
  return upload;
}

function assertActiveUser(db: Database.Database, actor: AccessActor): void {
  const user = db.prepare('SELECT status FROM team_users WHERE id = ?').get(actor.userId) as { status: string } | undefined;
  if (user?.status !== 'active') throw new TransferError('upload_not_found', '上传不存在或不可用。');
}

function partCount(upload: Pick<TeamUploadRow, 'expectedSize' | 'partSize'>): number {
  return Math.ceil(upload.expectedSize / upload.partSize);
}

function expectedPartSize(upload: TeamUploadRow, partNumber: number): number {
  if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > partCount(upload)) {
    throw new TransferError('invalid_part', '分片编号超出固定范围。');
  }
  return partNumber < partCount(upload) ? upload.partSize : upload.expectedSize - upload.partSize * (partCount(upload) - 1);
}

function stagingRelative(uploadId: string): string {
  return `team-staging/${uploadId}`;
}

function stagingRoot(storageRoot: string, uploadId: string): string {
  return assertNoStorageSymlink(storageRoot, stagingRelative(uploadId));
}

function partPath(storageRoot: string, uploadId: string, partNumber: number): string {
  return assertNoStorageSymlink(storageRoot, `${stagingRelative(uploadId)}/parts/${partNumber}.part`);
}

function assembledPath(storageRoot: string, uploadId: string): string {
  return assertNoStorageSymlink(storageRoot, `${stagingRelative(uploadId)}/assembled.bin`);
}

function finalRelativePath(upload: TeamUploadRow): string {
  return `team-files/${upload.fileId}/v1/${displayNameFromRelativePath(upload.relativeName)}`;
}

function finalPath(storageRoot: string, upload: TeamUploadRow): string {
  return assertNoStorageSymlink(storageRoot, finalRelativePath(upload));
}

function hashFileSync(filePath: string): string {
  const hash = createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (count <= 0) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function quarantine(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const target = `${filePath}.quarantine-${randomUUID()}`;
  try { fs.renameSync(filePath, target); } catch { /* 下一次写入仍会按冲突失败关闭 */ }
}

function reconcileParts(db: Database.Database, upload: TeamUploadRow, storageRoot: string): void {
  const readPart = db.prepare('SELECT * FROM team_upload_parts WHERE uploadId = ? AND partNumber = ?');
  const removePart = db.prepare('DELETE FROM team_upload_parts WHERE uploadId = ? AND partNumber = ?');
  const insertPart = db.prepare(`
    INSERT INTO team_upload_parts (uploadId, partNumber, byteSize, sha256, state, createdAt)
    VALUES (?, ?, ?, ?, 'ready', ?)
  `);
  for (let number = 1; number <= partCount(upload); number += 1) {
    const expectedSize = expectedPartSize(upload, number);
    const filePath = partPath(storageRoot, upload.id, number);
    const recorded = readPart.get(upload.id, number) as { byteSize: number; sha256: string } | undefined;
    if (!fs.existsSync(filePath)) {
      if (recorded) removePart.run(upload.id, number);
      continue;
    }
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size !== expectedSize) {
      if (recorded) removePart.run(upload.id, number);
      quarantine(filePath);
      continue;
    }
    const digest = hashFileSync(filePath);
    if (recorded && recorded.sha256 !== digest) {
      removePart.run(upload.id, number);
      quarantine(filePath);
      continue;
    }
    if (!recorded) insertPart.run(upload.id, number, stat.size, digest, now());
  }
}

function uploadView(db: Database.Database, upload: TeamUploadRow, storageRoot: string): TeamUploadView {
  if (upload.state !== 'ready' && upload.state !== 'cancelled') reconcileParts(db, upload, storageRoot);
  const received = db.prepare(`
    SELECT partNumber, byteSize, sha256 FROM team_upload_parts WHERE uploadId = ? ORDER BY partNumber
  `).all(upload.id) as Array<{ partNumber: number; byteSize: number; sha256: string }>;
  const receivedNumbers = new Set(received.map((part) => part.partNumber));
  const missingParts = Array.from({ length: partCount(upload) }, (_, index) => index + 1)
    .filter((number) => !receivedNumbers.has(number));
  return {
    id: upload.id,
    state: upload.state,
    targetKind: upload.targetKind,
    fileId: upload.fileId,
    relativeName: upload.relativeName,
    mimeType: upload.mimeType,
    expectedSize: upload.expectedSize,
    expectedSha256: upload.expectedSha256,
    sourceFingerprint: upload.sourceFingerprint,
    partSize: upload.partSize,
    idempotencyKey: upload.idempotencyKey,
    missingParts,
    receivedParts: received,
    errorCode: upload.errorCode,
    resultResourceType: upload.resultResourceType,
    resultResourceId: upload.resultResourceId,
  };
}

function sameUploadInput(
  upload: TeamUploadRow,
  input: CreateTeamUploadInput,
  target: { resourceType: string; resourceId: string },
  targetKind: TeamUploadTargetKind | null,
  relativeName: string,
  partSize: number,
): boolean {
  return upload.targetResourceType === target.resourceType
    && upload.targetResourceId === target.resourceId
    && upload.targetKind === targetKind
    && upload.relativeName === relativeName
    && upload.mimeType === input.mimeType
    && upload.usage === input.usage
    && upload.expectedSize === input.expectedSize
    && upload.expectedSha256 === input.expectedSha256
    && upload.sourceFingerprint === input.sourceFingerprint
    && upload.partSize === partSize;
}

export function createTeamUpload(
  db: Database.Database,
  actor: AccessActor,
  input: CreateTeamUploadInput,
): TeamUploadView {
  assertActiveUser(db, actor);
  const target = input.targetScope ?? input.target;
  if (!target || typeof target.resourceType !== 'string' || !target.resourceType.trim()
    || typeof target.resourceId !== 'string' || !target.resourceId.trim()) {
    throw new TransferError('invalid_input', '上传目标资源无效。');
  }
  const targetKind = normalizeTeamUploadTargetKind(input.targetKind);
  if (targetKind && (target.resourceType !== expectedTeamUploadScope(targetKind)
    || input.usage !== expectedTeamUploadUsage(targetKind))) {
    throw new TransferError('invalid_input', '上传业务类型、目标范围与用途不匹配。');
  }
  requireResourceAccess(db, actor, target.resourceType, target.resourceId, 'write');
  const relativeName = normalizeRelativeName(input.relativeName);
  const partSize = input.partSize ?? DEFAULT_TEAM_UPLOAD_PART_SIZE;
  if (!Number.isSafeInteger(input.expectedSize) || input.expectedSize <= 0 || input.expectedSize > MAX_UPLOAD_SIZE
    || !/^[a-f0-9]{64}$/.test(input.expectedSha256)
    || !Number.isSafeInteger(partSize) || partSize < MIN_PART_SIZE || partSize > MAX_PART_SIZE
    || Math.ceil(input.expectedSize / partSize) > MAX_PART_COUNT
    || typeof input.sourceFingerprint !== 'string' || !input.sourceFingerprint.trim()
    || typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim() || input.idempotencyKey.length > 256
    || typeof input.mimeType !== 'string' || !input.mimeType.trim() || !USAGES.has(input.usage)) {
    throw new TransferError('invalid_input', '上传大小、哈希、分片或用途参数无效。');
  }
  if (input.deviceId) {
    const device = db.prepare('SELECT userId, revokedAt FROM team_devices WHERE id = ?').get(input.deviceId) as
      | { userId: string; revokedAt: string | null } | undefined;
    if (!device || device.userId !== actor.userId || device.revokedAt) {
      throw new TransferError('device_not_found', '设备不存在或不可用。');
    }
  }
  const existing = db.prepare('SELECT * FROM team_uploads WHERE userId = ? AND idempotencyKey = ?')
    .get(actor.userId, input.idempotencyKey) as TeamUploadRow | undefined;
  if (existing) {
    if (!sameUploadInput(existing, input, target, targetKind, relativeName, partSize)) {
      throw new TransferError('idempotency_conflict', '幂等键已用于不同的上传内容或目标。');
    }
    return uploadView(db, existing, input.storageRoot);
  }
  const id = randomUUID();
  const fileId = randomUUID();
  const at = now();
  try {
    db.prepare(`
      INSERT INTO team_uploads (
        id, userId, deviceId, targetKind, targetResourceType, targetResourceId, usage, relativeName, mimeType,
        expectedSize, expectedSha256, sourceFingerprint, partSize, idempotencyKey, state, fileId,
        createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'receiving', ?, ?, ?)
    `).run(
      id, actor.userId, input.deviceId ?? null, targetKind, target.resourceType, target.resourceId,
      input.usage, relativeName, input.mimeType, input.expectedSize, input.expectedSha256,
      input.sourceFingerprint, partSize, input.idempotencyKey, fileId, at, at,
    );
  } catch (error) {
    if ((error as { code?: string }).code?.startsWith('SQLITE_CONSTRAINT')) {
      throw new TransferError('idempotency_conflict', '幂等键冲突，请读取原上传后重试。');
    }
    throw error;
  }
  return uploadView(db, ownedUpload(db, actor, id), input.storageRoot);
}

export function getTeamUpload(
  db: Database.Database,
  actor: AccessActor,
  input: { storageRoot: string; uploadId: string },
): TeamUploadView {
  return uploadView(db, ownedUpload(db, actor, input.uploadId), input.storageRoot);
}

function bodyIterable(body: ByteBody): AsyncIterable<Uint8Array> {
  if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) {
    return Readable.fromWeb(body as import('node:stream/web').ReadableStream<Uint8Array>);
  }
  return body as AsyncIterable<Uint8Array>;
}

async function writePartBody(
  body: ByteBody,
  targetPath: string,
  expectedSize: number,
  spaceProbe?: SpaceProbe,
  space?: TeamTransferSpace,
): Promise<{ byteSize: number; sha256: string }> {
  const reservation = space ? await space.reserve(expectedSize) : null;
  if (!space) await spaceProbe?.(expectedSize);
  const hash = createHash('sha256');
  let byteSize = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      byteSize += chunk.length;
      if (byteSize > expectedSize) {
        callback(new TransferError('part_size_mismatch', '分片真实字节超过固定范围。'));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(Readable.from(bodyIterable(body)), limiter, fs.createWriteStream(targetPath, { flags: 'wx' }));
    if (byteSize !== expectedSize) throw new TransferError('part_size_mismatch', '分片真实字节与固定范围不一致。');
    return { byteSize, sha256: hash.digest('hex') };
  } finally {
    await reservation?.release();
  }
}

function saveUploadError(db: Database.Database, uploadId: string, code: string, failed: boolean): void {
  db.prepare(`UPDATE team_uploads SET state = CASE WHEN ? THEN 'failed' ELSE state END,
    errorCode = ?, updatedAt = ? WHERE id = ? AND state <> 'ready'`).run(failed ? 1 : 0, code, now(), uploadId);
}

export async function putTeamUploadPart(
  db: Database.Database,
  actor: AccessActor,
  input: {
    storageRoot: string;
    uploadId: string;
    partNumber: number;
    body: ByteBody;
    spaceProbe?: SpaceProbe;
    space?: TeamTransferSpace;
  },
): Promise<TeamUploadPartResult> {
  const upload = ownedUpload(db, actor, input.uploadId);
  if (upload.state === 'cancelled') throw new TransferError('upload_cancelled', '上传已取消。');
  if (upload.state === 'ready' || upload.state === 'validating' || upload.state === 'staged') {
    throw new TransferError('upload_validating', '上传正在校验或已发布，不能再写入分片。');
  }
  if (upload.state === 'failed' && upload.errorCode === 'source_changed') {
    throw new TransferError('source_changed', '源文件已变化，请重新创建上传。');
  }
  const expectedSize = expectedPartSize(upload, input.partNumber);
  const final = partPath(input.storageRoot, upload.id, input.partNumber);
  fs.mkdirSync(path.dirname(final), { recursive: true });
  const temporary = `${final}.${randomUUID()}.tmp`;
  let received: { byteSize: number; sha256: string };
  try {
    received = await writePartBody(input.body, temporary, expectedSize, input.spaceProbe, input.space);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    const stable = transferError(error);
    saveUploadError(db, upload.id, stable.code, false);
    throw stable;
  }

  const existing = db.prepare('SELECT byteSize, sha256 FROM team_upload_parts WHERE uploadId = ? AND partNumber = ?')
    .get(upload.id, input.partNumber) as { byteSize: number; sha256: string } | undefined;
  const onDisk = fs.existsSync(final)
    ? { byteSize: fs.statSync(final).size, sha256: hashFileSync(final) }
    : undefined;
  const previous = existing ?? onDisk;
  if (previous) {
    fs.rmSync(temporary, { force: true });
    if (previous.byteSize !== received.byteSize || previous.sha256 !== received.sha256) {
      throw new TransferError('part_conflict', '同一分片已收到不同内容。');
    }
    if (!existing) {
      db.prepare(`INSERT INTO team_upload_parts (uploadId, partNumber, byteSize, sha256, state, createdAt)
        VALUES (?, ?, ?, ?, 'ready', ?)`).run(upload.id, input.partNumber, received.byteSize, received.sha256, now());
    }
    return { uploadId: upload.id, partNumber: input.partNumber, ...received, replayed: true };
  }

  try {
    fs.linkSync(temporary, final);
    fs.unlinkSync(temporary);
    db.prepare(`INSERT INTO team_upload_parts (uploadId, partNumber, byteSize, sha256, state, createdAt)
      VALUES (?, ?, ?, ?, 'ready', ?)`).run(upload.id, input.partNumber, received.byteSize, received.sha256, now());
    db.prepare("UPDATE team_uploads SET state = 'receiving', errorCode = NULL, updatedAt = ? WHERE id = ?")
      .run(now(), upload.id);
    return { uploadId: upload.id, partNumber: input.partNumber, ...received, replayed: false };
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    const stable = transferError(error);
    saveUploadError(db, upload.id, stable.code, false);
    throw stable;
  }
}

function assertCompletionSource(upload: TeamUploadRow, input: { expectedSha256?: string; sourceFingerprint?: string }): void {
  if ((input.expectedSha256 !== undefined && input.expectedSha256 !== upload.expectedSha256)
    || (input.sourceFingerprint !== undefined && input.sourceFingerprint !== upload.sourceFingerprint)) {
    throw new TransferError('source_changed', '源文件指纹已变化，请放弃旧分片并重新上传。');
  }
}

async function assembleUpload(
  db: Database.Database,
  upload: TeamUploadRow,
  storageRoot: string,
  spaceProbe?: SpaceProbe,
  space?: TeamTransferSpace,
): Promise<{ filePath: string; sha256: string }> {
  const view = uploadView(db, upload, storageRoot);
  if (view.missingParts.length > 0) {
    db.prepare("UPDATE team_uploads SET state = 'receiving', errorCode = 'missing_parts', updatedAt = ? WHERE id = ?")
      .run(now(), upload.id);
    throw new TransferError('missing_parts', '仍缺少上传分片。', 409, { missingParts: view.missingParts });
  }
  const reservation = space ? await space.reserve(upload.expectedSize) : null;
  if (!space) await spaceProbe?.(upload.expectedSize);
  const final = assembledPath(storageRoot, upload.id);
  const temporary = `${final}.${randomUUID()}.tmp`;
  const output = fs.createWriteStream(temporary, { flags: 'wx' });
  const hash = createHash('sha256');
  let total = 0;
  try {
    for (let number = 1; number <= partCount(upload); number += 1) {
      const input = fs.createReadStream(partPath(storageRoot, upload.id, number));
      for await (const chunk of input) {
        const buffer = chunk as Buffer;
        total += buffer.length;
        if (total > upload.expectedSize) throw new TransferError('source_changed', '拼接字节超过源文件声明大小。');
        hash.update(buffer);
        if (!output.write(buffer)) await once(output, 'drain');
      }
    }
    output.end();
    await once(output, 'finish');
    const digest = hash.digest('hex');
    if (total !== upload.expectedSize || digest !== upload.expectedSha256) {
      throw new TransferError('source_changed', '完整文件大小或哈希与源文件指纹不一致。');
    }
    if (fs.existsSync(final)) {
      if (fs.statSync(final).size !== total || await hashFile(final) !== digest) {
        throw new TransferError('publish_conflict', '暂存文件与已恢复文件不一致。');
      }
      fs.unlinkSync(temporary);
    } else {
      fs.renameSync(temporary, final);
    }
    return { filePath: final, sha256: digest };
  } catch (error) {
    output.destroy();
    fs.rmSync(temporary, { force: true });
    throw error;
  } finally {
    await reservation?.release();
  }
}

function detectedMime(header: Buffer): string | null {
  if (header.length >= 8 && header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return 'image/jpeg';
  if (header.subarray(0, 6).toString('ascii') === 'GIF87a' || header.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif';
  if (header.subarray(0, 4).toString('ascii') === 'RIFF' && header.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (header.subarray(0, 4).toString('ascii') === 'RIFF' && header.subarray(8, 12).toString('ascii') === 'WAVE') return 'audio/wav';
  if (header.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = header.subarray(8, 12).toString('ascii');
    return brand === 'qt  ' ? 'video/quicktime' : 'video/mp4';
  }
  if (header[0] === 0x1a && header[1] === 0x45 && header[2] === 0xdf && header[3] === 0xa3) return 'video/webm';
  if (header.subarray(0, 3).toString('ascii') === 'ID3' || (header[0] === 0xff && (header[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (header.subarray(0, 4).toString('ascii') === 'OggS') return 'audio/ogg';
  if (header[0] === 0x50 && header[1] === 0x4b) return 'application/zip';
  if (header.subarray(0, 4).toString('ascii') === '%PDF') return 'application/pdf';
  return null;
}

function validateMediaType(filePath: string, declared: string): void {
  if (declared === 'application/octet-stream') return;
  const fd = fs.openSync(filePath, 'r');
  const header = Buffer.alloc(64);
  let count = 0;
  try { count = fs.readSync(fd, header, 0, header.length, 0); } finally { fs.closeSync(fd); }
  const actual = detectedMime(header.subarray(0, count));
  const compatible = actual === declared
    || (declared === 'video/webm' && actual === 'video/webm')
    || (declared === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' && actual === 'application/zip')
    || (declared === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' && actual === 'application/zip');
  if (!compatible) throw new TransferError('media_type_mismatch', '文件真实媒体类型与声明不一致。');
}

function insertStagedFile(db: Database.Database, upload: TeamUploadRow, storageRoot: string, digest: string): void {
  const relativePath = finalRelativePath(upload);
  const existing = db.prepare('SELECT * FROM team_files WHERE id = ?').get(upload.fileId) as TeamFileRecord | undefined;
  if (existing && (existing.relativePath !== relativePath || existing.sha256 !== digest
    || existing.byteSize !== upload.expectedSize || existing.state === 'ready')) {
    if (existing.state === 'ready') return;
    throw new TransferError('publish_conflict', '不可变文件登记与上传内容不一致。');
  }
  if (!existing) {
    const at = now();
    db.transaction(() => {
      db.prepare(`INSERT INTO team_files (
        id, seriesId, version, ownerUserId, relativePath, mimeType, byteSize, sha256, state, createdAt
      ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, 'staged', ?)`).run(
        upload.fileId, upload.fileId, upload.userId, relativePath, upload.mimeType,
        upload.expectedSize, digest, at,
      );
      db.prepare("UPDATE team_uploads SET state = 'staged', errorCode = NULL, updatedAt = ? WHERE id = ?")
        .run(at, upload.id);
    }).immediate();
  } else {
    db.prepare("UPDATE team_uploads SET state = 'staged', errorCode = NULL, updatedAt = ? WHERE id = ?")
      .run(now(), upload.id);
  }
  resolveStoragePath(storageRoot, relativePath);
}

function moveIntoManagedLocation(upload: TeamUploadRow, storageRoot: string, assembled: string, digest: string): void {
  const destination = finalPath(storageRoot, upload);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (fs.existsSync(destination)) {
    if (!fs.statSync(destination).isFile() || fs.statSync(destination).size !== upload.expectedSize
      || hashFileSync(destination) !== digest) {
      throw new TransferError('publish_conflict', '受管位置已存在不同内容，已停止发布。');
    }
    return;
  }
  fs.linkSync(assembled, destination);
}

function fileManifest(file: TeamFileRecord, relativeName: string): TeamFileManifest {
  if (file.state !== 'ready') throw new TransferError('publish_conflict', '文件尚未 ready。');
  return {
    fileId: file.id,
    seriesId: file.seriesId,
    version: file.version,
    size: file.byteSize,
    sha256: file.sha256,
    etag: teamFileEtag(file),
    displayName: displayNameFromRelativePath(relativeName),
  };
}

function publishReadyFile(
  db: Database.Database,
  upload: TeamUploadRow,
  prepared: PreparedBusinessPublication | null,
): TeamFileManifest {
  const at = now();
  db.transaction(() => {
    const currentUpload = readUpload(db, upload.id)!;
    if (currentUpload.state === 'cancelled') throw new TransferError('upload_cancelled', '上传已取消。');
    const current = db.prepare('SELECT * FROM team_files WHERE id = ?').get(upload.fileId) as TeamFileRecord | undefined;
    if (!current) throw new TransferError('publish_conflict', '缺少 staged 文件登记。');
    const published = prepared ? publishBusinessEntity(db, upload, prepared) : null;
    if (current.state !== 'ready') {
      const readySeq = ((db.prepare('SELECT MAX(readySeq) AS value FROM team_files').pluck().get() as number | null) ?? 0) + 1;
      db.prepare("UPDATE team_files SET state = 'ready', readySeq = ?, readyAt = ? WHERE id = ? AND state = 'staged'")
        .run(readySeq, at, upload.fileId);
    }
    const insertReference = db.prepare(`INSERT OR IGNORE INTO team_file_references (
      fileId, resourceType, resourceId, role, pinKind, createdAt
    ) VALUES (?, ?, ?, ?, 'entity', ?)`);
    if (published) {
      for (const reference of published.references) {
        insertReference.run(upload.fileId, reference.resourceType, reference.resourceId, reference.role, at);
      }
    } else {
      const role = ['output', 'export', 'delivery'].includes(upload.usage) ? upload.usage : 'input';
      insertReference.run(upload.fileId, upload.targetResourceType, upload.targetResourceId, role, at);
      if (['output', 'export', 'delivery'].includes(upload.usage)) {
        insertReference.run(upload.fileId, upload.targetResourceType, upload.targetResourceId, 'delivery', at);
      }
    }
    const resultResourceType = published?.resourceType ?? upload.targetResourceType;
    const resultResourceId = published?.resourceId ?? upload.targetResourceId;
    db.prepare(`UPDATE team_uploads SET state = 'ready', resultResourceType = ?, resultResourceId = ?,
      errorCode = NULL, updatedAt = ?, completedAt = ? WHERE id = ?`).run(
      resultResourceType, resultResourceId, at, at, upload.id,
    );
  }).immediate();
  const file = db.prepare('SELECT * FROM team_files WHERE id = ?').get(upload.fileId) as TeamFileRecord;
  return fileManifest(file, upload.relativeName);
}

async function performComplete(
  db: Database.Database,
  actor: AccessActor,
  input: {
    storageRoot: string;
    uploadId: string;
    expectedSha256?: string;
    sourceFingerprint?: string;
    spaceProbe?: SpaceProbe;
    space?: TeamTransferSpace;
    failAfterMoveForTest?: boolean;
  },
): Promise<TeamUploadView & { file: TeamFileManifest }> {
  let upload = ownedUpload(db, actor, input.uploadId);
  assertActiveUser(db, actor);
  if (upload.state === 'ready') {
    const file = db.prepare('SELECT * FROM team_files WHERE id = ?').get(upload.fileId) as TeamFileRecord;
    return { ...uploadView(db, upload, input.storageRoot), file: fileManifest(file, upload.relativeName) };
  }
  if (upload.state === 'cancelled') throw new TransferError('upload_cancelled', '上传已取消。');
  if (upload.state === 'failed' && upload.errorCode === 'source_changed') {
    throw new TransferError('source_changed', '源文件已变化，请重新创建上传。');
  }
  assertCompletionSource(upload, input);
  requireResourceAccess(db, actor, upload.targetResourceType, upload.targetResourceId, 'write');
  const wasStaged = upload.state === 'staged';
  db.prepare("UPDATE team_uploads SET state = 'validating', errorCode = NULL, updatedAt = ? WHERE id = ?")
    .run(now(), upload.id);
  upload = readUpload(db, upload.id)!;
  try {
    let digest: string;
    let assembled: string;
    if (wasStaged && fs.existsSync(assembledPath(input.storageRoot, upload.id))) {
      assembled = assembledPath(input.storageRoot, upload.id);
      digest = await hashFile(assembled);
      if (digest !== upload.expectedSha256 || fs.statSync(assembled).size !== upload.expectedSize) {
        throw new TransferError('source_changed', '暂存文件与源文件指纹不一致。');
      }
    } else {
      const result = await assembleUpload(db, upload, input.storageRoot, input.spaceProbe, input.space);
      assembled = result.filePath;
      digest = result.sha256;
    }
    validateMediaType(assembled, upload.mimeType);
    insertStagedFile(db, upload, input.storageRoot, digest);
    if (input.space) await input.space.probe(0);
    else await input.spaceProbe?.(upload.expectedSize);
    moveIntoManagedLocation(upload, input.storageRoot, assembled, digest);
    if (input.failAfterMoveForTest) throw new Error('injected after move');
    const prepared = await prepareBusinessPublication(upload, finalPath(input.storageRoot, upload));
    const file = publishReadyFile(db, upload, prepared);
    fs.rmSync(stagingRoot(input.storageRoot, upload.id), { recursive: true, force: true });
    const ready = readUpload(db, upload.id)!;
    return { ...uploadView(db, ready, input.storageRoot), file };
  } catch (error) {
    const stable = transferError(error);
    const failed = ['source_changed', 'media_type_mismatch'].includes(stable.code);
    saveUploadError(db, upload.id, stable.code, failed);
    if (stable.code === 'source_changed' || stable.code === 'media_type_mismatch') throw stable;
    if (input.failAfterMoveForTest && error instanceof Error && error.message === 'injected after move') throw error;
    throw stable;
  }
}

export async function completeTeamUpload(
  db: Database.Database,
  actor: AccessActor,
  input: {
    storageRoot: string;
    uploadId: string;
    expectedSha256?: string;
    sourceFingerprint?: string;
    spaceProbe?: SpaceProbe;
    space?: TeamTransferSpace;
    failAfterMoveForTest?: boolean;
  },
): Promise<TeamUploadView & { file: TeamFileManifest }> {
  ownedUpload(db, actor, input.uploadId);
  const active = completionLocks.get(input.uploadId) as Promise<TeamUploadView & { file: TeamFileManifest }> | undefined;
  if (active) return active;
  const pending = performComplete(db, actor, input);
  completionLocks.set(input.uploadId, pending);
  try {
    return await pending;
  } finally {
    if (completionLocks.get(input.uploadId) === pending) completionLocks.delete(input.uploadId);
  }
}

export function cancelTeamUpload(
  db: Database.Database,
  actor: AccessActor,
  input: { storageRoot: string; uploadId: string },
): TeamUploadView {
  const upload = ownedUpload(db, actor, input.uploadId);
  if (completionLocks.has(input.uploadId)) throw new TransferError('upload_validating', '上传正在发布，暂不能取消。');
  const file = db.prepare('SELECT * FROM team_files WHERE id = ?').get(upload.fileId) as TeamFileRecord | undefined;
  if (upload.state === 'ready' || file?.state === 'ready') {
    if (upload.state !== 'ready') {
      const at = now();
      db.prepare(`UPDATE team_uploads SET state = 'ready', resultResourceType = ?, resultResourceId = ?,
        completedAt = ?, updatedAt = ? WHERE id = ?`).run(
        upload.targetResourceType, upload.targetResourceId, at, at, upload.id,
      );
    }
    return uploadView(db, readUpload(db, upload.id)!, input.storageRoot);
  }
  if (upload.state !== 'cancelled') {
    if (file) {
      if (file.state !== 'staged' || file.relativePath !== finalRelativePath(upload)
        || db.prepare('SELECT 1 FROM team_file_references WHERE fileId = ? LIMIT 1').get(file.id)) {
        throw new TransferError('publish_conflict', '暂存文件登记不一致，已停止取消清理。');
      }
      const managed = finalPath(input.storageRoot, upload);
      if (fs.existsSync(managed)) {
        if (!fs.statSync(managed).isFile() || fs.statSync(managed).size !== file.byteSize
          || hashFileSync(managed) !== file.sha256) {
          throw new TransferError('publish_conflict', '暂存文件内容已变化，已停止取消清理。');
        }
        fs.unlinkSync(managed);
      }
    }
    fs.rmSync(stagingRoot(input.storageRoot, upload.id), { recursive: true, force: true });
    db.transaction(() => {
      if (file) db.prepare('DELETE FROM team_files WHERE id = ? AND state = \'staged\'').run(file.id);
      db.prepare("UPDATE team_uploads SET state = 'cancelled', errorCode = NULL, updatedAt = ? WHERE id = ? AND state <> 'ready'")
        .run(now(), upload.id);
    }).immediate();
  } else {
    fs.rmSync(stagingRoot(input.storageRoot, upload.id), { recursive: true, force: true });
  }
  return uploadView(db, readUpload(db, upload.id)!, input.storageRoot);
}

export async function recoverTeamUploads(
  db: Database.Database,
  options: { storageRoot: string; space?: TeamTransferSpace },
): Promise<Array<{ uploadId: string; state: TeamUploadState; errorCode?: string }>> {
  const rows = db.prepare("SELECT * FROM team_uploads WHERE state IN ('receiving', 'validating', 'staged')")
    .all() as TeamUploadRow[];
  const results: Array<{ uploadId: string; state: TeamUploadState; errorCode?: string }> = [];
  for (const row of rows) {
    const user = db.prepare('SELECT role, status FROM team_users WHERE id = ?').get(row.userId) as
      | { role: 'employee' | 'admin'; status: string } | undefined;
    if (user?.status !== 'active') {
      results.push({ uploadId: row.id, state: row.state, errorCode: 'user_unavailable' });
      continue;
    }
    const actor: AccessActor = { userId: row.userId, role: user.role };
    try {
      if (row.state === 'receiving') {
        const view = getTeamUpload(db, actor, { storageRoot: options.storageRoot, uploadId: row.id });
        results.push({ uploadId: row.id, state: view.state });
      } else {
        const completed = await runWithAccessContext(
          createTeamAccessContext({ db, principal: actor }),
          () => completeTeamUpload(db, actor, { storageRoot: options.storageRoot, uploadId: row.id, space: options.space }),
        );
        results.push({ uploadId: row.id, state: completed.state });
      }
    } catch (error) {
      const current = readUpload(db, row.id)!;
      results.push({ uploadId: row.id, state: current.state, errorCode: error instanceof TransferError ? error.code : 'recovery_failed' });
    }
  }
  return results;
}
