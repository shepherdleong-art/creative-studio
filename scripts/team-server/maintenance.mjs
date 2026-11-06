#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { resolveDeploymentConfig } from './generate-config.mjs';
import { sha256File, verifyReleaseManifest } from './distribution.mjs';
import { runControlledServiceAction } from './service-control.mjs';
import { createTeamBackup, verifyTeamBackup } from '../../lib/team-service/maintenance/backup.ts';
import { MaintenanceJobStore } from '../../lib/team-service/maintenance/jobs.ts';
import { runMaintenanceWorker, maintenanceGlobalLockPath } from '../../lib/team-service/maintenance/worker.ts';
import { acquireSchemaUpgradeLock } from '../../lib/schema-upgrade/lock.ts';
import { restoreTeamBackup } from '../../lib/team-service/maintenance/restore.ts';
import { runTeamRelease, rollbackTeamRelease, readTeamReleasePointer, switchTeamReleasePointerIdempotent } from '../../lib/team-service/maintenance/release.ts';
import { acquireLifecycleBarrier, releaseLifecycleBarrier } from '../../lib/team-service/lifecycle/index.ts';
import { createExecutionJournal } from '../../lib/media-core/execution/journal.ts';
import { executeCleanupPreview } from '../../lib/team-service/maintenance/cleanup.ts';

