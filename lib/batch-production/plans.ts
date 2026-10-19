import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { assertBatchVersionEditable } from './versions.ts';

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
  /** Phase E 联合分配运行谱系;旧的手工版本可为空。 */
  allocationRunId: string | null;
  createdAt: string;
}

function nowIso(now?: () => Date): string {
  return (now ?? (() => new Date()))().toISOString();
}

function getSnapshotPlanCapacity(
  db: Database.Database,
  batchVersionId: string,
  scriptSnapshotId: string,
): { copyCount: number; existingCount: number } {
  const snapshot = db.prepare(`
    SELECT copyCount FROM batch_script_snapshots WHERE id = ? AND batchVersionId = ?
  `).get(scriptSnapshotId, batchVersionId) as { copyCount: number } | undefined;
  if (!snapshot) {
    throw new Error('脚本快照不属于该批次版本');
  }
  const existing = db.prepare(`
    SELECT COUNT(*) AS count
    FROM batch_output_plans
    WHERE batchVersionId = ? AND scriptSnapshotId = ?
  `).get(batchVersionId, scriptSnapshotId) as { count: number };
  return { copyCount: snapshot.copyCount, existingCount: existing.count };
}

function insertOutputPlan(
  db: Database.Database,
  input: {
    batchVersionId: string;
    scriptSnapshotId: string;
    seq: number;
    planJson?: unknown;
    createdAt: string;
  },
): string {
  const duplicate = db.prepare(`
    SELECT 1 FROM batch_output_plans WHERE batchVersionId = ? AND seq = ?
  `).get(input.batchVersionId, input.seq);
  if (duplicate) {
    throw new Error('该批次版本已存在相同序号的成片计划');
  }
  const id = randomUUID();
  db.prepare(`
    INSERT INTO batch_output_plans
      (id, batchVersionId, scriptSnapshotId, seq, planJson, currentVersionId, createdAt)
    VALUES (?, ?, ?, ?, ?, NULL, ?)
  `).run(
    id,
    input.batchVersionId,
    input.scriptSnapshotId,
    input.seq,
    JSON.stringify(input.planJson ?? {}),
    input.createdAt,
  );
  return id;
}

/**
 * 建立一条成片计划(一张成片卡片)。seq 是批次版本内的全局正整数序号；
 * 每份脚本快照最多建立 copyCount 条计划，失败重试不能多出第 N+1 张卡片。
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
    assertBatchVersionEditable(db, batchVersionId);
    const capacity = getSnapshotPlanCapacity(db, batchVersionId, input.scriptSnapshotId);
    if (capacity.existingCount >= capacity.copyCount) {
      throw new Error(`该脚本快照只能建立 1..${capacity.copyCount} 条成片计划`);
    }
    if (!Number.isInteger(input.seq) || input.seq < 1) {
      throw new Error('成片计划序号必须是正整数');
    }
    return insertOutputPlan(db, {
      batchVersionId,
      scriptSnapshotId: input.scriptSnapshotId,
      seq: input.seq,
      planJson: input.planJson,
      createdAt,
    });
  })();
}

/**
 * 按脚本快照的生成份数一次性建立 N 条成片计划(一张卡片一条计划)。
 * 同一快照只能建立一次计划集合;重复调用被拒绝,保证重试不增加卡片。
 * 序号从该批次版本已有最大序号之后续排,多份脚本快照的计划可共存。
 */
export function createOutputPlansForSnapshot(
  db: Database.Database,
  batchVersionId: string,
  scriptSnapshotId: string,
  now?: () => Date,
): string[] {
  return db.transaction(() => {
    assertBatchVersionEditable(db, batchVersionId);
    const capacity = getSnapshotPlanCapacity(db, batchVersionId, scriptSnapshotId);
    if (capacity.existingCount > 0) {
      throw new Error('该脚本快照已建立过成片计划');
    }
    const maxSeq = db.prepare(`
      SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM batch_output_plans WHERE batchVersionId = ?
    `).get(batchVersionId) as { maxSeq: number };
    const createdAt = nowIso(now);
    const ids: string[] = [];
    for (let offset = 1; offset <= capacity.copyCount; offset += 1) {
      ids.push(insertOutputPlan(db, {
        batchVersionId,
        scriptSnapshotId,
        seq: maxSeq.maxSeq + offset,
        createdAt,
      }));
    }
    return ids;
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
