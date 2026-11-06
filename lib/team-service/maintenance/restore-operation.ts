import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createTeamBackup, verifyTeamBackup } from './backup.ts';
import { restoreTeamBackup } from './restore.ts';
import { cutoverTeamRestore, readTeamRestoreActivity, type TeamRestoreActivity } from './restore-cutover.ts';
import { ensureServerDeploymentMarker } from '../config.ts';
import { assertNoSymlinkPath, assertSafeRelativePath, sha256File, writeJsonAtomic } from './paths.ts';
import type { MaintenanceJob } from './jobs.ts';

export interface RestoreDeployment {
  deploymentId: string;
  deploymentRoot: string;
  dataRoot: string;
  backupRoot: string;
  serviceRoot: string;
  appPort: number;
  origin: string;
}

export type RestoreStage = 'starting' | 'snapshotting' | 'copying_media' | 'verifying' | 'awaiting_confirmation' | 'cutting_over' | 'finishing';

async function verifyRestoredBusiness(root: string, manifestFiles: Array<{ fileId: string; relativePath: string; sha256: string }>, current?: Database.Database) {
  const db = new Database(path.join(root, 'data', 'workbench.db'), { readonly: true, fileMustExist: true });
  try {
    if (db.pragma('integrity_check', { simple: true }) !== 'ok' || (db.pragma('foreign_key_check') as unknown[]).length > 0) {
      throw new Error('还原数据库最终完整性或外键校验失败');
    }
    if (current) {
      for (const table of ['team_schema_migrations', 'execution_schema_migrations']) {
        const currentVersion = current.prepare(`SELECT MAX(version) FROM ${table}`).pluck().get() as number | null;
        const restoredVersion = db.prepare(`SELECT MAX(version) FROM ${table}`).pluck().get() as number | null;
        if (!currentVersion || !restoredVersion || restoredVersion > currentVersion) throw new Error('还原数据库 schema 与当前版本不兼容');
      }
    }
    const files = db.prepare("SELECT id, relativePath, byteSize, sha256 FROM team_files WHERE state IN ('ready', 'purge_pending')")
      .all() as Array<{ id: string; relativePath: string; byteSize: number; sha256: string }>;
    if (files.length !== manifestFiles.length) throw new Error('还原文件登记与备份清单不一致');
    for (const file of files) {
      const expected = manifestFiles.find((entry) => entry.fileId === file.id);
      if (!expected || expected.relativePath !== file.relativePath || expected.sha256 !== file.sha256) throw new Error('还原文件引用身份不符');
      const filePath = path.join(root, 'storage', ...assertSafeRelativePath(file.relativePath).split('/'));
      assertNoSymlinkPath(filePath);
      if ((await fs.promises.stat(filePath)).size !== file.byteSize || await sha256File(filePath) !== file.sha256) {
        throw new Error('还原文件内容校验失败');
      }
      const references = db.prepare('SELECT COUNT(*) FROM team_file_references WHERE fileId = ? AND releasedAt IS NULL')
        .pluck().get(file.id) as number;
      if (references === 0) throw new Error('还原文件缺少有效业务引用');
    }
  } finally { db.close(); }
}

