import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { AccessActor } from '../../media-core/access-context.ts';
import { createExecutionJournal } from '../../media-core/execution/journal.ts';
import {
  acquireLifecycleBarrier,
  createBackupPin,
  releaseBackupPin,
  releaseLifecycleBarrier,
} from '../lifecycle/index.ts';
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
  schemaVersion: 1;
  kind: 'team-full-backup';
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
  errors: Array<{ backupId: string; code: string }>;
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

export async function createTeamBackup(options: CreateTeamBackupOptions): Promise<TeamBackupResult> {
  const started = Date.now();
  const now = options.now ?? (() => new Date());
  const backupId = options.backupId ?? `${now().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  safeMaintenanceId(options.deploymentId, 'deploymentId');
  let configVersion = options.config.version?.trim() ?? '';
  if (options.config.version !== undefined && !configVersion) throw new Error('配置版本不能为空');
  const paths = backupPaths(options.backupRoot, options.type, backupId);
  await fsPromises.mkdir(paths.typeRoot, { recursive: true, mode: 0o700 });
  assertNoSymlinkPath(options.backupRoot);
  assertNoSymlinkPath(options.dataRoot);
  assertNoSymlinkPath(options.storageRoot);
  if (fs.existsSync(paths.published)) throw new Error('备份 ID 已存在，拒绝覆盖');
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
  let pinId: string | null = null;
  try {
    const requiredBytes = (options.db.pragma('page_count', { simple: true }) as number)
      * (options.db.pragma('page_size', { simple: true }) as number)
      + Math.max(16 * 1024 * 1024, fs.statSync(options.config.filePath).size);
    const available = await (options.diskSpaceProbe ?? availableBytes)(paths.typeRoot);
    if (available < requiredBytes) throw new Error('备份空间不足');

    await fsPromises.mkdir(path.join(paths.staging, 'data'), { recursive: true, mode: 0o700 });
    await fsPromises.mkdir(path.join(paths.staging, 'config'), { recursive: true, mode: 0o700 });
    await fsPromises.mkdir(path.join(paths.staging, 'evidence'), { recursive: true, mode: 0o700 });
    await writeJsonAtomic(path.join(paths.staging, 'maintenance-staging.json'), {
      schemaVersion: 1, backupId, deploymentId: options.deploymentId, type: options.type,
    });
    const barrier = acquireLifecycleBarrier(options.db, options.principal, 'backup', {
      backupId,
      releaseId: typeof options.release === 'function' ? 'snapshot-pending' : options.release.releaseId,
      configVersion: configVersion || 'snapshot-pending',
    });
    barrierId = barrier.id;
    let release: { releaseId: string; packageSha256: string };
    let files: TeamBackupFileEntry[];
    let configHash: string;
    let configBytes: number;
    let journal: TeamBackupManifest['journal'];
    try {
      release = typeof options.release === 'function' ? await options.release() : options.release;
      safeMaintenanceId(release.releaseId, 'releaseId');
      if (!/^[0-9a-f]{64}$/.test(release.packageSha256)) throw new Error('release 包哈希无效');
      const databasePath = path.join(paths.staging, 'data', 'workbench.db');
      await options.db.backup(databasePath);
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

      if (files.length > 0) {
        const pin = createBackupPin(options.db, options.principal, {
          releaseId: release.releaseId,
          configVersion,
          fileIds: files.map((file) => file.fileId),
        });
        pinId = pin.id;
      }
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
      schemaVersion: 1,
      kind: 'team-full-backup',
      backupId,
      type: options.type,
      createdAt: now().toISOString(),
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
    const stagingVerification = await verifyTeamBackup(paths.staging, { requireSuccess: false });
    if (!stagingVerification.verified) throw new Error(`完整备份发布前校验失败：${stagingVerification.code}`);
    await fsPromises.rm(path.join(paths.staging, 'maintenance-staging.json'));
    await fsPromises.rename(paths.staging, paths.published);
    const success: TeamBackupSuccess = {
      schemaVersion: 1,
      status: 'success',
      backupId,
      type: options.type,
      verifiedAt: now().toISOString(),
      durationMs: Date.now() - started,
      totalBytes: await directoryBytes(paths.published),
      manifestSha256: sha256Text(await fsPromises.readFile(path.join(paths.published, 'manifest.json'), 'utf8')),
    };
    await writeJsonAtomic(path.join(paths.published, 'success.json'), success);
    const finalVerification = await verifyTeamBackup(paths.published);
    if (!finalVerification.verified) throw new Error(`完整备份发布后校验失败：${finalVerification.code}`);
    appendMaintenanceReceipt({
      backupRoot: options.backupRoot, deploymentId: options.deploymentId, kind: 'backup', operationId: backupId,
      phase: 'finished', at: now().toISOString(),
      details: { backupId, backupType: options.type, durationMs: success.durationMs, totalBytes: success.totalBytes },
    });
    const rotation = options.type === 'daily'
      ? await rotateDailyTeamBackups({
        backupRoot: options.backupRoot,
        removeDirectory: options.removeDirectory,
        db: options.db,
        principal: options.principal,
      })
      : undefined;
    return { directory: paths.published, manifest, success, ...(rotation ? { rotation } : {}) };
  } catch (error) {
    if (barrierId) releaseLifecycleBarrier(options.db, options.principal, barrierId);
    if (pinId) releaseBackupPin(options.db, options.principal, pinId);
    appendMaintenanceReceipt({
      backupRoot: options.backupRoot, deploymentId: options.deploymentId, kind: 'backup', operationId: backupId,
      phase: 'failed', at: now().toISOString(),
      details: { backupId, backupType: options.type, code: error instanceof Error ? error.name : 'Error' },
    });
    if (fs.existsSync(paths.staging)) await removeDirectorySafely(paths.typeRoot, paths.staging);
    throw error;
  }
}

export async function verifyTeamBackup(
  directory: string,
  options: { requireSuccess?: boolean } = {},
): Promise<{ verified: true; manifest: TeamBackupManifest } | { verified: false; code: string }> {
  try {
    assertNoSymlinkPath(directory);
    const manifestPath = path.join(directory, 'manifest.json');
    const manifest = await readJsonFile<TeamBackupManifest>(manifestPath);
    if (manifest.schemaVersion !== 1 || manifest.kind !== 'team-full-backup'
      || !TEAM_BACKUP_TYPES.includes(manifest.type) || manifest.backupId !== path.basename(directory).replace(/^\.|\.staging$/g, '')) {
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
      const relative = assertSafeRelativePath(file.relativePath);
      const filePath = path.join(directory, 'files', ...relative.split('/'));
      if ((await fsPromises.stat(filePath)).size !== file.byteSize || await sha256File(filePath) !== file.sha256) {
        return { verified: false, code: 'file_hash_mismatch' };
      }
    }
    return { verified: true, manifest };
  } catch (error) {
    return { verified: false, code: error instanceof Error && error.message.includes('完整性') ? 'integrity_failed' : 'verification_failed' };
  }
}

export async function rotateDailyTeamBackups(options: {
  backupRoot: string;
  removeDirectory?: (root: string, target: string) => Promise<void>;
  db?: Database.Database;
  principal?: AccessActor;
}): Promise<TeamBackupRotationReport> {
  const dailyRoot = path.join(options.backupRoot, 'daily');
  const report: TeamBackupRotationReport = {
    deletedBackupIds: [], retainedBackupIds: [], retainedInvalid: [], errors: [],
  };
  if (!fs.existsSync(dailyRoot)) return report;
  const entries = await fsPromises.readdir(dailyRoot, { withFileTypes: true });
  const valid: Array<{ directory: string; manifest: TeamBackupManifest }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) {
      if (entry.name.startsWith('.')) report.retainedInvalid.push(entry.name);
      continue;
    }
    const directory = path.join(dailyRoot, entry.name);
    const verification = await verifyTeamBackup(directory);
    if (verification.verified) valid.push({ directory, manifest: verification.manifest });
    else report.retainedInvalid.push(entry.name);
  }
  valid.sort((left, right) => right.manifest.createdAt.localeCompare(left.manifest.createdAt)
    || right.manifest.backupId.localeCompare(left.manifest.backupId));
  const remove = options.removeDirectory ?? removeDirectorySafely;
  for (const [index, candidate] of valid.entries()) {
    if (index < 14) {
      report.retainedBackupIds.push(candidate.manifest.backupId);
      continue;
    }
    try {
      await remove(dailyRoot, candidate.directory);
      if (candidate.manifest.pin && options.db && options.principal) {
        releaseBackupPin(options.db, options.principal, candidate.manifest.pin.id);
      }
      report.deletedBackupIds.push(candidate.manifest.backupId);
    } catch {
      report.errors.push({ backupId: candidate.manifest.backupId, code: 'cleanup_failed' });
      report.retainedBackupIds.push(candidate.manifest.backupId);
    }
  }
  return report;
}
