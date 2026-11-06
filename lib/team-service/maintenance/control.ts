import type { AuthPrincipal } from '../auth/types.ts';
import { MaintenanceControlError, MaintenanceJobStore, type MaintenanceAction, type MaintenanceTarget } from './jobs.ts';
import { maintenanceGlobalLockPath, readMaintenanceExecutionConfig } from './worker.ts';
import { acquireSchemaUpgradeLock, SchemaUpgradeLockTimeoutError } from '../../schema-upgrade/lock.ts';
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../../db.ts';
import Database from 'better-sqlite3';
import { CleanupPreviewStore, createCleanupPreview } from './cleanup.ts';

function control() {
  const config = readMaintenanceExecutionConfig();
  return { config, store: new MaintenanceJobStore({ backupRoot: config.backupRoot, deploymentId: config.deploymentId }) };
}

function principalForMaintenance(principal: AuthPrincipal) {
  if (principal.role !== 'admin') throw new Error('仅管理员可执行维护');
  return { userId: principal.userId, employeeId: principal.employeeId, displayName: principal.displayName, role: 'admin' as const };
}

export function submitMaintenanceJob(input: {
  principal: AuthPrincipal; idempotencyKey: string; target: MaintenanceTarget; action?: MaintenanceAction;
}) {
  const { store } = control();
  try {
    return store.submit({
      action: input.action ?? 'backup.create', target: input.target,
      principal: principalForMaintenance(input.principal), idempotencyKey: input.idempotencyKey,
    });
  } finally { store.close(); }
}

export function holdProductionForRestore(principal: AuthPrincipal, jobId: string) {
  principalForMaintenance(principal);
  getDb().prepare(`UPDATE team_service_state SET maintenance = 1, reason = ?, productionPaused = 1,
    productionVersion = productionVersion + 1, productionChangedBy = ?, productionChangedAt = ?, updatedAt = ? WHERE id = 1`)
    .run(`restore:${jobId}`, principal.userId, new Date().toISOString(), new Date().toISOString());
}

export function confirmMaintenanceRestore(id: string, principal: AuthPrincipal) {
  const { store } = control();
  try { return store.confirm({ jobId: id, principal: principalForMaintenance(principal) }); } finally { store.close(); }
}

export function readRestoreActivityForAdmin() {
  const config = readMaintenanceExecutionConfig();
  const raw = JSON.parse(fs.readFileSync(config.configPath, 'utf8').replace(/^\uFEFF/, '')) as { deploymentRoot: string; dataRoot: string };
  const activityPath = path.join(raw.deploymentRoot, 'service', 'active-data-root.json');
  if (!fs.existsSync(activityPath)) return { state: 'original', activeLabel: '当前业务数据', protectedCopies: 0, recovery: null };
  const activity = JSON.parse(fs.readFileSync(activityPath, 'utf8')) as {
    state: string; operationId: string; recovery: { preRestoreBackupId: string };
  };
  return {
    state: activity.state,
    operationId: activity.operationId,
    activeLabel: activity.state === 'switched' ? '已切换至选定还原点'
      : activity.state === 'needs_review' ? '服务恢复未确认，活动状态需要现场核查' : '原业务数据仍在活动根',
    protectedCopies: activity.state === 'switched' ? 1 : 0,
    recovery: {
      preRestoreBackupId: activity.recovery.preRestoreBackupId,
      path: '受管“数据保留”目录中的旧数据根',
      message: activity.state === 'needs_review' ? '请先核查实际运行服务和活动根；不要启动另一还原。'
        : '较新数据未合并；可使用还原前备份或受保护旧根发起后续受控恢复。',
    },
  };
}

function publicMaintenanceJob(job: import('./jobs.ts').MaintenanceJob) {
  if (job.action !== 'restore.execute' || !job.result) return job;
  const activity = job.result.activity as { state?: string; recovery?: { preRestoreBackupId?: string; message?: string } } | undefined;
  if (!activity) return job;
  return { ...job, result: { ...job.result, activity: {
    state: activity.state,
    activeLabel: activity.state === 'switched' ? '选定还原点' : '原业务数据',
    protectedCopies: activity.state === 'switched' ? 1 : 0,
    recovery: {
      preRestoreBackupId: activity.recovery?.preRestoreBackupId,
      path: '受管“数据保留”目录中的旧数据根',
      message: activity.recovery?.message,
    },
  } } };
}

export function getMaintenanceJob(id: string) {
  const { store } = control();
  try { return { job: publicMaintenanceJob(store.get(id).job) }; } finally { store.close(); }
}

export function maintenanceAudit(jobId: string) {
  const { store } = control();
  try { return { audit: store.audit(jobId) }; } finally { store.close(); }
}

export function listMaintenanceJobs(limit?: number) {
  const { store } = control();
  try { return { jobs: store.list(limit).jobs.map(publicMaintenanceJob) }; } finally { store.close(); }
}

function managedCleanupRoots() {
  const deploymentRoot = process.env.CREATIVE_STUDIO_MAINTENANCE_DEPLOYMENT_ROOT;
  if (!deploymentRoot || !path.isAbsolute(deploymentRoot)) throw new Error('缺少受管部署根');
  const config = JSON.parse(requireReadFile(path.join(deploymentRoot, 'config', 'maintenance-deployment.json'))) as {
    dataRoot: string; oldRoots?: string[];
  };
  if (!config.dataRoot || !path.isAbsolute(config.dataRoot) || !Array.isArray(config.oldRoots)
    || config.oldRoots.some((root) => typeof root !== 'string' || !path.isAbsolute(root))) throw new Error('受管数据根配置无效');
  return config as { dataRoot: string; oldRoots: string[] };
}
function requireReadFile(filePath: string): string {
  // 配置路径只来自受管环境，不来自浏览器请求。
  return fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
}
export async function scanCleanupForAdministrator(principal: AuthPrincipal) {
  principalForMaintenance(principal);
  const { backupRoot } = readMaintenanceExecutionConfig();
  let lock: { release(): void };
  try { lock = await acquireSchemaUpgradeLock({ lockDatabasePath: maintenanceGlobalLockPath(backupRoot), timeoutMs: 100 }); }
  catch (error) {
    if (error instanceof SchemaUpgradeLockTimeoutError) throw new MaintenanceControlError('maintenance_conflict', '另一维护操作正在执行，请稍后再扫描。');
    throw error;
  }
  const roots = managedCleanupRoots();
  const db = new Database(path.join(roots.dataRoot, 'data', 'workbench.db'), { readonly: true, fileMustExist: true });
  try {
    return { preview: createCleanupPreview({ db, backupRoot, storageRoot: path.join(roots.dataRoot, 'storage'), protectedDataRoots: [roots.dataRoot, ...roots.oldRoots] }) };
  } finally { db.close(); lock.release(); }
}
export function getCleanupPreviewForAdministrator(principal: AuthPrincipal, previewId: string) {
  principalForMaintenance(principal);
  const { backupRoot } = readMaintenanceExecutionConfig();
  const store = new CleanupPreviewStore(backupRoot);
  try { return { preview: store.get(previewId) }; } finally { store.close(); }
}
function safePreviewId(previewId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(previewId) || previewId.includes('..')) {
    throw new MaintenanceControlError('invalid_target', '清理预览标识无效。');
  }
}
export function bindCleanupForAdministrator(principal: AuthPrincipal, previewId: string): void {
  principalForMaintenance(principal);
  safePreviewId(previewId);
  const { backupRoot } = readMaintenanceExecutionConfig();
  const store = new CleanupPreviewStore(backupRoot);
  try { store.bind(previewId, principal.userId); } finally { store.close(); }
}
