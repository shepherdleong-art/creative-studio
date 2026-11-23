import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { AccessActor } from '../../media-core/access-context.ts';
import { createExecutionJournal } from '../../media-core/execution/journal.ts';
import { publishBackupDirectory } from '../../schema-upgrade/backup.ts';
import { acquireSchemaUpgradeLock, SchemaUpgradeLockTimeoutError } from '../../schema-upgrade/lock.ts';
import {
  acquireLifecycleBarrier,
  createBackupPin,
  releaseBackupPin,
  releaseLifecycleBarrier,
} from '../lifecycle/index.ts';
import { backupMediaPath, pruneDailyMedia, storeDailyMedia } from './daily-media.ts';
import { resumeDailyRetirements, retireVerifiedDaily } from './daily-retirement.ts';
import { appendMaintenanceReceipt } from './receipts.ts';
import {
  assertNoSymlinkPath,
  assertPathInside,
  assertSafeRelativePath,
  dataRootIdentity,
  directoryBytes,
  readJsonFile,
  removeDirectorySafely,
  safeMaintenanceId,
  sha256File,
  sha256Text,
  writeJsonAtomic,
} from './paths.ts';

export const TEAM_BACKUP_TYPES = ['daily', 'manual', 'pre-upgrade', 'pre-restore'] as const;
export type TeamBackupType = typeof TEAM_BACKUP_TYPES[number];
const SNAPSHOT_TIMEOUT_MS = 120_000;

export class TeamBackupSnapshotTimeoutError extends Error {
  readonly code = 'backup_snapshot_timeout';

  constructor() {
    super('SQLite 快照超时，未生成可还原备份');
    this.name = 'TeamBackupSnapshotTimeoutError';
  }
}

export interface TeamBackupFileEntry {
  fileId: string;
  seriesId: string;
  version: number;
  state: 'ready' | 'purge_pending';
  relativePath: string;
  byteSize: number;
  sha256: string;
  references: Array<{
    resourceType: string;
    resourceId: string;
    role: string;
    pinKind: string;
  }>;
}

export interface TeamBackupManifest {
  schemaVersion: 1 | 2;
  kind: 'team-full-backup' | 'team-daily-snapshot';
  backupId: string;
  type: TeamBackupType;
  createdAt: string;
  deploymentId: string;
  dataRootIdentity: string;
  release: { releaseId: string; packageSha256: string };
  config: {
    version: string;
    relativePath: 'config/deployment.json';
    byteSize: number;
    sha256: string;
    protection: 'owner-only';
  };
  database: {
    relativePath: 'data/workbench.db';
    byteSize: number;
    sha256: string;
    integrityCheck: 'ok';
    foreignKeyViolations: 0;
  };
  journal: {
    deploymentId: string;
    watermarkSeq: number;
    headHash: string | null;
    segment: string | null;
    segmentBytes: number;
    evidenceRelativePath: 'evidence/execution-journal.jsonl';
    sha256: string;
  };
  files: TeamBackupFileEntry[];
  pin: { id: string; releaseId: string; configVersion: string } | null;
}

export interface TeamBackupSuccess {
  schemaVersion: 1;
  status: 'success';
  backupId: string;
  type: TeamBackupType;
  verifiedAt: string;
  durationMs: number;
  totalBytes: number;
  newMediaBytes?: number;
  manifestSha256: string;
}

export interface CreateTeamBackupOptions {
  db: Database.Database;
  principal: AccessActor;
  dataRoot: string;
  storageRoot: string;
  backupRoot: string;
  deploymentId: string;
  type: TeamBackupType;
  release: { releaseId: string; packageSha256: string } | (() =>
    | { releaseId: string; packageSha256: string }
    | Promise<{ releaseId: string; packageSha256: string }>);
  config: { version?: string; filePath: string };
  backupId?: string;
  now?: () => Date;
  diskSpaceProbe?: (directory: string) => Promise<number>;
  copyFile?: (source: string, destination: string) => Promise<void>;
  protectConfig?: (filePath: string) => Promise<void>;
  removeDirectory?: (root: string, target: string) => Promise<void>;
  onStage?: (stage: 'snapshotting' | 'copying_media' | 'verifying') => void;
  snapshotTimeoutMs?: number;
}

export interface TeamBackupResult {
  directory: string;
  manifest: TeamBackupManifest;
  success: TeamBackupSuccess;
  rotation?: TeamBackupRotationReport;
}

export interface TeamBackupRotationReport {
  deletedBackupIds: string[];
  retainedBackupIds: string[];
  retainedInvalid: string[];
  errors: Array<{ backupId?: string; deploymentId?: string; code: string }>;
}

