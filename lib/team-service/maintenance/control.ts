import type { AuthPrincipal } from '../auth/types.ts';
import { MaintenanceJobStore, type MaintenanceAction, type MaintenanceTarget } from './jobs.ts';
import { readMaintenanceExecutionConfig } from './worker.ts';

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
