import fs from 'node:fs';
import path from 'node:path';
import { appendMaintenanceReceipt } from './receipts.ts';
import { readJsonFile, safeMaintenanceId, sha256Text, writeJsonAtomic } from './paths.ts';

export interface TeamReleaseIdentity {
  releaseId: string;
  packageSha256: string;
}

export interface TeamReleasePointer extends TeamReleaseIdentity {
  schemaVersion: 1;
  switchedAt: string;
}

export const TEAM_RELEASE_STAGES = [
  'preflight', 'maintenance', 'drain', 'capture', 'stop', 'backup',
  'switch', 'start_maintenance', 'migrate', 'self_check', 'resume',
] as const;
export type TeamReleaseStage = typeof TEAM_RELEASE_STAGES[number];

export interface TeamReleaseState {
  schemaVersion: 1;
  operationId: string;
  deploymentId: string;
  inputHash: string;
  status: 'running' | 'failed' | 'completed' | 'restore_hold';
  maintenance: boolean;
  currentStage: TeamReleaseStage | 'rollback' | 'done';
  completedStages: TeamReleaseStage[];
  fromRelease: TeamReleaseIdentity;
  toRelease: TeamReleaseIdentity;
  unknownAttemptIds: string[];
  executionEvidenceSha256?: string;
  preUpgradeBackupId?: string;
  errorCode?: string;
  updatedAt: string;
}

export interface TeamReleaseAdapters {
  preflight(input: { fromRelease: TeamReleaseIdentity; toRelease: TeamReleaseIdentity }): Promise<void>;
  enterMaintenance(): Promise<void>;
  drainInflight(): Promise<{ pendingTasks: number; unknownAttemptIds: string[] }>;
  captureExecution(): Promise<{ evidenceSha256: string; operationCount: number }>;
  stopOldInstance(): Promise<{
    deploymentId: string; instanceId: string; stopped: boolean; residualPids: number[];
  }>;
  createPreUpgradeBackup(): Promise<{ backupId: string; verified: boolean }>;
  switchRelease(input: { fromRelease: TeamReleaseIdentity; toRelease: TeamReleaseIdentity }): Promise<void>;
  startMaintenance(): Promise<void>;
  migrate(): Promise<void>;
  selfCheck(): Promise<{ available: boolean; automaticRetries: number }>;
  resume(input: { unknownAttemptIds: string[] }): Promise<void>;
}

export interface RunTeamReleaseOptions {
  operationId: string;
  deploymentId: string;
  backupRoot: string;
  stateDirectory: string;
  fromRelease: TeamReleaseIdentity;
  toRelease: TeamReleaseIdentity;
  adapters: TeamReleaseAdapters;
  now?: () => Date;
}

export class TeamReleaseError extends Error {
  readonly stage: TeamReleaseStage | 'rollback';
  readonly code = 'release_stage_failed';

  constructor(stage: TeamReleaseStage | 'rollback', cause: unknown) {
    super(`发布阶段 ${stage} 失败：${cause instanceof Error ? cause.message : '未知错误'}`);
    this.name = 'TeamReleaseError';
    this.stage = stage;
  }
}

function validateRelease(release: TeamReleaseIdentity): void {
  safeMaintenanceId(release.releaseId, 'releaseId');
  if (!/^[0-9a-f]{64}$/.test(release.packageSha256)) throw new Error('release 包哈希无效');
}

function statePath(directory: string, operationId: string): string {
  return path.join(directory, `${safeMaintenanceId(operationId, 'operationId')}.json`);
}

export async function writeTeamReleasePointer(options: {
  serviceRoot: string;
  release: TeamReleaseIdentity;
  expectedReleaseId?: string;
  now?: () => Date;
}): Promise<TeamReleasePointer> {
  validateRelease(options.release);
  const filePath = path.join(options.serviceRoot, 'current-release.json');
  if (options.expectedReleaseId !== undefined) {
    const current = await readTeamReleasePointer(options.serviceRoot);
    if (current.releaseId !== options.expectedReleaseId) throw new Error('当前 release 与预期不符，拒绝切换');
  }
  const pointer: TeamReleasePointer = {
    schemaVersion: 1,
    ...options.release,
    switchedAt: (options.now?.() ?? new Date()).toISOString(),
  };
  await writeJsonAtomic(filePath, pointer);
  return pointer;
}

export async function readTeamReleasePointer(serviceRoot: string): Promise<TeamReleasePointer> {
  const pointer = await readJsonFile<TeamReleasePointer>(path.join(serviceRoot, 'current-release.json'));
  validateRelease(pointer);
  if (pointer.schemaVersion !== 1 || typeof pointer.switchedAt !== 'string') throw new Error('release 指针无效');
  return pointer;
}