export async function executeTeamRestoreOperation(options: {
  job: MaintenanceJob;
  configPath: string;
  config: RestoreDeployment;
  currentRelease: { releaseId: string; packageSha256: string };
  onStage: (stage: RestoreStage) => void;
  protectConfig: (filePath: string) => Promise<void>;
  activate: (restoredDataRoot: string) => Promise<void>;
  beforeMove?: () => Promise<void>;
  rollbackService?: () => Promise<void>;
  reauthenticatedSession?: { tokenHash: string; principal: { userId: string; sessionId: string; sessionVersion: number; absoluteExpiresAt: string } };
  diskSpaceProbe?: (directory: string) => Promise<number>;
}): Promise<{ awaitingConfirmation: true; preRestoreBackupId: string; reconciliation: { status: string; evidenceStatus: string; unknownAttemptIds: string[] } } | { awaitingConfirmation: false; activity: TeamRestoreActivity }> {
  const { job, config } = options;
  if (job.action !== 'restore.execute' || job.target.kind !== 'restore') throw new Error('维护作业目标不是整套还原');
  if (fs.existsSync(path.join(config.serviceRoot, 'active-data-root.json'))) {
    const previous = await readTeamRestoreActivity(config.serviceRoot);
    if (previous.state === 'needs_review') throw new Error('上次切换恢复状态未核实，拒绝开始另一还原');
  }
  const selected = await verifyTeamBackup(path.join(config.backupRoot, job.target.backupType, job.target.backupId));
  if (!selected.verified || selected.manifest.deploymentId !== config.deploymentId) {
    throw new Error('所选备份未通过完整性校验，已停止还原');
  }
  if (selected.manifest.release.releaseId !== options.currentRelease.releaseId
    || selected.manifest.release.packageSha256 !== options.currentRelease.packageSha256) {
    throw new Error('所选备份版本与当前受管发布不兼容，已停止还原');
  }
  // 控制记录留在 deploymentRoot；数据候选与旧根放在独立受管根，绝不覆盖部署根或备份根。
  const operationRoot = path.join(path.dirname(config.dataRoot), '.restore-data', job.id);
  const statePath = path.join(operationRoot, 'state.json');
  const controlRoot = path.join(config.deploymentRoot, 'restore-operations', job.id);
  const overlayPath = path.join(controlRoot, 'authorization-overlay.json');
  if (fs.existsSync(statePath)) {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as { phase?: string; [key: string]: unknown };
    if (state.phase === 'awaiting_confirmation' && job.stage !== 'cutting_over') return state as never;
    if (state.phase === 'switched') throw new Error('该还原已经切换，拒绝重复执行');
  }
  const db = new Database(path.join(config.dataRoot, 'data', 'workbench.db'), { fileMustExist: true });
  try {
    db.pragma('foreign_keys = ON');
    db.prepare(`UPDATE team_service_state SET maintenance = 1, reason = ?, productionPaused = 1,
      productionChangedBy = ?, productionChangedAt = ?, updatedAt = ? WHERE id = 1`)
      .run(`restore:${job.id}`, job.requestedBy.userId, new Date().toISOString(), new Date().toISOString());
    if (job.stage === 'cutting_over' && job.result) {
      const prepared = job.result as { preRestoreBackupId?: string };
      if (!prepared.preRestoreBackupId) throw new Error('确认后的还原作业缺少还原前备份身份');
      options.onStage('cutting_over');
      const session = options.reauthenticatedSession;
      if (!session) throw new Error('缺少受控重新认证，拒绝切换');
      const restoredPath = path.join(operationRoot, 'restored');
      await verifyRestoredBusiness(restoredPath, selected.manifest.files, db);
      const restoredDb = new Database(path.join(restoredPath, 'data', 'workbench.db'));
      try {
        const overlay = JSON.parse(fs.readFileSync(overlayPath, 'utf8')) as {
          users: Array<{ id: string; status: 'active' | 'disabled'; sessionVersion: number; passwordHash: string;
            mustChangePassword: number; credentialExpiresAt: string | null; credentialConsumedAt: string | null }>;
        };
        const currentUser = db.prepare('SELECT status, sessionVersion FROM team_users WHERE id = ?')
          .get(session.principal.userId) as { status: string; sessionVersion: number } | undefined;
        if (!currentUser || currentUser.status !== 'active') throw new Error('当前管理员已停用，拒绝切换');
        const principalRow = restoredDb.prepare("SELECT sessionVersion, status, role FROM team_users WHERE id = ?")
          .get(session.principal.userId) as { sessionVersion: number; status: string; role: string } | undefined;
        if (!principalRow || principalRow.status !== 'active' || principalRow.role !== 'admin') throw new Error('发起还原的管理员在还原点不可用');
        const protect = restoredDb.transaction(() => {
          for (const user of overlay.users) {
            restoredDb.prepare(`UPDATE team_users SET status = CASE WHEN ? = 'disabled' THEN 'disabled' ELSE status END,
              sessionVersion = MAX(sessionVersion, ?), passwordHash = ?, mustChangePassword = ?,
              credentialExpiresAt = ?, credentialConsumedAt = ? WHERE id = ?`)
              .run(user.status, user.sessionVersion, user.passwordHash, user.mustChangePassword,
                user.credentialExpiresAt, user.credentialConsumedAt, user.id);
          }
          restoredDb.prepare('UPDATE team_users SET sessionVersion = MAX(sessionVersion, ?) WHERE id = ?')
            .run(currentUser.sessionVersion, session.principal.userId);
          restoredDb.prepare('UPDATE team_sessions SET revokedAt = ? WHERE revokedAt IS NULL')
            .run(new Date().toISOString());
          const nextVersion = Math.max(principalRow.sessionVersion, currentUser.sessionVersion, session.principal.sessionVersion);
          restoredDb.prepare('UPDATE team_users SET sessionVersion = ? WHERE id = ?').run(nextVersion, session.principal.userId);
          restoredDb.prepare(`INSERT INTO team_sessions (id, tokenHash, userId, sessionVersion, createdAt, absoluteExpiresAt, revokedAt)
            VALUES (?, ?, ?, ?, ?, ?, NULL)`).run(session.principal.sessionId, session.tokenHash, session.principal.userId,
              nextVersion, new Date().toISOString(), session.principal.absoluteExpiresAt);
        });
        protect.immediate();
        if (restoredDb.pragma('integrity_check', { simple: true }) !== 'ok'
          || (restoredDb.pragma('foreign_key_check') as unknown[]).length > 0) throw new Error('会话保护写入后数据库校验失败');
      } finally { restoredDb.close(); }
      // 外部执行器必须在移动受管目录前关闭自身连接；真实适配器还会先停止应用。
      db.close();
      const activity = await cutoverTeamRestore({
        serviceRoot: config.serviceRoot,
        activeDataRoot: config.dataRoot,
        restoredDataRoot: path.join(operationRoot, 'restored'),
        protectedDataRoot: path.join(operationRoot, 'protected-old-root'),
        deploymentId: config.deploymentId,
        operationId: job.id,
        backupId: prepared.preRestoreBackupId,
        activate: options.activate,
        beforeMove: options.beforeMove,
        rollbackService: options.rollbackService,
      });
      await writeJsonAtomic(statePath, { schemaVersion: 1, phase: 'switched', preRestoreBackupId: prepared.preRestoreBackupId });
      options.onStage('finishing');
      return { awaitingConfirmation: false, activity };
    }
    options.onStage('starting');
    fs.mkdirSync(path.dirname(operationRoot), { recursive: true, mode: 0o700 });
    fs.mkdirSync(operationRoot, { recursive: false, mode: 0o700 });
    await writeJsonAtomic(overlayPath, {
      schemaVersion: 1,
      users: db.prepare('SELECT id, status, sessionVersion, passwordHash, mustChangePassword, credentialExpiresAt, credentialConsumedAt FROM team_users').all(),
      revokedSessionIds: db.prepare('SELECT id FROM team_sessions WHERE revokedAt IS NOT NULL').all(),
      capturedAt: new Date().toISOString(),
    });
    await options.protectConfig(overlayPath);
    const backup = await createTeamBackup({
      db, principal: job.requestedBy, dataRoot: config.dataRoot, storageRoot: path.join(config.dataRoot, 'storage'),
      backupRoot: config.backupRoot, deploymentId: config.deploymentId, type: 'pre-restore',
      release: options.currentRelease, config: { filePath: options.configPath }, backupId: `${job.id}-pre-restore`,
      protectConfig: options.protectConfig, diskSpaceProbe: options.diskSpaceProbe,
      onStage: (stage) => options.onStage(stage),
    });
    options.onStage('verifying');
    const restored = await restoreTeamBackup({
      backupDirectory: path.join(config.backupRoot, job.target.backupType, job.target.backupId),
      restoreRoot: path.join(operationRoot, 'restored'), deploymentId: config.deploymentId,
      expectedReleaseId: options.currentRelease.releaseId, currentDb: db,
      operationId: job.id,
      currentJournalDirectory: path.join(config.dataRoot, 'storage', 'execution-journal', config.deploymentId),
      protectConfig: options.protectConfig,
    });
    await verifyRestoredBusiness(restored.restoreRoot, selected.manifest.files, db);
    ensureServerDeploymentMarker({
      mode: 'server', dataRoot: restored.restoreRoot, hostname: '127.0.0.1', port: config.appPort,
      deploymentId: config.deploymentId, trustedOrigin: config.origin,
    });
    const result = {
      awaitingConfirmation: true as const,
      preRestoreBackupId: backup.manifest.backupId,
      restorePoint: selected.manifest.createdAt,
      scope: ['projects', 'resources', 'tasks', 'files', 'execution-references'],
      reconciliation: {
        status: restored.status, evidenceStatus: restored.evidenceStatus,
        unknownAttemptIds: restored.unknownAttemptIds, scheduling: false, automaticRetries: 0,
      },
      compatibility: { releaseId: options.currentRelease.releaseId, verified: true, schema: 'compatible' },
      protectedInfrastructure: ['certificates', 'service-accounts', 'deployment-secrets', 'operating-system'],
    };
    await writeJsonAtomic(statePath, { schemaVersion: 1, phase: 'awaiting_confirmation', ...result });
    options.onStage('awaiting_confirmation');
    return result;
  } finally {
    db.close();
  }
}
