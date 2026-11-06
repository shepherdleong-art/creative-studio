import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createExecutionJournal } from '../../media-core/execution/journal.ts';
import { recoverExecution, reconcileAttempt } from '../../media-core/execution/reconciliation.ts';
import type { ReconcileEvidence } from '../../media-core/execution/context.ts';
import { verifyTeamBackup } from './backup.ts';
import { appendMaintenanceReceipt } from './receipts.ts';
import {
  assertNoSymlinkPath,
  assertPathInside,
  readJsonFile,
  safeMaintenanceId,
  sha256File,
  writeJsonAtomic,
} from './paths.ts';
import { readTeamRestoreHold, teamRestoreHoldPath, writeTeamRestoreHold } from './hold.ts';

export { readTeamRestoreHold } from './hold.ts';

interface ReconciliationReport {
  schemaVersion: 1;
  backupId: string;
  status: 'hold' | 'reconciled';
  evidenceStatus: 'complete' | 'unavailable';
  journalWatermark: number;
  postWatermarkRecords: number;
  unknownAttemptIds: string[];
  orphanAttemptIds: string[];
  recoveredReceiptAttemptIds: string[];
  scheduling: false;
  automaticRetries: 0;
  remoteCalls: number;
}

export interface RestoreTeamBackupOptions {
  backupDirectory: string;
  restoreRoot: string;
  deploymentId: string;
  expectedReleaseId: string;
  currentDb?: Database.Database;
  currentJournalDirectory?: string;
  now?: () => Date;
  protectConfig?: (filePath: string) => Promise<void>;
  lookupRemote?: (attemptId: string) => Promise<ReconcileEvidence>;
}

function backupRootFor(directory: string): string {
  return path.dirname(path.dirname(path.resolve(directory)));
}

async function copyVerified(source: string, destination: string, expectedHash: string): Promise<void> {
  assertNoSymlinkPath(source);
  await fsPromises.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await fsPromises.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
  if (await sha256File(destination) !== expectedHash) throw new Error('恢复文件哈希校验失败');
}

function readReconciliationState(db: Database.Database): { unknownAttemptIds: string[]; orphanAttemptIds: string[] } {
  const unresolved = (db.prepare(`
    SELECT id FROM execution_attempts WHERE submissionState = 'maybe_sent'
    UNION SELECT currentAttemptId AS id FROM execution_operations
    WHERE status = 'unknown' AND currentAttemptId IS NOT NULL
  `).all() as Array<{ id: string }>).map((row) => row.id);
  const unknownOrphans = (db.prepare(`
    SELECT attemptId AS id FROM execution_reconciliation_orphans WHERE state = 'unknown'
  `).all() as Array<{ id: string }>).map((row) => row.id);
  const unresolvedOrphans = (db.prepare(`
    SELECT attemptId AS id FROM execution_reconciliation_orphans WHERE state <> 'terminal'
  `).all() as Array<{ id: string }>).map((row) => row.id);
  return {
    unknownAttemptIds: [...new Set([...unresolved, ...unknownOrphans])].sort(),
    orphanAttemptIds: [...new Set(unresolvedOrphans)].sort(),
  };
}

function captureExecution(currentDb: Database.Database | undefined): unknown {
  if (!currentDb) throw new Error('当前执行表不可读');
  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    operations: currentDb.prepare('SELECT * FROM execution_operations').all(),
    attempts: currentDb.prepare('SELECT * FROM execution_attempts').all(),
    reservations: currentDb.prepare('SELECT * FROM execution_reservations').all(),
  };
}