export async function switchTeamReleasePointerIdempotent(options: {
  serviceRoot: string;
  release: TeamReleaseIdentity;
  expectedReleaseId: string;
  now?: () => Date;
}): Promise<{ alreadyCurrent: boolean; pointer: TeamReleasePointer }> {
  const filePath = path.join(options.serviceRoot, 'current-release.json');
  if (fs.existsSync(filePath)) {
    const current = await readTeamReleasePointer(options.serviceRoot);
    if (current.releaseId === options.release.releaseId
      && current.packageSha256 === options.release.packageSha256) {
      return { alreadyCurrent: true, pointer: current };
    }
  }
  const pointer = await writeTeamReleasePointer(options);
  return { alreadyCurrent: false, pointer };
}

export async function runTeamRelease(options: RunTeamReleaseOptions): Promise<TeamReleaseState> {
  safeMaintenanceId(options.deploymentId, 'deploymentId');
  safeMaintenanceId(options.operationId, 'operationId');
  validateRelease(options.fromRelease);
  validateRelease(options.toRelease);
  if (options.fromRelease.releaseId === options.toRelease.releaseId) throw new Error('新旧 release 不能相同');
  const now = options.now ?? (() => new Date());
  const inputHash = sha256Text(JSON.stringify({
    deploymentId: options.deploymentId,
    fromRelease: options.fromRelease,
    toRelease: options.toRelease,
  }));
  const filePath = statePath(options.stateDirectory, options.operationId);
  let state: TeamReleaseState;
  if (fs.existsSync(filePath)) {
    state = await readJsonFile<TeamReleaseState>(filePath);
    if (state.schemaVersion !== 1 || state.operationId !== options.operationId
      || state.deploymentId !== options.deploymentId || state.inputHash !== inputHash) {
      throw new Error('发布续跑身份或输入哈希不匹配');
    }
    if (state.status === 'completed') return state;
    state = { ...state, status: 'running', maintenance: true, errorCode: undefined, updatedAt: now().toISOString() };
  } else {
    state = {
      schemaVersion: 1,
      operationId: options.operationId,
      deploymentId: options.deploymentId,
      inputHash,
      status: 'running',
      maintenance: true,
      currentStage: 'preflight',
      completedStages: [],
      fromRelease: options.fromRelease,
      toRelease: options.toRelease,
      unknownAttemptIds: [],
      updatedAt: now().toISOString(),
    };
  }
  const completed = new Set(state.completedStages);
  const persist = async () => {
    state.updatedAt = now().toISOString();
    await writeJsonAtomic(filePath, state);
  };
  await persist();

  const execute = async (stage: TeamReleaseStage, action: () => Promise<void>) => {
    if (completed.has(stage)) return;
    state.currentStage = stage;
    state.status = 'running';
    state.maintenance = true;
    await persist();
    appendMaintenanceReceipt({
      backupRoot: options.backupRoot, deploymentId: options.deploymentId, kind: 'release',
      operationId: options.operationId, phase: 'stage', at: now().toISOString(), details: { stage, outcome: 'started' },
    });
    try {
      await action();
      completed.add(stage);
      state.completedStages = [...completed];
      await persist();
      appendMaintenanceReceipt({
        backupRoot: options.backupRoot, deploymentId: options.deploymentId, kind: 'release',
        operationId: options.operationId, phase: 'stage', at: now().toISOString(), details: { stage, outcome: 'finished' },
      });
    } catch (error) {
      state.status = 'failed';
      state.maintenance = true;
      state.currentStage = stage;
      state.errorCode = 'release_stage_failed';
      await persist();
      appendMaintenanceReceipt({
        backupRoot: options.backupRoot, deploymentId: options.deploymentId, kind: 'release',
        operationId: options.operationId, phase: 'failed', at: now().toISOString(), details: { stage },
      });
      throw new TeamReleaseError(stage, error);
    }
  };

  await execute('preflight', () => options.adapters.preflight({
    fromRelease: options.fromRelease, toRelease: options.toRelease,
  }));
  await execute('maintenance', () => options.adapters.enterMaintenance());
  await execute('drain', async () => {
    const result = await options.adapters.drainInflight();
    if (!Number.isSafeInteger(result.pendingTasks) || result.pendingTasks !== 0) {
      throw new Error('仍有未处理的在途任务，禁止停机切换');
    }
    state.unknownAttemptIds = [...new Set(result.unknownAttemptIds)];
  });
  await execute('capture', async () => {
    const result = await options.adapters.captureExecution();
    if (!/^[0-9a-f]{64}$/.test(result.evidenceSha256) || !Number.isSafeInteger(result.operationCount)) {
      throw new Error('执行表或独立日志证据无效');
    }
    state.executionEvidenceSha256 = result.evidenceSha256;
  });
  await execute('stop', async () => {
    const result = await options.adapters.stopOldInstance();
    if (result.deploymentId !== options.deploymentId || !result.instanceId || !result.stopped || result.residualPids.length > 0) {
      throw new Error('旧实例或写入子进程尚未全部退出');
    }
  });
  await execute('backup', async () => {
    const result = await options.adapters.createPreUpgradeBackup();
    if (!result.verified) throw new Error('pre-upgrade 完整备份未验证');
    state.preUpgradeBackupId = safeMaintenanceId(result.backupId, 'backupId');
  });
  await execute('switch', () => options.adapters.switchRelease({
    fromRelease: options.fromRelease, toRelease: options.toRelease,
  }));
  await execute('start_maintenance', () => options.adapters.startMaintenance());
  await execute('migrate', () => options.adapters.migrate());
  await execute('self_check', async () => {
    const result = await options.adapters.selfCheck();
    if (!result.available || result.automaticRetries !== 0) throw new Error('维护态自检未通过或存在自动重提');
  });
  await execute('resume', () => options.adapters.resume({ unknownAttemptIds: state.unknownAttemptIds }));
  state.status = 'completed';
  state.maintenance = false;
  state.currentStage = 'done';
  state.errorCode = undefined;
  await persist();
  appendMaintenanceReceipt({
    backupRoot: options.backupRoot, deploymentId: options.deploymentId, kind: 'release',
    operationId: options.operationId, phase: 'finished', at: now().toISOString(),
    details: { releaseId: options.toRelease.releaseId },
  });
  return state;
}

