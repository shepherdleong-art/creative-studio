import type { AuthPrincipal } from '../auth/types.ts';
import { MaintenanceJobStore, type MaintenanceAction, type MaintenanceTarget } from './jobs.ts';
import { readMaintenanceExecutionConfig } from './worker.ts';
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../../db.ts';

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
