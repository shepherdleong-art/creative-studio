import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

export type BatchArtifactKind = 'video' | 'cover';

export interface BatchArtifactRow {
  id: string;
  projectId: string;
  batchId: string;
  batchVersionId: string;
  outputPlanId: string;
  outputVersionId: string;
  kind: BatchArtifactKind;
  relativePath: string;
  checksum: string;
  createdAt: string;
}

function nowIso(now?: () => Date): string {
  return (now ?? (() => new Date()))().toISOString();
}

/**
 * 登记一份正式产物。每次成功导出都会新增一份,不覆盖旧文件;
 * 同一成片版本可以再次导出,每次导出都是独立产物记录。
 * 只有视频产物的最新导出自动成为该成片计划的当前成片;封面登记不改变指向。
 * 五个关联 ID 必须属于同一项目与同一条批次→版本→计划→成片版本链路。
 */
export function registerArtifact(
  db: Database.Database,
  projectId: string,
  input: {
    batchId: string;
    batchVersionId: string;
    outputPlanId: string;
    outputVersionId: string;
    kind: BatchArtifactKind;
    relativePath: string;
    checksum: string;
    now?: () => Date;
  },
): string {
  const createdAt = nowIso(input.now);
  return db.transaction(() => {
    const batch = db.prepare(`
      SELECT projectId FROM batch_productions WHERE id = ? AND deletedAt IS NULL
    `).get(input.batchId) as { projectId: string } | undefined;
    if (!batch) {
      throw new Error('批次不存在');
    }
    if (batch.projectId !== projectId) {
      throw new Error('批次不属于该项目');
    }
    const plan = db.prepare(`
      SELECT v.batchId AS batchId, v.id AS batchVersionId
      FROM batch_output_plans p
      JOIN batch_production_versions v ON v.id = p.batchVersionId
      WHERE p.id = ?
    `).get(input.outputPlanId) as { batchId: string; batchVersionId: string } | undefined;
    if (!plan) {
      throw new Error('成片计划不存在');
    }
    if (plan.batchId !== input.batchId || plan.batchVersionId !== input.batchVersionId) {
      throw new Error('成片计划不属于该批次与批次版本');
    }
    const version = db.prepare(`
      SELECT planId FROM batch_output_versions WHERE id = ?
    `).get(input.outputVersionId) as { planId: string } | undefined;
    if (!version) {
      throw new Error('成片版本不存在');
    }
    if (version.planId !== input.outputPlanId) {
      throw new Error('成片版本不属于该成片计划');
    }
    const duplicate = db.prepare(`
      SELECT 1 FROM batch_artifacts WHERE outputPlanId = ? AND relativePath = ?
    `).get(input.outputPlanId, input.relativePath);
    if (duplicate) {
      throw new Error('该文件路径的正式产物已登记');
    }
    const id = randomUUID();
    db.prepare(`
      INSERT INTO batch_artifacts (id, projectId, batchId, batchVersionId, outputPlanId, outputVersionId, kind, relativePath, checksum, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      projectId,
      input.batchId,
      input.batchVersionId,
      input.outputPlanId,
      input.outputVersionId,
      input.kind,
      input.relativePath,
      input.checksum,
      createdAt,
    );
    if (input.kind === 'video') {
      db.prepare(`
        UPDATE batch_output_plans SET currentArtifactId = ? WHERE id = ?
      `).run(id, input.outputPlanId);
    }
    return id;
  })();
}

export function getArtifact(
  db: Database.Database,
  projectId: string,
  artifactId: string,
): BatchArtifactRow | undefined {
  return db.prepare(`
    SELECT * FROM batch_artifacts WHERE id = ? AND projectId = ?
  `).get(artifactId, projectId) as BatchArtifactRow | undefined;
}

export function listPlanArtifacts(db: Database.Database, outputPlanId: string): BatchArtifactRow[] {
  return db.prepare(`
    SELECT * FROM batch_artifacts WHERE outputPlanId = ? ORDER BY createdAt, id
  `).all(outputPlanId) as BatchArtifactRow[];
}

export function getCurrentArtifactId(db: Database.Database, outputPlanId: string): string | null {
  const row = db.prepare(`
    SELECT currentArtifactId FROM batch_output_plans WHERE id = ?
  `).get(outputPlanId) as { currentArtifactId: string | null } | undefined;
  return row?.currentArtifactId ?? null;
}

/**
 * 从历史恢复旧版为当前成片。只改变计划的可变指向,不删除任何历史产物;
 * 当前成片只能指向视频产物,封面不能成为当前成片。
 */
export function setCurrentArtifact(
  db: Database.Database,
  projectId: string,
  outputPlanId: string,
  artifactId: string,
): void {
  db.transaction(() => {
    const artifact = db.prepare(`
      SELECT kind FROM batch_artifacts WHERE id = ? AND projectId = ? AND outputPlanId = ?
    `).get(artifactId, projectId, outputPlanId) as { kind: BatchArtifactKind } | undefined;
    if (!artifact) {
      throw new Error('正式产物不属于该成片计划');
    }
    if (artifact.kind !== 'video') {
      throw new Error('当前成片只能指向视频产物');
    }
    db.prepare(`
      UPDATE batch_output_plans SET currentArtifactId = ? WHERE id = ?
    `).run(artifactId, outputPlanId);
  })();
}