function copyJournalEvidence(source: string | undefined, destination: string, deploymentId: string): {
  evidenceStatus: 'complete' | 'unavailable';
  records: ReturnType<ReturnType<typeof createExecutionJournal>['scan']>;
} {
  if (!source || !fs.existsSync(source)) return { evidenceStatus: 'unavailable', records: [] };
  assertNoSymlinkPath(source);
  const journal = createExecutionJournal({ deploymentId, directory: source });
  const verification = journal.verify();
  if (!verification.valid) return { evidenceStatus: 'unavailable', records: [] };
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (!entry.isFile() || !/^\d{6}\.jsonl$/.test(entry.name)) continue;
    const sourceFile = path.join(source, entry.name);
    assertNoSymlinkPath(sourceFile);
    fs.copyFileSync(sourceFile, path.join(destination, entry.name), fs.constants.COPYFILE_EXCL);
  }
  return { evidenceStatus: 'complete', records: verification.records };
}

export async function restoreTeamBackup(options: RestoreTeamBackupOptions) {
  const now = options.now ?? (() => new Date());
  safeMaintenanceId(options.deploymentId, 'deploymentId');
  safeMaintenanceId(options.expectedReleaseId, 'releaseId');
  const verification = await verifyTeamBackup(options.backupDirectory);
  if (!verification.verified) throw new Error(`备份不是可恢复的成功版本：${verification.code}`);
  const manifest = verification.manifest;
  if (manifest.deploymentId !== options.deploymentId || manifest.release.releaseId !== options.expectedReleaseId) {
    throw new Error('备份部署或 release 与恢复目标不匹配');
  }
  const restoreRoot = path.resolve(options.restoreRoot);
  if (fs.existsSync(restoreRoot) || path.parse(restoreRoot).root.toLowerCase() === restoreRoot.toLowerCase()) {
    throw new Error('恢复目标必须是尚不存在的全新目录且不能是磁盘根');
  }
  const backupDirectory = path.resolve(options.backupDirectory);
  const relativeToBackup = path.relative(backupDirectory, restoreRoot);
  const relativeToRestore = path.relative(restoreRoot, backupDirectory);
  if ((!relativeToBackup.startsWith('..') && !path.isAbsolute(relativeToBackup))
    || (!relativeToRestore.startsWith('..') && !path.isAbsolute(relativeToRestore))) {
    throw new Error('恢复根与备份目录不得重叠');
  }
  assertNoSymlinkPath(path.dirname(restoreRoot));
  const operationId = `restore-${manifest.backupId}-${randomUUID().slice(0, 8)}`;
  const backupRoot = backupRootFor(backupDirectory);
  appendMaintenanceReceipt({
    backupRoot, deploymentId: options.deploymentId, kind: 'restore', operationId, phase: 'started',
    at: now().toISOString(), details: { backupId: manifest.backupId },
  });
  const staging = path.join(path.dirname(restoreRoot), `.${path.basename(restoreRoot)}.${operationId}.staging`);
  assertPathInside(path.dirname(restoreRoot), staging);
  let currentExecution: unknown;
  let executionEvidenceStatus: 'complete' | 'unavailable' = 'complete';
  try {
    currentExecution = captureExecution(options.currentDb);
  } catch {
    executionEvidenceStatus = 'unavailable';
  }

  try {
    await fsPromises.mkdir(staging, { recursive: false, mode: 0o700 });
    const restoredJournalDirectory = path.join(staging, 'storage', 'execution-journal', options.deploymentId);
    let journalEvidence: ReturnType<typeof copyJournalEvidence>;
    try {
      journalEvidence = copyJournalEvidence(options.currentJournalDirectory, restoredJournalDirectory, options.deploymentId);
    } catch {
      journalEvidence = { evidenceStatus: 'unavailable', records: [] };
      await fsPromises.mkdir(restoredJournalDirectory, { recursive: true, mode: 0o700 });
    }
    const evidenceStatus = executionEvidenceStatus === 'complete' && journalEvidence.evidenceStatus === 'complete'
      ? 'complete' : 'unavailable';
    await writeJsonAtomic(path.join(staging, 'storage', 'maintenance', 'pre-restore-execution.json'), {
      schemaVersion: 1,
      evidenceStatus: executionEvidenceStatus,
      snapshot: currentExecution ?? null,
    });

    await copyVerified(
      path.join(backupDirectory, 'data', 'workbench.db'),
      path.join(staging, 'data', 'workbench.db'),
      manifest.database.sha256,
    );
    for (const file of manifest.files) {
      await copyVerified(
        path.join(backupDirectory, 'files', ...file.relativePath.split('/')),
        path.join(staging, 'storage', ...file.relativePath.split('/')),
        file.sha256,
      );
    }
    await copyVerified(
      path.join(backupDirectory, 'config', 'deployment.json'),
      path.join(staging, 'config', 'deployment.json'),
      manifest.config.sha256,
    );
    await (options.protectConfig ?? (async (filePath: string) => fsPromises.chmod(filePath, 0o600)))(
      path.join(staging, 'config', 'deployment.json'),
    );
    await writeJsonAtomic(path.join(staging, 'deployment.json'), {
      schemaVersion: 1,
      deploymentId: options.deploymentId,
      releaseId: manifest.release.releaseId,
      configVersion: manifest.config.version,
      restoredFromBackupId: manifest.backupId,
    });
    await writeTeamRestoreHold(staging, manifest.backupId, now());

    const restoredDb = new Database(path.join(staging, 'data', 'workbench.db'));
    let recovered: Awaited<ReturnType<typeof recoverExecution>>;
    let remoteCalls = 0;
    const unknownBefore = restoredDb.prepare(`
      SELECT id FROM execution_attempts WHERE submissionState IN ('not_sent', 'maybe_sent', 'accepted')
    `).all() as Array<{ id: string }>;
    try {
      restoredDb.pragma('foreign_keys = ON');
      const journal = createExecutionJournal({ deploymentId: options.deploymentId, directory: restoredJournalDirectory });
      const executionOptions = {
        db: restoredDb,
        deploymentId: options.deploymentId,
        journal,
        actorAllowed: () => true,
        scopeAllowed: () => true,
        maintenance: () => true,
      };
      recovered = await recoverExecution(executionOptions);
      if (options.lookupRemote) {
        for (const attemptId of [...recovered.unknownAttemptIds]) {
          remoteCalls += 1;
          const evidence = await options.lookupRemote(attemptId);
          await reconcileAttempt(executionOptions, { attemptId, evidence, source: 'provider' });
        }
      }
      const final = await recoverExecution(executionOptions);
      recovered = {
        ...final,
        recoveredReceiptAttemptIds: [...new Set([
          ...recovered.recoveredReceiptAttemptIds, ...final.recoveredReceiptAttemptIds,
        ])],
      };
    } finally {
      restoredDb.close();
    }
    const unresolvedDb = new Database(path.join(staging, 'data', 'workbench.db'), { readonly: true });
    let reconciliationState: ReturnType<typeof readReconciliationState>;
    try {
      reconciliationState = readReconciliationState(unresolvedDb);
    } finally {
      unresolvedDb.close();
    }
    const unknownAttemptIds = [...new Set([
      ...reconciliationState.unknownAttemptIds,
      ...(evidenceStatus === 'unavailable' ? unknownBefore.map((row) => row.id) : []),
    ])].sort();
    const report: ReconciliationReport = {
      schemaVersion: 1,
      backupId: manifest.backupId,
      status: evidenceStatus === 'complete' && unknownAttemptIds.length === 0 && reconciliationState.orphanAttemptIds.length === 0
        ? 'reconciled' : 'hold',
      evidenceStatus,
      journalWatermark: manifest.journal.watermarkSeq,
      postWatermarkRecords: journalEvidence.records.filter((record) => record.seq > manifest.journal.watermarkSeq).length,
      unknownAttemptIds,
      orphanAttemptIds: reconciliationState.orphanAttemptIds,
      recoveredReceiptAttemptIds: recovered.recoveredReceiptAttemptIds,
      scheduling: false,
      automaticRetries: 0,
      remoteCalls,
    };
    await writeJsonAtomic(path.join(staging, 'storage', 'maintenance', 'reconciliation.json'), report);
    await fsPromises.rename(staging, restoreRoot);
    appendMaintenanceReceipt({
      backupRoot, deploymentId: options.deploymentId, kind: 'restore', operationId, phase: 'finished',
      at: now().toISOString(), details: { backupId: manifest.backupId, evidenceStatus, unknownCount: unknownAttemptIds.length },
    });
    return {
      restoreRoot,
      ...report,
    };
  } catch (error) {
    appendMaintenanceReceipt({
      backupRoot, deploymentId: options.deploymentId, kind: 'restore', operationId, phase: 'failed',
      at: now().toISOString(), details: { backupId: manifest.backupId },
    });
    if (fs.existsSync(staging)) await fsPromises.rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function recheckTeamRestore(dataRoot: string): Promise<ReconciliationReport> {
  const reportPath = path.join(dataRoot, 'storage', 'maintenance', 'reconciliation.json');
  const report = await readJsonFile<ReconciliationReport>(reportPath);
  if (report.evidenceStatus !== 'complete') return report;
  const deployment = await readJsonFile<{ deploymentId: string }>(path.join(dataRoot, 'deployment.json'));
  safeMaintenanceId(deployment.deploymentId, 'deploymentId');
  const restoredDb = new Database(path.join(dataRoot, 'data', 'workbench.db'));
  let state: ReturnType<typeof readReconciliationState>;
  let recovered: Awaited<ReturnType<typeof recoverExecution>>;
  let journalRecords: ReturnType<ReturnType<typeof createExecutionJournal>['scan']>;
  try {
    restoredDb.pragma('foreign_keys = ON');
    const journal = createExecutionJournal({
      deploymentId: deployment.deploymentId,
      directory: path.join(dataRoot, 'storage', 'execution-journal', deployment.deploymentId),
    });
    recovered = await recoverExecution({
      db: restoredDb,
      deploymentId: deployment.deploymentId,
      journal,
      actorAllowed: () => true,
      scopeAllowed: () => true,
      maintenance: () => true,
    });
    if (!recovered.available) throw new Error('恢复后的执行 journal 仍不可信，禁止解除 restore hold');
    state = readReconciliationState(restoredDb);
    journalRecords = journal.scan();
  } finally {
    restoredDb.close();
  }
  const next: ReconciliationReport = {
    ...report,
    status: state.unknownAttemptIds.length === 0 && state.orphanAttemptIds.length === 0 ? 'reconciled' : 'hold',
    postWatermarkRecords: journalRecords.filter((record) => record.seq > report.journalWatermark).length,
    unknownAttemptIds: state.unknownAttemptIds,
    orphanAttemptIds: state.orphanAttemptIds,
    recoveredReceiptAttemptIds: [...new Set([
      ...report.recoveredReceiptAttemptIds, ...recovered.recoveredReceiptAttemptIds,
    ])].sort(),
    scheduling: false,
    automaticRetries: 0,
  };
  await writeJsonAtomic(reportPath, next);
  return next;
}

export async function releaseTeamRestoreHold(options: {
  dataRoot: string;
  operatorConfirmed: boolean;
}): Promise<{ released: true }> {
  if (!options.operatorConfirmed) throw new Error('解除 restore hold 需要管理员明确确认核查完成');
  await readTeamRestoreHold(options.dataRoot);
  const report = await recheckTeamRestore(options.dataRoot);
  if (report.status !== 'reconciled' || report.evidenceStatus !== 'complete'
    || report.unknownAttemptIds.length > 0 || report.orphanAttemptIds.length > 0) {
    throw new Error('仍有 unknown 或核查证据不完整，禁止解除 restore hold');
  }
  await writeJsonAtomic(path.join(options.dataRoot, 'storage', 'maintenance', 'restore-hold-release.json'), {
    schemaVersion: 1,
    backupId: report.backupId,
    releasedAt: new Date().toISOString(),
    operatorConfirmed: true,
  });
  await fsPromises.rm(teamRestoreHoldPath(options.dataRoot), { force: false });
  return { released: true };
}