export interface TeamRollbackAdapters {
  stopCurrentInstance(): Promise<{ deploymentId: string; instanceId: string; stopped: boolean; residualPids: number[] }>;
  switchRelease(input: { currentRelease: TeamReleaseIdentity; targetRelease: TeamReleaseIdentity }): Promise<void>;
  startMaintenance(): Promise<void>;
  selfCheck(): Promise<{ available: boolean; automaticRetries: number }>;
  resume(): Promise<void>;
  restoreBackup(input: { targetRelease: TeamReleaseIdentity }): Promise<{
    restoreRoot: string; scheduling: boolean; automaticRetries: number;
  }>;
}

export async function rollbackTeamRelease(options: {
  operationId: string;
  deploymentId: string;
  backupRoot: string;
  stateDirectory: string;
  strategy: 'compatible' | 'restore';
  compatibility: { schemaCompatible: boolean; irreversibleChanges: boolean };
  currentRelease: TeamReleaseIdentity;
  targetRelease: TeamReleaseIdentity;
  adapters: TeamRollbackAdapters;
  now?: () => Date;
}): Promise<Record<string, unknown>> {
  const now = options.now ?? (() => new Date());
  safeMaintenanceId(options.operationId, 'operationId');
  validateRelease(options.currentRelease);
  validateRelease(options.targetRelease);
  if (options.strategy === 'compatible'
    && (!options.compatibility.schemaCompatible || options.compatibility.irreversibleChanges)) {
    throw new Error('程序兼容回切要求 schema 兼容且没有不可逆状态变化');
  }
  const result: Record<string, unknown> = {
    schemaVersion: 1,
    operationId: options.operationId,
    strategy: options.strategy,
    status: 'running',
    maintenance: true,
    scheduling: false,
    automaticRetries: 0,
  };
  const persist = () => writeJsonAtomic(statePath(options.stateDirectory, options.operationId), {
    ...result, updatedAt: now().toISOString(),
  });
  appendMaintenanceReceipt({
    backupRoot: options.backupRoot, deploymentId: options.deploymentId, kind: 'release',
    operationId: options.operationId, phase: 'started', details: { rollbackStrategy: options.strategy },
  });
  try {
    await persist();
    const stopped = await options.adapters.stopCurrentInstance();
    if (stopped.deploymentId !== options.deploymentId || !stopped.instanceId || !stopped.stopped
      || stopped.residualPids.length > 0) throw new Error('新版实例尚未退出，禁止回退');
    if (options.strategy === 'compatible') {
      await options.adapters.switchRelease({
        currentRelease: options.currentRelease, targetRelease: options.targetRelease,
      });
      await options.adapters.startMaintenance();
      const check = await options.adapters.selfCheck();
      if (!check.available || check.automaticRetries !== 0) throw new Error('回切后的维护态自检未通过');
      await options.adapters.resume();
      result.status = 'completed';
      result.maintenance = false;
      result.scheduling = true;
    } else {
      const restored = await options.adapters.restoreBackup({ targetRelease: options.targetRelease });
      if (!restored.restoreRoot || restored.scheduling || restored.automaticRetries !== 0) {
        throw new Error('数据恢复必须进入独立新根并保持禁调度、禁自动重提');
      }
      result.status = 'restore_hold';
      result.restoreRoot = restored.restoreRoot;
    }
    await persist();
    appendMaintenanceReceipt({
      backupRoot: options.backupRoot, deploymentId: options.deploymentId, kind: 'release',
      operationId: options.operationId, phase: 'finished', details: { rollbackStrategy: options.strategy },
    });
    return result;
  } catch (error) {
    result.status = 'failed';
    result.maintenance = true;
    result.scheduling = false;
    await persist();
    appendMaintenanceReceipt({
      backupRoot: options.backupRoot, deploymentId: options.deploymentId, kind: 'release',
      operationId: options.operationId, phase: 'failed', details: { rollbackStrategy: options.strategy },
    });
    throw new TeamReleaseError('rollback', error);
  }
}
