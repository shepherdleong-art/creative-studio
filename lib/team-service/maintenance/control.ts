import type { AuthPrincipal } from '../auth/types.ts';
import { MaintenanceControlError, MaintenanceJobStore, type MaintenanceAction, type MaintenanceTarget } from './jobs.ts';
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

export async function submitTeamReleaseExecution(input: {
  principal: AuthPrincipal; candidateId: string; idempotencyKey: string;
  confirmation: { expectedReleaseId: string; targetAppVersion: string; impactAcknowledged: true };
}) {
  const { store } = control();
  try {
    const existing = store.list(100).jobs.find((job) => job.action === 'release.execute'
      && job.target.kind === 'release' && job.target.candidateId === input.candidateId
      && ['queued', 'running'].includes(job.status));
    if (existing) {
      if (existing.requestedBy.userId !== input.principal.userId) throw new MaintenanceControlError('maintenance_conflict', '另一管理员的升级正在执行。');
      return { job: existing, created: false };
    }
    const { readCurrentTeamReleaseVersion } = await import('../release-candidates.ts');
    const { readTeamReleaseCandidate } = await import('./release-candidates.ts');
    const { teamReleaseCandidateRoot } = await import('../release-candidates.ts');
    const { assertFixtureReleaseUploadAllowed } = await import('../release-candidates.ts');
    const current = await readCurrentTeamReleaseVersion();
    const candidate = await readTeamReleaseCandidate(
      teamReleaseCandidateRoot(), input.candidateId, current, assertFixtureReleaseUploadAllowed(),
    );
    if (candidate.status !== 'ready' || candidate.target.appVersion !== input.confirmation.targetAppVersion
      || current.releaseId !== input.confirmation.expectedReleaseId) {
      throw new MaintenanceControlError('release_confirmation_changed', '当前版本或目标版本已变化，请刷新并重新确认影响。');
    }
    return store.submit({
      action: 'release.execute', target: { kind: 'release', candidateId: candidate.candidateId },
      principal: principalForMaintenance(input.principal), idempotencyKey: input.idempotencyKey, retryRelease: true,
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
