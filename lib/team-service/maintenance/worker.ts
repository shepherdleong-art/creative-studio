import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MaintenanceControlError, MaintenanceJobStore, type MaintenanceJob } from './jobs.ts';
import { safeMaintenanceId } from './paths.ts';
import { acquireSchemaUpgradeLock, SchemaUpgradeLockTimeoutError } from '../../schema-upgrade/lock.ts';

export function maintenanceGlobalLockPath(backupRoot: string): string {
  return path.join(backupRoot, 'maintenance-control', 'global.lock.db');
}

export function protectedDeploymentConfigPath(deploymentRoot: string): string {
  return path.join(deploymentRoot, 'config', 'maintenance-deployment.json');
}

export function readMaintenanceExecutionConfig(env: NodeJS.ProcessEnv = process.env): {
  configPath: string; backupRoot: string; deploymentId: string;
} {
  const deploymentRoot = env.CREATIVE_STUDIO_MAINTENANCE_DEPLOYMENT_ROOT;
  const backupRoot = env.CREATIVE_STUDIO_MAINTENANCE_BACKUP_ROOT;
  const deploymentId = env.CREATIVE_STUDIO_DEPLOYMENT_ID;
  if (!deploymentRoot || !path.isAbsolute(deploymentRoot) || !backupRoot || !path.isAbsolute(backupRoot) || !deploymentId) {
    throw new Error('网页维护缺少受管部署配置');
  }
  safeMaintenanceId(deploymentId, 'deploymentId');
  return { configPath: protectedDeploymentConfigPath(deploymentRoot), backupRoot, deploymentId };
}

export async function executeClaimedBackupJob(options: {
  job: MaintenanceJob; workerId: string; store: MaintenanceJobStore;
  configPath: string; deploymentId: string;
  makeBackup: (params: { backupId: string; onStage: (stage: 'snapshotting' | 'copying_media' | 'verifying') => void }) =>
    Promise<{ backupId: string; type: string; verifiedAt: string; totalBytes: number }>;
}): Promise<MaintenanceJob> {
  if (options.job.action !== 'backup.create' || options.job.target.kind !== 'backup') {
    throw new Error('该维护动作尚未注册受控执行器');
  }
  const backupId = `job-${options.job.id}`;
  try {
    options.store.updateStage({ jobId: options.job.id, workerId: options.workerId, stage: 'snapshotting' });
    const result = await options.makeBackup({
      backupId,
      onStage: (stage) => options.store.updateStage({ jobId: options.job!.id, workerId: options.workerId, stage }),
    });
    options.store.updateStage({ jobId: options.job.id, workerId: options.workerId, stage: 'finishing' });
    return options.store.complete({ jobId: options.job.id, workerId: options.workerId, result });
  } catch (error) {
    const current = options.store.get(options.job.id).job;
    if (current.leaseOwner === options.workerId && current.status === 'running') {
      options.store.fail({
        jobId: options.job.id, workerId: options.workerId, code: 'backup_failed',
        message: error instanceof Error && error.message.includes('空间不足') ? '备份空间不足，未生成可还原备份。' : '备份或完整性校验失败，未生成可还原备份。',
      });
    }
    throw error;
  }
}

export async function runMaintenanceWorker(options: {
  configPath: string; jobId?: string;
  makeBackup: (params: { job: MaintenanceJob; backupId: string; onStage: (stage: 'snapshotting' | 'copying_media' | 'verifying') => void }) =>
    Promise<{ backupId: string; type: string; verifiedAt: string; totalBytes: number }>;
  makeRestore?: (params: { job: MaintenanceJob; onStage: (stage: import('./restore-operation.ts').RestoreStage) => void }) =>
    Promise<{ awaitingConfirmation: boolean; [key: string]: unknown }>;
  once?: boolean; pollIntervalMs?: number;
}): Promise<void> {
  // deployment config 已在应用外解析，worker 不接受任意配置、路径或命令。
  const config = JSON.parse(fs.readFileSync(options.configPath, 'utf8').replace(/^\uFEFF/, '')) as {
    backupRoot: string; deploymentId: string;
  };
  const store = new MaintenanceJobStore({ backupRoot: config.backupRoot, deploymentId: config.deploymentId });
  const workerId = `maintenance-${process.pid}`;
  let lock: { release(): void } | null = null;
  try {
    while (true) {
      try {
        lock = await acquireSchemaUpgradeLock({ lockDatabasePath: maintenanceGlobalLockPath(config.backupRoot), timeoutMs: 100 });
      } catch (error) {
        if (!(error instanceof SchemaUpgradeLockTimeoutError)) throw error;
        if (options.once) throw new MaintenanceControlError('maintenance_conflict', '另一维护操作正在执行，请稍后重试。');
        await delay(options.pollIntervalMs ?? 1000);
        continue;
      }
      let claimed: { job: MaintenanceJob } | null;
      try {
        claimed = store.claimNext({ workerId, ...(options.jobId ? { jobId: options.jobId } : {}) });
      } catch (error) {
        lock?.release(); lock = null;
        if (!(error instanceof MaintenanceControlError) || error.code !== 'maintenance_conflict') throw error;
        if (options.once) throw error;
        await delay(options.pollIntervalMs ?? 1000);
        continue;
      }
      try {
        if (claimed) {
          if (claimed.job.action === 'restore.execute') {
            if (!options.makeRestore) throw new Error('还原执行器未配置，保持原业务不变');
            try {
              const heartbeat = setInterval(() => {
                try {
                  const current = store.get(claimed.job.id).job;
                  if (current.status === 'running' && current.leaseOwner === workerId) {
                    store.updateStage({ jobId: claimed.job.id, workerId, stage: current.stage, leaseMs: 120_000 });
                    lastLeaseRenewal = Date.now();
                  }
                } catch { /* 长阶段实际提交点会 fail closed；不掩盖租约丢失。 */ }
              }, 20_000);
              heartbeat.unref();
              let result: { awaitingConfirmation: boolean; [key: string]: unknown };
              let lastLeaseRenewal = Date.now();
              const renewLease = (stage: import('./jobs.ts').MaintenanceJob['stage']) => {
                lastLeaseRenewal = Date.now();
                return store.updateStage({ jobId: claimed.job.id, workerId, stage, leaseMs: 120_000 });
              };
              try { result = await options.makeRestore({ job: claimed.job, onStage: renewLease }); }
              finally { clearInterval(heartbeat); }
              if (Date.now() - lastLeaseRenewal > 55_000) renewLease(claimed.job.stage);
              if (result.awaitingConfirmation) store.awaitConfirmation({ jobId: claimed.job.id, workerId, result });
              else store.complete({ jobId: claimed.job.id, workerId, result });
            } catch (error) {
              const current = store.get(claimed.job.id).job;
              if (current.leaseOwner === workerId && current.status === 'running') {
                store.fail({ jobId: claimed.job.id, workerId, code: 'restore_failed',
                  message: error instanceof Error ? error.message.slice(0, 500) : '还原未完成，原业务保持不切换。' });
              }
              throw error;
            }
          } else {
            await executeClaimedBackupJob({ ...claimed, workerId, store, configPath: options.configPath, deploymentId: config.deploymentId,
              makeBackup: (params) => options.makeBackup({ ...params, job: claimed.job }) });
          }
        }
      } finally { lock?.release(); lock = null; }
      if (options.once) return;
      await delay(options.pollIntervalMs ?? 1000);
    }
  } finally {
    const residualLock = lock as { release(): void } | null;
    residualLock?.release();
    store.close();
  }
}
