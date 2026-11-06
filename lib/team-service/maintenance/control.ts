import type { AuthPrincipal } from '../auth/types.ts';
import { MaintenanceControlError, MaintenanceJobStore, type MaintenanceAction, type MaintenanceTarget } from './jobs.ts';
import { maintenanceGlobalLockPath, readMaintenanceExecutionConfig } from './worker.ts';
import { acquireSchemaUpgradeLock, SchemaUpgradeLockTimeoutError } from '../../schema-upgrade/lock.ts';
import path from 'node:path';
import fs from 'node:fs';
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

export function getMaintenanceJob(id: string) {
  const { store } = control();
  try { return store.get(id); } finally { store.close(); }
}

export function maintenanceAudit(jobId: string) {
  const { store } = control();
  try { return { audit: store.audit(jobId) }; } finally { store.close(); }
}

export function listMaintenanceJobs(limit?: number) {
  const { store } = control();
  try { return store.list(limit); } finally { store.close(); }
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
