import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { schemaUpgradeRuntimePaths } from '../../schema-upgrade/runtime.ts';
import { ensureServerDeploymentMarker, readRuntimeConfig } from '../config.ts';
import { checkTeamServiceReadiness } from '../readiness.ts';
import { initializeFirstAdministrator, recoverAdministrator } from './local-admin.ts';

export async function runLocalAdministratorCommand(
  action: 'initialize' | 'recover',
  input: { employeeId: string; displayName?: string },
) {
  const config = readRuntimeConfig();
  if (config.mode !== 'server') throw new Error('本机账号维护必须显式使用 server 数据根配置');
  ensureServerDeploymentMarker(config);
  fs.mkdirSync(path.join(config.dataRoot, 'data'), { recursive: true });
  const db = new Database(path.join(config.dataRoot, 'data', 'workbench.db'));
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    const readiness = await checkTeamServiceReadiness({ db, ...schemaUpgradeRuntimePaths(config.dataRoot) });
    if (!readiness.available) throw new Error(`团队身份结构未就绪：${readiness.code}`);
    if (action === 'initialize') {
      return await initializeFirstAdministrator({ db, ...input });
    }
    return await recoverAdministrator({ db, ...input });
  } finally {
    db.close();
  }
}
