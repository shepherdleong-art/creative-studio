import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

export interface BatchOutputPlanRow {
  id: string;
  batchVersionId: string;
  scriptSnapshotId: string;
  seq: number;
  planJson: string;
  currentVersionId: string | null;
  createdAt: string;
}

export interface BatchOutputVersionRow {
  id: string;
  planId: string;
  versionNumber: number;
  arrangementJson: string;
  createdAt: string;
}

function nowIso(now?: () => Date): string {
  return (now ?? (() => new Date()))().toISOString();
}

/**
 * 建立一条成片计划(一张成片卡片)。每份脚本快照按其生成份数建立 N 条计划;
 * 计划有稳定身份,失败重试只能产生新的任务尝试,不能多出第 N+1 张卡片。
 * 同一批次版本、同一快照、同一序号不能重复建立。
 */
export function createOutputPlan(
  db: Database.Database,
  batchVersionId: string,
  input: {
    scriptSnapshotId: string;
    seq: number;
    planJson?: unknown;
    now?: () => Date;
  },
): string {
  const createdAt = nowIso(input.now);
  return db.transaction(() => {
    const snapshot = db.prepare(`
      SELECT 1 FROM batch_script_snapshots WHERE id = ? AND batchVersionId = ?
    `).get(input.scriptSnapshotId, batchVersionId);
    if (!snapshot) {
      throw new Error('脚本快照不属于该批次版本');
    }
    const duplicate = db.prepare(`
      SELECT 1 FROM batch_output_plans WHERE batchVersionId = ? AND seq = ?
    `).get(batchVersionId, input.seq);
    if (duplicate) {
      throw new Error('该批次版本已存在相同序号的成片计划');
    }
    const id = randomUUID();
    db.prepare(`
      INSERT INTO batch_output_plans (id, batchVersionId, scriptSnapshotId, seq, planJson, currentVersionId, createdAt)
      VALUES (?, ?, ?, ?, ?, NULL, ?)
    `).run(id, batchVersionId, input.scriptSnapshotId, input.seq, JSON.stringify(input.planJson ?? {}), createdAt);
    return id;
  })();
}

export function getOutputPlan(
  db: Database.Database,
  batchVersionId: string,
  planId: string,
): (BatchOutputPlanRow & { planJson: unknown }) | undefined {
  const row = db.prepare(`
    SELECT * FROM batch_output_plans WHERE id = ? AND batchVersionId = ?
  `).get(planId, batchVersionId) as BatchOutputPlanRow | undefined;
  if (!row) return undefined;
  return { ...row, planJson: JSON.parse(row.planJson) };
}

export function listOutputPlans(db: Database.Database, batchVersionId: string): BatchOutputPlanRow[] {
  return db.prepare(`
    SELECT * FROM batch_output_plans WHERE batchVersionId = ? ORDER BY seq
  `).all(batchVersionId) as BatchOutputPlanRow[];
}

/**
 * 建立一条成片版本:只调整某条成片的镜头、字幕、封面或音乐时形成新版本,
 * 旧版本保留,不影响同批次其他成片。新版本自动成为该计划的当前版本。
 */
export function createOutputVersion(
  db: Database.Database,
  planId: string,
  input: {
    arrangementJson?: unknown;
    now?: () => Date;
  },
): string {
  const createdAt = nowIso(input.now);
  return db.transaction(() => {
    const plan = db.prepare(`SELECT 1 FROM batch_output_plans WHERE id = ?`).get(planId);
    if (!plan) {
      throw new Error('成片计划不存在');
    }
    const existing = db.prepare(`
      SELECT MAX(versionNumber) AS maxVersion FROM batch_output_versions WHERE planId = ?
    `).get(planId) as { maxVersion: number | null };
    const versionNumber = (existing.maxVersion ?? 0) + 1;
    const id = randomUUID();
    db.prepare(`
      INSERT INTO batch_output_versions (id, planId, versionNumber, arrangementJson, createdAt)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, planId, versionNumber, JSON.stringify(input.arrangementJson ?? {}), createdAt);
    db.prepare(`
      UPDATE batch_output_plans SET currentVersionId = ? WHERE id = ?
    `).run(id, planId);
    return id;
  })();
}

export function getOutputVersion(
  db: Database.Database,
  planId: string,
  versionId: string,
): (BatchOutputVersionRow & { arrangementJson: unknown }) | undefined {
  const row = db.prepare(`
    SELECT * FROM batch_output_versions WHERE id = ? AND planId = ?
  `).get(versionId, planId) as BatchOutputVersionRow | undefined;
  if (!row) return undefined;
  return { ...row, arrangementJson: JSON.parse(row.arrangementJson) };
}

export function listOutputVersions(db: Database.Database, planId: string): BatchOutputVersionRow[] {
  return db.prepare(`
    SELECT * FROM batch_output_versions WHERE planId = ? ORDER BY versionNumber
  `).all(planId) as BatchOutputVersionRow[];
}