const args = process.argv.slice(2);
const command = args[0];
function argument(name, fallback = '') {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}
function required(name) {
  const value = argument(name);
  if (!value) throw new Error(`缺少 ${name}`);
  return value;
}
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}
function safeId(value) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) || value.includes('..')) throw new Error('维护标识无效');
  return value;
}
function openDatabase(dataRoot, readonly = false) {
  const db = new Database(path.join(dataRoot, 'data', 'workbench.db'), { readonly, fileMustExist: true });
  db.pragma('foreign_keys = ON');
  return db;
}
function adminPrincipal(db) {
  const row = db.prepare("SELECT id FROM team_users WHERE role = 'admin' AND status = 'active' ORDER BY createdAt LIMIT 1").get();
  if (!row) throw new Error('没有可用于维护的有效管理员');
  return { userId: row.id, role: 'admin' };
}
function releaseIdentity(config, releaseId, allowFixture = false) {
  safeId(releaseId);
  const releaseRoot = path.join(config.deploymentRoot, 'releases', releaseId);
  verifyReleaseManifest(releaseRoot, { allowFixture });
  return {
    releaseId,
    packageSha256: sha256File(path.join(releaseRoot, 'release-manifest.json')),
  };
}
async function currentReleaseIdentity(config) {
  const pointer = path.join(config.serviceRoot, 'current-release.json');
  if (!fs.existsSync(pointer)) return releaseIdentity(config, config.releaseId, args.includes('--allow-fixture-release'));
  const current = await readTeamReleasePointer(config.serviceRoot);
  const verified = releaseIdentity(config, current.releaseId, args.includes('--allow-fixture-release'));
  if (verified.packageSha256 !== current.packageSha256) throw new Error('当前 release 指针与不可变包哈希不符');
  return verified;
}
function credential(config) {
  const file = config.controlCredentialFile;
  if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw new Error('控制凭据必须是受保护普通文件');
  return readJson(file);
}
function serviceAccountText(config) {
  return typeof config.serviceAccount === 'string'
    ? config.serviceAccount
    : `${config.serviceAccount.domain}\\${config.serviceAccount.user}`;
}
function resolvedFor(config, releaseId = config.releaseId) {
  return resolveDeploymentConfig({ ...config, releaseId, serviceAccount: serviceAccountText(config) });
}
async function controlled(action, config, releaseId = config.releaseId) {
  return runControlledServiceAction({
    action,
    config: resolvedFor(config, releaseId),
    credential: credential(resolvedFor(config)),
    apply: true,
    forceAfterTimeout: action === 'stop',
  });
}
function startApp(config) {
  if (process.platform !== 'win32') throw new Error('SCM 启动只可在目标 Windows 主机显式执行');
  const app = resolvedFor(config).services.find((service) => service.role === 'app');
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    'Start-Service -Name $env:CREATIVE_STUDIO_EXACT_APP_SERVICE -ErrorAction Stop',
  ], {
    encoding: 'utf8', windowsHide: true, timeout: 30_000,
    env: { ...process.env, CREATIVE_STUDIO_EXACT_APP_SERVICE: app.id },
  });
  if (result.status !== 0) throw new Error('精确 app SCM 服务启动失败');
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitService(config, releaseId, expected) {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    try {
      const status = await controlled('status', config, releaseId);
      if (expected === 'maintenance' && status.maintenance === true && status.ready === false) return status;
      if (expected === 'ready' && status.maintenance === false && status.ready === true) return status;
    } catch {}
    await delay(500);
  }
  throw new Error(`服务未进入 ${expected} 状态`);
}
function protectConfig(config) {
  return async (file) => {
    if (process.platform !== 'win32') {
      fs.chmodSync(file, 0o600);
      return;
    }
    const account = serviceAccountText(config);
    const identity = spawnSync('whoami.exe', [], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    if (identity.status !== 0 || !identity.stdout.trim()) throw new Error('无法确认当前维护账号，拒绝设置配置 ACL');
    const result = spawnSync('icacls.exe', [
      file, '/inheritance:r', '/grant:r', `${identity.stdout.trim()}:F`,
      '*S-1-5-18:F', '*S-1-5-32-544:F', `${account}:R`,
    ], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
    if (result.status !== 0) throw new Error('秘密配置副本 ACL 设置失败');
  };
}
function latestRecoveryEvidence(config) {
  const file = path.join(config.backupRoot, 'maintenance-receipts', `${config.deploymentId}.jsonl`);
  if (!fs.existsSync(file)) return null;
  const records = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean)
    .map((line) => JSON.parse(line));
  const recovery = records.reverse().find((record) => record.kind === 'restore' && record.phase === 'finished');
  return recovery ? { at: recovery.at, backupId: recovery.backupId, evidenceStatus: recovery.evidenceStatus } : null;
}
function writeDailyJob(config, value) {
  const file = path.join(config.backupRoot, 'daily-job.json');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({
    schemaVersion: 1,
    latestRecoveryEvidence: latestRecoveryEvidence(config),
    ...value,
  }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, file);
}
function backupDirectory(config, type, backupId) {
  safeId(backupId);
  if (!['daily', 'manual', 'pre-upgrade', 'pre-restore'].includes(type)) throw new Error('备份类型无效');
  const root = path.resolve(config.backupRoot, type);
  const directory = path.resolve(root, backupId);
  if (path.dirname(directory).toLowerCase() !== root.toLowerCase()) throw new Error('备份路径越界');
  return directory;
}
function acquireDailyLock(config) {
  const directory = path.join(config.backupRoot, 'locks');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'daily.lock');
  const staleBefore = Date.now() - 12 * 60 * 60 * 1000;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, `${JSON.stringify({ schemaVersion: 1, pid: process.pid, startedAt: new Date().toISOString() })}\n`);
      } finally {
        fs.closeSync(fd);
      }
      return () => fs.rmSync(file, { force: true });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let stale = false;
      try {
        const stat = fs.statSync(file);
        stale = stat.mtimeMs < staleBefore;
      } catch {}
      if (!stale || attempt > 0) return null;
      fs.rmSync(file, { force: true });
    }
  }
  return null;
}
function compatibilityReport(file) {
  if (!file) throw new Error('更新/兼容回切必须提供隔离验证兼容性报告');
  const report = readJson(path.resolve(file));
  if (report.isolatedVerified !== true || typeof report.schemaCompatible !== 'boolean'
    || typeof report.irreversibleChanges !== 'boolean') throw new Error('兼容性报告缺少隔离验证或兼容结论');
  return report;
}
function setMaintenance(db, maintenance, reason) {
  db.prepare('UPDATE team_service_state SET maintenance = ?, reason = ?, updatedAt = ? WHERE id = 1')
    .run(maintenance ? 1 : 0, reason, new Date().toISOString());
}
function captureExecution(config, db, operationId) {
  const journal = createExecutionJournal({
    deploymentId: config.deploymentId,
    directory: path.join(config.dataRoot, 'storage', 'execution-journal', config.deploymentId),
  });
  const records = journal.scan();
  const evidence = {
    schemaVersion: 1,
    operationId,
    capturedAt: new Date().toISOString(),
    operations: db.prepare('SELECT * FROM execution_operations').all(),
    attempts: db.prepare('SELECT * FROM execution_attempts').all(),
    reservations: db.prepare('SELECT * FROM execution_reservations').all(),
    journalRecords: records,
  };
  const directory = path.join(config.deploymentRoot, 'service', 'maintenance-evidence');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${safeId(operationId)}.json`);
  if (fs.existsSync(file)) {
    const existing = readJson(file);
    if (existing.operationId !== operationId || !Array.isArray(existing.operations)) throw new Error('既有执行证据身份不符');
    return { evidenceSha256: sha256File(file), operationCount: existing.operations.length };
  }
  fs.writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return { evidenceSha256: sha256File(file), operationCount: evidence.operations.length };
}
async function drain(db) {
  for (let attempt = 0; attempt < 480; attempt += 1) {
    const pendingTasks = db.prepare("SELECT COUNT(*) AS count FROM execution_attempts WHERE submissionState IN ('not_sent', 'maybe_sent', 'accepted')").pluck().get();
    if (pendingTasks === 0) {
      const unknownAttemptIds = db.prepare("SELECT currentAttemptId AS id FROM execution_operations WHERE status = 'unknown' AND currentAttemptId IS NOT NULL")
        .all().map((row) => row.id);
      return { pendingTasks: 0, unknownAttemptIds };
    }
    await delay(250);
  }
  return { pendingTasks: 1, unknownAttemptIds: [] };
}
async function makeBackup(config, db, principal, type, backupId, configPath, reuseExisting = false, lockAlreadyHeld = false, onStage) {
  const lock = lockAlreadyHeld ? null : await acquireSchemaUpgradeLock({ lockDatabasePath: maintenanceGlobalLockPath(config.backupRoot), timeoutMs: 100 });
  try {
  const release = await currentReleaseIdentity(config);
  if (backupId && reuseExisting) {
    const directory = backupDirectory(config, type, backupId);
    if (fs.existsSync(directory)) {
      const verification = await verifyTeamBackup(directory);
      if (!verification.verified || verification.manifest.deploymentId !== config.deploymentId
        || verification.manifest.release.releaseId !== release.releaseId
        || verification.manifest.release.packageSha256 !== release.packageSha256) {
        throw new Error('既有 pre-upgrade 备份身份或完整性不符，拒绝复用');
      }
      return {
        directory,
        manifest: verification.manifest,
        success: readJson(path.join(directory, 'success.json')),
      };
    }
  }
  return createTeamBackup({
    db, principal, dataRoot: config.dataRoot, storageRoot: path.join(config.dataRoot, 'storage'),
    backupRoot: config.backupRoot, deploymentId: config.deploymentId, type,
    release: async () => {
      const pointer = path.join(config.serviceRoot, 'current-release.json');
      if (fs.existsSync(pointer)) {
        const current = await readTeamReleasePointer(config.serviceRoot);
        if (current.releaseId !== release.releaseId || current.packageSha256 !== release.packageSha256) {
          throw new Error('备份屏障建立前 current release 已变化，拒绝混用快照身份');
        }
      }
      return release;
    },
    config: { filePath: configPath }, ...(backupId ? { backupId } : {}),
    protectConfig: protectConfig(config),
    ...(args.includes('--test-disk-space-zero') ? { diskSpaceProbe: async () => 0 } : {}),
    ...(onStage ? { onStage } : {}),
  });
  } finally { lock?.release(); }
}
async function resumeService(config, db, releaseId) {
  setMaintenance(db, false, '');
  const stopped = await controlled('stop', config, releaseId);
  if (!stopped.stopped) throw new Error('恢复接单前旧维护实例未退出');
  startApp({ ...config, releaseId });
  await waitService(config, releaseId, 'ready');
}

try {
  const configPath = path.resolve(required('--config'));
  const config = resolveDeploymentConfig(readJson(configPath));
  if (command === 'worker') {
    await runMaintenanceWorker({
      configPath,
      once: args.includes('--once'),
      jobId: argument('--job-id') || undefined,
      executeCleanup: async (job) => {
        if (job.target.kind !== 'cleanup') throw new Error('维护作业目标不是清理预览');
        const workerDb = openDatabase(config.dataRoot);
        try {
          return executeCleanupPreview({
            db: workerDb, previewId: job.target.previewId, storageRoot: path.join(config.dataRoot, 'storage'),
            backupRoot: config.backupRoot, protectedDataRoots: [config.dataRoot, ...(config.oldRoots ?? [])],
          });
        } finally { workerDb.close(); }
      },
      makeBackup: async ({ job, backupId, onStage }) => {
        const workerDb = openDatabase(config.dataRoot);
        try {
          if (job.target.kind !== 'backup') throw new Error('维护作业目标不是备份');
          const principal = job.requestedBy;
          const backupType = job.target.backupType;
          const result = await makeBackup(config, workerDb, principal, backupType, backupId, configPath, false, true, onStage);
          const verified = await verifyTeamBackup(result.directory);
          if (!verified.verified || verified.manifest.backupId !== result.manifest.backupId) throw new Error('备份作业结果复核失败');
          onStage('verifying');
          return {
            backupId: result.manifest.backupId, type: result.manifest.type,
            verifiedAt: result.success.verifiedAt, totalBytes: result.success.totalBytes,
          };
        } finally { workerDb.close(); }
      },
    });
    process.stdout.write(`${JSON.stringify({ status: 'success', worker: true })}\n`);
  } else {
  const db = openDatabase(config.dataRoot);
  try {
    const principal = adminPrincipal(db);
    if (command === 'backup') {
      const type = required('--type');
      const backupId = argument('--backup-id');
      const releaseLock = type === 'daily' ? acquireDailyLock(config) : null;
      if (type === 'daily' && !releaseLock) {
        process.stdout.write(`${JSON.stringify({ status: 'skipped', reason: 'backup_in_progress' })}\n`);
        process.exit(0);
      }
      const startedAt = new Date().toISOString();
      try {
        if (type === 'daily') writeDailyJob(config, { status: 'running', backupId: backupId || null, startedAt });
        try {
          const result = await makeBackup(config, db, principal, type, backupId, configPath);
          if (type === 'daily') {
            const space = fs.statfsSync(config.backupRoot);
            writeDailyJob(config, {
              status: 'success', backupId: result.manifest.backupId, startedAt,
              finishedAt: result.success.verifiedAt, durationMs: result.success.durationMs,
              totalBytes: result.success.totalBytes, availableBytes: space.bavail * space.bsize,
            });
          }
          process.stdout.write(`${JSON.stringify({
            status: 'success', backupId: result.manifest.backupId, backupType: type,
            durationMs: result.success.durationMs, totalBytes: result.success.totalBytes,
            rotation: result.rotation ?? null,
          })}\n`);
        } catch (error) {
          if (type === 'daily') writeDailyJob(config, {
            status: 'failed', backupId: backupId || null, startedAt,
            finishedAt: new Date().toISOString(), code: 'backup_failed',
          });
          throw error;
        }
      } finally {
        releaseLock?.();
      }
    } else if (command === 'restore') {
      const type = required('--backup-type');
      const backupId = required('--backup-id');
      const currentRelease = await currentReleaseIdentity(config);
      const result = await restoreTeamBackup({
        backupDirectory: backupDirectory(config, type, backupId),
        restoreRoot: required('--restore-root'), deploymentId: config.deploymentId,
        expectedReleaseId: currentRelease.releaseId, currentDb: db,
        currentJournalDirectory: path.join(config.dataRoot, 'storage', 'execution-journal', config.deploymentId),
        protectConfig: protectConfig(config),
      });
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else if (command === 'release' || command === 'rollback') {
      const newReleaseId = required('--new-release-id');
      const operationId = safeId(required('--operation-id'));
      const current = await currentReleaseIdentity(config);
      const target = releaseIdentity(config, newReleaseId, args.includes('--allow-fixture-release'));
      const fromRelease = command === 'release' ? current : current;
      const toRelease = target;
      const reportPath = argument('--compatibility-report');
      if (command === 'release') compatibilityReport(reportPath);
      const releaseAdapters = {
        async preflight() { releaseIdentity(config, toRelease.releaseId, args.includes('--allow-fixture-release')); },
        async enterMaintenance() { setMaintenance(db, true, `maintenance:${operationId}`); },
        async drainInflight() { return drain(db); },
        async captureExecution() { return captureExecution(config, db, operationId); },
        async stopOldInstance() { return controlled('stop', config, fromRelease.releaseId); },
        async createPreUpgradeBackup() {
          const backup = await makeBackup(config, db, principal, 'pre-upgrade', `${operationId}-pre-upgrade`, configPath, true);
          return { backupId: backup.manifest.backupId, verified: true };
        },
        async switchRelease() {
          const barrier = acquireLifecycleBarrier(db, principal, 'release', { operationId, releaseId: toRelease.releaseId });
          try {
            await switchTeamReleasePointerIdempotent({
              serviceRoot: config.serviceRoot, release: toRelease, expectedReleaseId: fromRelease.releaseId,
            });
          } finally {
            releaseLifecycleBarrier(db, principal, barrier.id);
          }
        },
        async startMaintenance() {
          const { generateDeploymentConfiguration } = await import('./generate-config.mjs');
          generateDeploymentConfiguration({ ...readJson(configPath), releaseId: toRelease.releaseId }, config.serviceRoot);
          startApp({ ...config, releaseId: toRelease.releaseId });
          await waitService(config, toRelease.releaseId, 'maintenance');
        },
        async migrate() {
          const team = db.prepare('SELECT MAX(version) AS version FROM team_schema_migrations').pluck().get();
          const execution = db.prepare('SELECT MAX(version) AS version FROM execution_schema_migrations').pluck().get();
          if (!team || !execution) throw new Error('追加迁移证据不完整');
        },
        async selfCheck() {
          const status = await controlled('status', config, toRelease.releaseId);
          const integrity = db.pragma('integrity_check', { simple: true });
          return { available: status.maintenance === true && status.ready === false && integrity === 'ok', automaticRetries: 0 };
        },
        async resume() { await resumeService(config, db, toRelease.releaseId); },
      };
      if (command === 'release') {
        const result = await runTeamRelease({
          operationId, deploymentId: config.deploymentId, backupRoot: config.backupRoot,
          stateDirectory: config.serviceRoot, fromRelease, toRelease, adapters: releaseAdapters,
        });
        process.stdout.write(`${JSON.stringify(result)}\n`);
      } else {
        const strategy = required('--strategy');
        const compatibility = strategy === 'compatible'
          ? compatibilityReport(reportPath)
          : { schemaCompatible: false, irreversibleChanges: true };
        const result = await rollbackTeamRelease({
          operationId, deploymentId: config.deploymentId, backupRoot: config.backupRoot,
          stateDirectory: config.serviceRoot, strategy, compatibility,
          currentRelease: current, targetRelease: target,
          adapters: {
            stopCurrentInstance: releaseAdapters.stopOldInstance,
            switchRelease: releaseAdapters.switchRelease,
            startMaintenance: releaseAdapters.startMaintenance,
            selfCheck: releaseAdapters.selfCheck,
            resume: releaseAdapters.resume,
            async restoreBackup() {
              const restored = await restoreTeamBackup({
                backupDirectory: backupDirectory(config, required('--backup-type'), required('--backup-id')),
                restoreRoot: required('--restore-root'), deploymentId: config.deploymentId,
                expectedReleaseId: target.releaseId, currentDb: db,
                currentJournalDirectory: path.join(config.dataRoot, 'storage', 'execution-journal', config.deploymentId),
                protectConfig: protectConfig(config),
              });
              return { restoreRoot: restored.restoreRoot, scheduling: restored.scheduling, automaticRetries: restored.automaticRetries };
            },
          },
        });
        process.stdout.write(`${JSON.stringify(result)}\n`);
      }
    } else {
      throw new Error('未知维护命令');
    }
  } finally {
    db.close();
  }
  }
} catch (error) {
  const message = error instanceof Error ? error.message : '未知错误';
  process.stderr.write(`维护操作失败：${message}\n`);
  process.exitCode = 1;
}