function validateDatabase(filePath: string): void {
  const backupDb = new Database(filePath, { readonly: true, fileMustExist: true });
  try {
    const integrity = backupDb.pragma('integrity_check') as Array<{ integrity_check: string }>;
    const foreignKeys = backupDb.pragma('foreign_key_check') as unknown[];
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok' || foreignKeys.length !== 0) {
      throw new Error('备份数据库完整性或外键检查未通过');
    }
  } finally {
    backupDb.close();
  }
}

function readManifestFiles(backupDb: Database.Database): TeamBackupFileEntry[] {
  const files = backupDb.prepare(`
    SELECT id, seriesId, version, state, relativePath, byteSize, sha256
    FROM team_files WHERE state IN ('ready', 'purge_pending') ORDER BY relativePath, id
  `).all() as Array<{
    id: string; seriesId: string; version: number; state: 'ready' | 'purge_pending';
    relativePath: string; byteSize: number; sha256: string;
  }>;
  const references = backupDb.prepare(`
    SELECT resourceType, resourceId, role, pinKind FROM team_file_references
    WHERE fileId = ? AND releasedAt IS NULL ORDER BY resourceType, resourceId, role, pinKind
  `);
  return files.map((file) => ({
    fileId: file.id,
    seriesId: file.seriesId,
    version: file.version,
    state: file.state,
    relativePath: assertSafeRelativePath(file.relativePath),
    byteSize: file.byteSize,
    sha256: file.sha256,
    references: references.all(file.id) as TeamBackupFileEntry['references'],
  }));
}

async function availableBytes(directory: string): Promise<number> {
  const stat = await fsPromises.statfs(directory);
  return stat.bavail * stat.bsize;
}

function backupPaths(backupRoot: string, type: TeamBackupType, backupId: string) {
  if (!TEAM_BACKUP_TYPES.includes(type)) throw new Error('备份类型无效');
  safeMaintenanceId(backupId, 'backupId');
  const typeRoot = path.join(backupRoot, type);
  return {
    typeRoot,
    staging: assertPathInside(typeRoot, path.join(typeRoot, `.${backupId}.staging`)),
    published: assertPathInside(typeRoot, path.join(typeRoot, backupId)),
  };
}

type BackupContext = Pick<CreateTeamBackupOptions, 'db' | 'dataRoot' | 'backupRoot' | 'deploymentId'>;

interface BackupBarrierOwner {
  backupId: string;
  type: TeamBackupType;
  deploymentId: string;
  dataRootIdentity: string;
  nonce: string;
}

type RecoveredBackup = BackupBarrierOwner & { success?: TeamBackupSuccess };

function acquireBackupLock(dataRoot: string) {
  const lockDatabasePath = path.join(dataRoot, 'data', 'team-backup.lock.db');
  assertNoSymlinkPath(lockDatabasePath);
  return acquireSchemaUpgradeLock({ lockDatabasePath, timeoutMs: 0 });
}

