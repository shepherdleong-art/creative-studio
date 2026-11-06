import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { readTeamRestoreHold } from './hold.ts';
import { assertNoSymlinkPath, readJsonFile, safeMaintenanceId, writeJsonAtomic } from './paths.ts';

export const TEAM_RESTORE_ACTIVITY_FILE = 'active-data-root.json';

export interface TeamRestoreActivity {
  schemaVersion: 1;
  deploymentId: string;
  operationId: string;
  state: 'switched' | 'failed' | 'needs_review';
  activeDataRoot: string;
  protectedDataRoots: string[];
  recovery: {
    restoredDataRoot: string;
    preRestoreBackupId: string;
    protectedOldRoot: string;
    message: string;
  };
  updatedAt: string;
}

export async function readTeamRestoreActivity(serviceRoot: string): Promise<TeamRestoreActivity> {
  const activity = await readJsonFile<TeamRestoreActivity>(path.join(serviceRoot, TEAM_RESTORE_ACTIVITY_FILE));
  if (activity.schemaVersion !== 1 || !['switched', 'failed', 'needs_review'].includes(activity.state)
    || !path.isAbsolute(activity.activeDataRoot) || !Array.isArray(activity.protectedDataRoots)) {
    throw new Error('活动数据根状态不完整，需管理员核查');
  }
  return activity;
}

/**
 * 只移动受管数据目录，不把历史配置写回系统服务、证书或部署秘密。
 * 指针与保留目录均原子发布；激活失败时指针继续指向原根。
 */
export async function cutoverTeamRestore(options: {
  serviceRoot: string;
  activeDataRoot: string;
  restoredDataRoot: string;
  protectedDataRoot: string;
  deploymentId: string;
  operationId: string;
  backupId: string;
  activate?: (restoredDataRoot: string) => Promise<void>;
  beforeMove?: () => Promise<void>;
  rollbackService?: () => Promise<void>;
  now?: () => Date;
}): Promise<TeamRestoreActivity> {
  safeMaintenanceId(options.deploymentId, 'deploymentId');
  safeMaintenanceId(options.operationId, 'operationId');
  safeMaintenanceId(options.backupId, 'backupId');
  const source = path.resolve(options.activeDataRoot);
  const target = path.resolve(options.restoredDataRoot);
  const retained = path.resolve(options.protectedDataRoot);
  if (path.basename(target) !== 'restored' || path.basename(retained) !== 'protected-old-root'
    || path.resolve(path.dirname(target)) !== path.resolve(path.dirname(retained))) {
    throw new Error('还原候选与保留根必须使用同一受管操作目录的固定名称');
  }
  for (const root of [source, target, retained]) assertNoSymlinkPath(root);
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) throw new Error('已验证还原根不存在');
  if (fs.existsSync(retained)) throw new Error('受保护旧根已存在，拒绝覆盖');
  if (path.parse(retained).root.toLowerCase() === retained.toLowerCase()) throw new Error('保留根不能是磁盘根');
  await readTeamRestoreHold(target);
  if (path.parse(source).root.toLowerCase() !== path.parse(target).root.toLowerCase()) {
    throw new Error('还原根必须与活动根位于同一数据卷，不能进行跨卷半切换');
  }
  const activityPath = path.join(options.serviceRoot, TEAM_RESTORE_ACTIVITY_FILE);
  assertNoSymlinkPath(path.dirname(activityPath));
  if (fs.existsSync(activityPath)) {
    const existing = await readTeamRestoreActivity(options.serviceRoot);
    if (existing.operationId === options.operationId) {
      if (existing.state === 'switched') return existing;
      throw new Error('该切换已中断或曾失败，必须先核查实际活动根，不能重放');
    }
    if (existing.state === 'needs_review') throw new Error('上次切换恢复状态未核实，拒绝开始另一还原');
    if (existing.state !== 'failed' || path.resolve(existing.activeDataRoot) !== source) {
      throw new Error('已有另一还原切换状态，请核查实际活动数据根');
    }
    const history = path.join(options.serviceRoot, 'restore-history', `${existing.operationId}.json`);
    if (fs.existsSync(history)) throw new Error('既有切换失败历史标识冲突');
    await writeJsonAtomic(history, existing);
  }
  const recovery = {
    restoredDataRoot: target,
    preRestoreBackupId: options.backupId,
    protectedOldRoot: retained,
    message: '切换失败时保持原活动根；还原前备份与受保护旧根均可用于后续受控恢复。',
  };
  await writeJsonAtomic(activityPath, {
    schemaVersion: 1, deploymentId: options.deploymentId, operationId: options.operationId,
    state: 'needs_review', activeDataRoot: source, protectedDataRoots: [retained],
    recovery: { ...recovery, message: '切换已开始但结果未确认；请核查实际运行服务和活动根，勿自动重放。' },
    updatedAt: (options.now ?? (() => new Date()))().toISOString(),
  } satisfies TeamRestoreActivity);
  try {
    await (options.beforeMove ?? (async () => {}))();
    await fsPromises.rename(source, retained);
    await (options.activate ?? (async () => {}))(target);
  } catch (error) {
    if (!fs.existsSync(source) && fs.existsSync(retained)) {
      await fsPromises.rename(retained, source);
    }
    let state: TeamRestoreActivity['state'] = 'failed';
    if (options.rollbackService) {
      try { await options.rollbackService(); } catch { state = 'needs_review'; }
    }
    const failed: TeamRestoreActivity = {
      schemaVersion: 1, deploymentId: options.deploymentId, operationId: options.operationId,
      state, activeDataRoot: source, protectedDataRoots: [retained],
      recovery: state === 'needs_review' ? { ...recovery, message: '服务恢复启动未确认，活动状态需现场核查；不要重启另一还原。' } : recovery,
      updatedAt: (options.now ?? (() => new Date()))().toISOString(),
    };
    await writeJsonAtomic(activityPath, failed);
    throw error;
  }
  const switched: TeamRestoreActivity = {
    schemaVersion: 1, deploymentId: options.deploymentId, operationId: options.operationId,
    state: 'switched', activeDataRoot: target, protectedDataRoots: [retained],
    recovery, updatedAt: (options.now ?? (() => new Date()))().toISOString(),
  };
  await writeJsonAtomic(activityPath, switched);
  return switched;
}
