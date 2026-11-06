import type Database from 'better-sqlite3';
import { TeamAuthError } from './auth/types.ts';
import type { TeamViewer } from './diagnostics.ts';

export function readProductionControl(db: Database.Database, viewer: TeamViewer) {
  if (viewer.role !== 'admin') throw new TeamAuthError('admin_required', '只有管理员可以控制团队运行。', 403);
  const row = db.prepare(`SELECT productionPaused, productionVersion, productionChangedAt,
    maintenance FROM team_service_state WHERE id = 1`).get() as {
    productionPaused: number; productionVersion: number; productionChangedAt: string | null; maintenance: number;
  };
  return { paused: Boolean(row.productionPaused), version: row.productionVersion,
    changedAt: row.productionChangedAt, maintenance: Boolean(row.maintenance) };
}

export function setProductionPaused(db: Database.Database, viewer: TeamViewer, input: { paused: boolean; expectedVersion: number }) {
  readProductionControl(db, viewer);
  if (typeof input.paused !== 'boolean' || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw new TeamAuthError('invalid_request', '暂停状态或版本无效。');
  }
  return db.transaction(() => {
    const current = readProductionControl(db, viewer);
    if (current.version !== input.expectedVersion) throw new TeamAuthError('version_conflict', '运行状态已变化，请刷新后重试。', 409);
    // Only the UI-owned pause flag changes. Deployment/restore holds stay intact.
    db.prepare(`UPDATE team_service_state SET productionPaused=?, productionVersion=productionVersion+1,
      productionChangedBy=?, productionChangedAt=? WHERE id=1`).run(input.paused ? 1 : 0, viewer.userId, new Date().toISOString());
    return readProductionControl(db, viewer);
  }).immediate();
}