async function recoverBackupUnderLock(options: BackupContext): Promise<RecoveredBackup | null> {
  const { db, dataRoot, backupRoot, deploymentId } = options;
  const rows = db.prepare(`SELECT id, ownerUserId, metadataJson, releasedAt FROM team_lifecycle_barriers
    WHERE kind = 'backup' AND CASE WHEN json_valid(metadataJson)
      THEN json_type(metadataJson) = 'object' AND (releasedAt IS NULL OR json_type(metadataJson, '$.pendingPublication') = 'object') ELSE 0 END`)
    .all() as Array<{ id: string; ownerUserId: string; metadataJson: string; releasedAt: string | null }>;
  for (const row of rows) {
    const { backupOwner: owner, pendingPublication } = JSON.parse(row.metadataJson) as {
      backupOwner?: BackupBarrierOwner; pendingPublication?: { pinId: string | null };
    };
    if (!owner || owner.deploymentId !== deploymentId || owner.dataRootIdentity !== dataRootIdentity(dataRoot)
      || typeof owner.nonce !== 'string' || !owner.nonce || typeof owner.backupId !== 'string'
      || !TEAM_BACKUP_TYPES.includes(owner.type)) continue;
    const paths = backupPaths(backupRoot, owner.type, owner.backupId);
    const published = fs.existsSync(paths.published);
    const markerPath = path.join(published ? paths.published : paths.staging, 'maintenance-staging.json');
    const matches = await (async () => {
      assertNoSymlinkPath(markerPath);
      const marker = await readJsonFile<Partial<BackupBarrierOwner> & { schemaVersion?: number }>(markerPath);
      return marker.schemaVersion === 1 && marker.backupId === owner.backupId && marker.type === owner.type
        && marker.deploymentId === deploymentId && marker.dataRootIdentity === owner.dataRootIdentity && marker.nonce === owner.nonce;
    })().catch(() => false);
    if (!matches) {
      if (pendingPublication) throw new Error('无法核对中断备份的发布归属，保留素材 pin');
      continue;
    }
    let success: TeamBackupSuccess | undefined;
    const pinId = pendingPublication?.pinId;
    if (published) {
      const verification = await verifyTeamBackup(paths.published);
      if (!pendingPublication || !verification.verified || verification.manifest.deploymentId !== deploymentId
        || verification.manifest.dataRootIdentity !== owner.dataRootIdentity || verification.manifest.type !== owner.type
        || (verification.manifest.pin?.id ?? null) !== pinId) throw new Error('无法核对已发布备份，保留素材 pin');
      success = await readJsonFile<TeamBackupSuccess>(path.join(paths.published, 'success.json'));
    }
    const recovered = db.transaction(() => {
      const at = new Date().toISOString();
      const updated = db.prepare(`UPDATE team_lifecycle_barriers
        SET releasedAt = COALESCE(releasedAt, ?), metadataJson = json_remove(metadataJson, '$.pendingPublication')
        WHERE id = ? AND kind = 'backup' AND metadataJson = ? AND releasedAt IS ?`)
        .run(at, row.id, row.metadataJson, row.releasedAt).changes === 1;
      if (updated && pinId && !success) {
        const pin = db.prepare('SELECT ownerUserId FROM team_backup_pins WHERE id = ?').get(pinId) as { ownerUserId: string } | undefined;
        if (pin?.ownerUserId !== row.ownerUserId) throw new Error('中断备份的素材 pin 归属不匹配');
        releaseBackupPin(db, { userId: row.ownerUserId, role: 'admin' }, pinId);
      }
      return updated;
    }).immediate();
    if (!recovered) continue;
    if (success) await fsPromises.rm(markerPath).catch(() => undefined);
    appendMaintenanceReceipt({
      backupRoot, deploymentId, kind: 'backup', operationId: owner.backupId, phase: success ? 'finished' : 'failed',
      details: { backupId: owner.backupId, backupType: owner.type,
        ...(success ? { durationMs: success.durationMs, totalBytes: success.totalBytes } : { code: 'backup_interrupted' }) },
    });
    return { ...owner, success };
  }
  return null;
}

/** An acquired OS-backed lock proves that the process running this backup has left. */
export async function recoverInterruptedTeamBackup(options: BackupContext): Promise<RecoveredBackup | null> {
  const lock = await acquireBackupLock(options.dataRoot).catch((error: unknown) => {
    if (error instanceof SchemaUpgradeLockTimeoutError) return null;
    throw error;
  });
  if (!lock) return null;
  try {
    return await recoverBackupUnderLock(options);
  } finally {
    lock.release();
  }
}

export function createTeamBackupId(now = new Date()): string {
  return `${now.toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
}

async function copyTeamDatabase(db: Database.Database, destination: string, timeoutMs: number): Promise<void> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new RangeError('SQLite 快照期限无效');
  const started = performance.now();
  const checkTimeout = () => {
    if (performance.now() - started >= timeoutMs) throw new TeamBackupSnapshotTimeoutError();
  };
  const reader = db.memory ? db : new Database(db.name, { readonly: true, fileMustExist: true, timeout: 1000 });
  try {
    if (reader !== db) {
      reader.exec('BEGIN');
      // Establish the WAL read view before the first backup step. Other writers can still commit.
      reader.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get();
    }
    await reader.backup(destination, { progress() { checkTimeout(); return 100; } });
    checkTimeout();
  } finally {
    if (reader !== db) reader.close();
  }
}

export async function lockDailyMedia(backupRoot: string) {
  const lockDatabasePath = path.join(backupRoot, 'maintenance-control', 'daily-media.lock.db');
  assertNoSymlinkPath(lockDatabasePath);
  return acquireSchemaUpgradeLock({ lockDatabasePath, timeoutMs: 0 });
}

export async function createTeamBackup(options: CreateTeamBackupOptions): Promise<TeamBackupResult> {
  if (options.principal.role !== 'admin') throw new Error('仅管理员可执行团队备份');
  const lock = await acquireBackupLock(options.dataRoot);
  try {
    await recoverBackupUnderLock(options);
    const mediaLock = options.type === 'daily' ? await lockDailyMedia(options.backupRoot) : null;
    try { return await runTeamBackup(options); }
    finally { mediaLock?.release(); }
  } finally {
    lock.release();
  }
}

/** 两把写锁都已取得。只清理由新版日备写入且归属匹配的未发布目录。 */
async function clearInterruptedDailyStaging(dailyRoot: string, deploymentId: string, identity: string) {
  let interrupted = false;
  for (const entry of await fsPromises.readdir(dailyRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('.') || !entry.name.endsWith('.staging')) continue;
    const directory = path.join(dailyRoot, entry.name);
    const markerPath = path.join(directory, 'maintenance-staging.json');
    assertNoSymlinkPath(markerPath);
    const owner = await readJsonFile<BackupBarrierOwner & { schemaVersion: number; mediaStoreVersion?: number }>(markerPath)
      .catch(() => null);
    if (!owner || owner.schemaVersion !== 1 || owner.mediaStoreVersion !== 1 || owner.type !== 'daily'
      || owner.deploymentId !== deploymentId || owner.dataRootIdentity !== identity
      || !owner.nonce || entry.name !== `.${owner.backupId}.staging`) continue;
    await removeDirectorySafely(dailyRoot, directory);
    interrupted = true;
  }
  return interrupted;
}

async function runTeamBackup(options: CreateTeamBackupOptions): Promise<TeamBackupResult> {
  const started = Date.now();
  const now = options.now ?? (() => new Date());
  const backupId = options.backupId ?? createTeamBackupId(now());
  safeMaintenanceId(options.deploymentId, 'deploymentId');
  let configVersion = options.config.version?.trim() ?? '';
  if (options.config.version !== undefined && !configVersion) throw new Error('配置版本不能为空');
  const paths = backupPaths(options.backupRoot, options.type, backupId);
  await fsPromises.mkdir(paths.typeRoot, { recursive: true, mode: 0o700 });
  assertNoSymlinkPath(options.backupRoot);
  assertNoSymlinkPath(options.dataRoot);
  assertNoSymlinkPath(options.storageRoot);
  if (fs.existsSync(paths.published)) throw new Error('备份 ID 已存在，拒绝覆盖');
  if (options.type === 'daily' && await clearInterruptedDailyStaging(paths.typeRoot, options.deploymentId, dataRootIdentity(options.dataRoot))) {
    // 即使上一次写满了磁盘，也先回收未发布媒体，再预检新备份的可用空间。
    await rotateLockedDailyTeamBackups({ backupRoot: options.backupRoot, deploymentId: options.deploymentId }, false);
  }
  if (fs.existsSync(paths.staging)) {
    try {
      const owner = await readJsonFile<{
        schemaVersion: number; backupId: string; deploymentId: string; type: TeamBackupType;
      }>(path.join(paths.staging, 'maintenance-staging.json'));
      if (owner.schemaVersion !== 1 || owner.backupId !== backupId
        || owner.deploymentId !== options.deploymentId || owner.type !== options.type) throw new Error('owner mismatch');
    } catch {
      throw new Error('备份 staging 缺少匹配的 owner 标记，拒绝清理或覆盖');
    }
    await removeDirectorySafely(paths.typeRoot, paths.staging);
  }
  appendMaintenanceReceipt({
    backupRoot: options.backupRoot, deploymentId: options.deploymentId, kind: 'backup', operationId: backupId,
    phase: 'started', at: now().toISOString(), details: { backupId, backupType: options.type },
  });
  options.onStage?.('snapshotting');

  let barrierId: string | null = null;
  let publicationBarrierId: string | null = null;
  let pinId: string | null = null;
  let newMediaBytes = 0;
  try {
    const requiredBytes = (options.db.pragma('page_count', { simple: true }) as number)
      * (options.db.pragma('page_size', { simple: true }) as number)
      + Math.max(16 * 1024 * 1024, fs.statSync(options.config.filePath).size);
    const available = await (options.diskSpaceProbe ?? availableBytes)(paths.typeRoot);
    if (available < requiredBytes) throw new Error('备份空间不足');

    await fsPromises.mkdir(path.join(paths.staging, 'data'), { recursive: true, mode: 0o700 });
    await fsPromises.mkdir(path.join(paths.staging, 'config'), { recursive: true, mode: 0o700 });
    await fsPromises.mkdir(path.join(paths.staging, 'evidence'), { recursive: true, mode: 0o700 });
    const backupOwner: BackupBarrierOwner = {
      backupId, deploymentId: options.deploymentId, type: options.type,
      dataRootIdentity: dataRootIdentity(options.dataRoot), nonce: randomUUID(),
    };
    await writeJsonAtomic(path.join(paths.staging, 'maintenance-staging.json'), {
      schemaVersion: 1, ...backupOwner, ...(options.type === 'daily' ? { mediaStoreVersion: 1 } : {}),
    });
    const barrier = acquireLifecycleBarrier(options.db, options.principal, 'backup', {
      backupId,
      backupOwner,
      releaseId: typeof options.release === 'function' ? 'snapshot-pending' : options.release.releaseId,
      configVersion: configVersion || 'snapshot-pending',
    });
    barrierId = barrier.id;
    let release: { releaseId: string; packageSha256: string };
    let files: TeamBackupFileEntry[];
    let configHash: string;
    let configBytes: number;
    let journal: TeamBackupManifest['journal'];
    let snapshotAt: string;
    try {
      release = typeof options.release === 'function' ? await options.release() : options.release;
      safeMaintenanceId(release.releaseId, 'releaseId');
      if (!/^[0-9a-f]{64}$/.test(release.packageSha256)) throw new Error('release 包哈希无效');
      const databasePath = path.join(paths.staging, 'data', 'workbench.db');
      snapshotAt = now().toISOString();
      await copyTeamDatabase(options.db, databasePath, options.snapshotTimeoutMs ?? SNAPSHOT_TIMEOUT_MS);
      validateDatabase(databasePath);
      const backupDb = new Database(databasePath, { readonly: true, fileMustExist: true });
      try {
        files = readManifestFiles(backupDb);
      } finally {
        backupDb.close();
      }

      const protectedConfig = path.join(paths.staging, 'config', 'deployment.json');
      assertNoSymlinkPath(options.config.filePath);
      await fsPromises.copyFile(options.config.filePath, protectedConfig, fs.constants.COPYFILE_EXCL);
      await (options.protectConfig ?? (async (filePath: string) => fsPromises.chmod(filePath, 0o600)))(protectedConfig);
      configHash = await sha256File(protectedConfig);
      configBytes = (await fsPromises.stat(protectedConfig)).size;
      if (!configVersion) configVersion = `sha256:${configHash}`;

      const journalDirectory = path.join(options.dataRoot, 'storage', 'execution-journal', options.deploymentId);
      const executionJournal = createExecutionJournal({ deploymentId: options.deploymentId, directory: journalDirectory });
      const verification = executionJournal.verify();
      if (!verification.valid) throw new Error('execution journal 校验失败，不能建立备份水位');
      const records = verification.records;
      const evidence = records.map((record) => JSON.stringify(record)).join('\n') + (records.length > 0 ? '\n' : '');
      await fsPromises.writeFile(path.join(paths.staging, 'evidence', 'execution-journal.jsonl'), evidence, {
        encoding: 'utf8', flag: 'wx', mode: 0o600,
      });
      const segments = fs.existsSync(journalDirectory)
        ? fs.readdirSync(journalDirectory).filter((name) => /^\d{6}\.jsonl$/.test(name)).sort()
        : [];
      const segment = segments.at(-1) ?? null;
      journal = {
        deploymentId: options.deploymentId,
        watermarkSeq: records.at(-1)?.seq ?? 0,
        headHash: records.at(-1)?.hash ?? null,
        segment,
        segmentBytes: segment ? fs.statSync(path.join(journalDirectory, segment)).size : 0,
        evidenceRelativePath: 'evidence/execution-journal.jsonl',
        sha256: sha256Text(evidence),
      };

      pinId = options.db.transaction(() => {
        if (!releaseLifecycleBarrier(options.db, options.principal, barrier.id)) {
          throw new Error('备份屏障已失效，拒绝发布该备份');
        }
        const newPinId = files.length ? createBackupPin(options.db, options.principal, {
          releaseId: release.releaseId, configVersion, fileIds: files.map((file) => file.fileId),
        }).id : null;
        options.db.prepare(`UPDATE team_lifecycle_barriers
          SET metadataJson = json_set(metadataJson, '$.pendingPublication', json_object('pinId', ?)) WHERE id = ?`)
          .run(newPinId, barrier.id);
        return newPinId;
      }).immediate();
      publicationBarrierId = barrier.id;
      barrierId = null;
    } finally {
      if (barrierId) releaseLifecycleBarrier(options.db, options.principal, barrierId);
      barrierId = null;
    }

    const copy = options.copyFile ?? (async (source: string, destination: string) => {
      await fsPromises.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await fsPromises.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
    });
    for (const file of files) {
      options.onStage?.('copying_media');
      const source = path.resolve(options.storageRoot, ...file.relativePath.split('/'));
      if (path.relative(path.resolve(options.storageRoot), source).split(path.sep).join('/') !== file.relativePath) {
        throw new Error('媒体来源越出 storage 根');
      }
      assertNoSymlinkPath(source);
      if (options.type === 'daily') {
        newMediaBytes += await storeDailyMedia({ backupRoot: options.backupRoot, deploymentId: options.deploymentId,
          staging: paths.staging, source, file, copy });
        continue;
      }
      const destination = path.join(paths.staging, 'files', ...file.relativePath.split('/'));
      await copy(source, destination);
      const stat = await fsPromises.stat(destination);
      if (stat.size !== file.byteSize || await sha256File(destination) !== file.sha256) {
        throw new Error(`媒体备份校验失败：${file.fileId}`);
      }
    }

    options.onStage?.('verifying');
    const databasePath = path.join(paths.staging, 'data', 'workbench.db');
    validateDatabase(databasePath);
    const manifest: TeamBackupManifest = {
      schemaVersion: options.type === 'daily' ? 2 : 1,
      kind: options.type === 'daily' ? 'team-daily-snapshot' : 'team-full-backup',
      backupId,
      type: options.type,
      createdAt: snapshotAt,
      deploymentId: options.deploymentId,
      dataRootIdentity: dataRootIdentity(options.dataRoot),
      release: { ...release },
      config: {
        version: configVersion,
        relativePath: 'config/deployment.json',
        byteSize: configBytes!,
        sha256: configHash!,
        protection: 'owner-only',
      },
      database: {
        relativePath: 'data/workbench.db',
        byteSize: (await fsPromises.stat(databasePath)).size,
        sha256: await sha256File(databasePath),
        integrityCheck: 'ok',
        foreignKeyViolations: 0,
      },
      journal: journal!,
      files,
      pin: pinId ? { id: pinId, releaseId: release.releaseId, configVersion } : null,
    };
    await writeJsonAtomic(path.join(paths.staging, 'manifest.json'), manifest);
    const stagingMarker = path.join(paths.staging, 'maintenance-staging.json');
    const success: TeamBackupSuccess = {
      schemaVersion: 1,
      status: 'success',
      backupId,
      type: options.type,
      verifiedAt: now().toISOString(),
      durationMs: Date.now() - started,
      totalBytes: await directoryBytes(paths.staging) - (await fsPromises.stat(stagingMarker)).size
        + (options.type === 'daily' ? files.reduce((sum, file) => sum + file.byteSize, 0) : 0),
      ...(options.type === 'daily' ? { newMediaBytes } : {}),
      manifestSha256: sha256Text(await fsPromises.readFile(path.join(paths.staging, 'manifest.json'), 'utf8')),
    };
    await writeJsonAtomic(path.join(paths.staging, 'success.json'), success);
    const stagingVerification = await verifyTeamBackup(paths.staging);
    if (!stagingVerification.verified) throw new Error(`完整备份发布前校验失败：${stagingVerification.code}`);
    await publishBackupDirectory(paths.staging, paths.published);
    pinId = null; // 从此由已发布的还原点持有，清理出错也必须保留。
    clearPendingPublication(options.db, publicationBarrierId);
    publicationBarrierId = null;
    await fsPromises.rm(path.join(paths.published, 'maintenance-staging.json')).catch(() => undefined);
    appendMaintenanceReceipt({
      backupRoot: options.backupRoot, deploymentId: options.deploymentId, kind: 'backup', operationId: backupId,
      phase: 'finished', at: now().toISOString(),
      details: { backupId, backupType: options.type, durationMs: success.durationMs, totalBytes: success.totalBytes },
    });
    const rotation = options.type === 'daily'
      ? await rotateLockedDailyTeamBackups({
        deploymentId: options.deploymentId,
        latestBackupId: backupId,
        backupRoot: options.backupRoot,
        removeDirectory: options.removeDirectory,
        db: options.db,
        principal: options.principal,
      }).catch(() => ({ retainedBackupIds: [backupId], deletedBackupIds: [], retainedInvalid: [],
        errors: [{ backupId, code: 'rotation_failed' }] }))
      : undefined;
    return { directory: paths.published, manifest, success, ...(rotation ? { rotation } : {}) };
  } catch (error) {
    if (barrierId) releaseLifecycleBarrier(options.db, options.principal, barrierId);
    if (!fs.existsSync(paths.published)) options.db.transaction(() => {
      if (pinId) releaseBackupPin(options.db, options.principal, pinId);
      if (publicationBarrierId) clearPendingPublication(options.db, publicationBarrierId);
    }).immediate();
    appendMaintenanceReceipt({
      backupRoot: options.backupRoot, deploymentId: options.deploymentId, kind: 'backup', operationId: backupId,
      phase: 'failed', at: now().toISOString(),
      details: { backupId, backupType: options.type, code: error instanceof TeamBackupSnapshotTimeoutError ? error.code
        : error instanceof Error ? error.name : 'Error' },
    });
    if (fs.existsSync(paths.staging)) await removeDirectorySafely(paths.typeRoot, paths.staging);
    if (options.type === 'daily' && newMediaBytes > 0) {
      // 释放失败写入占用的空间；失败备份绝不触发还原点轮换。
      await rotateLockedDailyTeamBackups({ backupRoot: options.backupRoot, deploymentId: options.deploymentId }, false)
        .catch(() => undefined); // 文件仍在，下一次成功轮换重试。
    }
    throw error;
  }
}

function clearPendingPublication(db: Database.Database, barrierId: string): void {
  db.prepare(`UPDATE team_lifecycle_barriers
    SET metadataJson = json_remove(metadataJson, '$.pendingPublication') WHERE id = ?`).run(barrierId);
}

type BackupVerification = { verified: true; manifest: TeamBackupManifest } | { verified: false; code: string };
type VerifyOptions = { requireSuccess?: boolean };

/** 一次列表或轮换扫描内，相同的共享对象仅做一次全文件 SHA-256；下一次扫描重新检查。 */
export function createTeamBackupVerifier() {
  const checkedObjects = new Map<string, string>();
  return (directory: string, options: VerifyOptions = {}) => verifyDirectory(directory, options, checkedObjects);
}

export function verifyTeamBackup(directory: string, options: VerifyOptions = {}): Promise<BackupVerification> {
  return createTeamBackupVerifier()(directory, options);
}

async function verifyDirectory(directory: string, options: VerifyOptions, checkedObjects: Map<string, string>): Promise<BackupVerification> {
  try {
    assertNoSymlinkPath(directory);
    const manifestPath = path.join(directory, 'manifest.json');
    const manifest = await readJsonFile<TeamBackupManifest>(manifestPath);
    const supported = (manifest.schemaVersion === 1 && manifest.kind === 'team-full-backup')
      || (manifest.schemaVersion === 2 && manifest.kind === 'team-daily-snapshot' && manifest.type === 'daily'
        && path.basename(path.dirname(directory)) === 'daily');
    if (!supported || !Number.isFinite(Date.parse(manifest.createdAt)) || !TEAM_BACKUP_TYPES.includes(manifest.type) || manifest.backupId !== path.basename(directory).replace(/^\.|\.staging$/g, '')) {
      return { verified: false, code: 'manifest_invalid' };
    }
    if (options.requireSuccess !== false) {
      const success = await readJsonFile<TeamBackupSuccess>(path.join(directory, 'success.json'));
      if (success.status !== 'success' || success.backupId !== manifest.backupId
        || success.manifestSha256 !== sha256Text(await fsPromises.readFile(manifestPath, 'utf8'))) {
        return { verified: false, code: 'success_invalid' };
      }
    }
    const databasePath = path.join(directory, 'data', 'workbench.db');
    const databaseStat = await fsPromises.stat(databasePath);
    if (databaseStat.size !== manifest.database.byteSize || await sha256File(databasePath) !== manifest.database.sha256) {
      return { verified: false, code: 'database_hash_mismatch' };
    }
    validateDatabase(databasePath);
    const configPath = path.join(directory, 'config', 'deployment.json');
    if ((await fsPromises.stat(configPath)).size !== manifest.config.byteSize
      || await sha256File(configPath) !== manifest.config.sha256) return { verified: false, code: 'config_hash_mismatch' };
    const evidencePath = path.join(directory, 'evidence', 'execution-journal.jsonl');
    if (await sha256File(evidencePath) !== manifest.journal.sha256) return { verified: false, code: 'journal_hash_mismatch' };
    for (const file of manifest.files) {
      const filePath = backupMediaPath(directory, manifest, file);
      const stat = await fsPromises.lstat(filePath, { bigint: true });
      if (!stat.isFile() || Number(stat.size) !== file.byteSize) return { verified: false, code: 'file_hash_mismatch' };
      const identity = `${stat.dev}/${stat.ino}/${stat.size}/${stat.ctimeNs}/${stat.mtimeNs}`;
      if (manifest.schemaVersion === 2 && checkedObjects.get(filePath) === identity) continue;
      if (await sha256File(filePath) !== file.sha256) return { verified: false, code: 'file_hash_mismatch' };
      if (manifest.schemaVersion === 2) checkedObjects.set(filePath, identity);
    }
    return { verified: true, manifest };
  } catch (error) {
    return { verified: false, code: error instanceof Error && error.message.includes('完整性') ? 'integrity_failed' : 'verification_failed' };
  }
}

interface RotateDailyOptions {
  backupRoot: string;
  deploymentId?: string;
  removeDirectory?: (root: string, target: string) => Promise<void>;
  db?: Database.Database;
  principal?: AccessActor;
}

export async function rotateDailyTeamBackups(options: RotateDailyOptions): Promise<TeamBackupRotationReport> {
  const lock = await lockDailyMedia(options.backupRoot);
  try { return await rotateLockedDailyTeamBackups(options); }
  finally { lock.release(); }
}

async function rotateLockedDailyTeamBackups(options: RotateDailyOptions & { latestBackupId?: string }, expireSnapshots = true): Promise<TeamBackupRotationReport> {
  const dailyRoot = path.join(options.backupRoot, 'daily');
  const report: TeamBackupRotationReport = {
    deletedBackupIds: [], retainedBackupIds: [], retainedInvalid: [], errors: [],
  };
  if (!fs.existsSync(dailyRoot)) return report;
  const entries = await fsPromises.readdir(dailyRoot, { withFileTypes: true });
  const valid: Array<{ directory: string; manifest: TeamBackupManifest }> = [];
  const verify = createTeamBackupVerifier();
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) report.retainedInvalid.push(entry.name);
      continue;
    }
    const directory = path.join(dailyRoot, entry.name);
    const verification = await verify(directory);
    if (!verification.verified || verification.manifest.type !== 'daily') report.retainedInvalid.push(entry.name);
    else if (!options.deploymentId || options.deploymentId === verification.manifest.deploymentId) {
      valid.push({ directory, manifest: verification.manifest });
    }
  }
  valid.sort((left, right) => right.manifest.createdAt.localeCompare(left.manifest.createdAt)
    || Number(right.manifest.backupId === options.latestBackupId) - Number(left.manifest.backupId === options.latestBackupId)
    || right.manifest.backupId.localeCompare(left.manifest.backupId));
  const { db, principal } = options;
  const releasePin = db && principal ? (id: string) => { releaseBackupPin(db, principal, id); } : undefined;
  if (expireSnapshots && !options.removeDirectory) {
    const deployments = options.deploymentId ? [options.deploymentId] : new Set(valid.map(item => item.manifest.deploymentId));
    for (const deploymentId of deployments) {
      try { await resumeDailyRetirements(options.backupRoot, deploymentId, releasePin); }
      catch { report.errors.push({ deploymentId, code: 'cleanup_failed' }); }
    }
  }
  const keptDays = new Map<string, Set<string>>();
  const retainedObjects = new Map<string, Set<string>>();
  if (options.deploymentId) retainedObjects.set(options.deploymentId, new Set());
  for (const candidate of valid) {
    const { deploymentId, createdAt, backupId } = candidate.manifest;
    const days = keptDays.get(deploymentId) ?? new Set<string>();
    keptDays.set(deploymentId, days);
    const hashes = retainedObjects.get(deploymentId) ?? new Set<string>();
    retainedObjects.set(deploymentId, hashes);
    // 计划任务使用服务器本地时区。同一天只保留最新的成功快照。
    const day = new Date(createdAt).toDateString();
    if (!expireSnapshots || (days.size < 14 && !days.has(day))) {
      days.add(day);
      report.retainedBackupIds.push(backupId);
      if (candidate.manifest.schemaVersion === 2) {
        for (const file of candidate.manifest.files) hashes.add(file.sha256);
      }
      continue;
    }
    try {
      if (options.removeDirectory) {
        await options.removeDirectory(dailyRoot, candidate.directory);
        if (candidate.manifest.pin) releasePin?.(candidate.manifest.pin.id);
      } else {
        await retireVerifiedDaily(options.backupRoot, candidate.manifest, releasePin);
      }
      report.deletedBackupIds.push(candidate.manifest.backupId);
    } catch {
      report.errors.push({ backupId: candidate.manifest.backupId, code: 'cleanup_failed' });
      if (fs.existsSync(candidate.directory)) report.retainedBackupIds.push(candidate.manifest.backupId);
    }
  }
  // 任何未核清的发布目录或删除失败都可能持有唯一引用，留待下一轮重试。
  if (report.errors.length === 0 && !report.retainedInvalid.some(id => !id.startsWith('.'))) {
    for (const [deploymentId, hashes] of retainedObjects) {
      try { await pruneDailyMedia(options.backupRoot, deploymentId, hashes); }
      catch { report.errors.push({ deploymentId, code: 'media_cleanup_failed' }); }
    }
  }
  return report;
}
