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
 * 最新导出自动成为该成片计划的当前成片,用户可随时从历史恢复旧版。
 * 同一成片版本的同一产物类型不能重复登记。
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
    const plan = db.prepare(`
      SELECT id FROM batch_output_plans WHERE id = ?
    `).get(input.outputPlanId) as { id: string } | undefined;
    if (!plan) {
      throw new Error('成片计划不存在');
    }
    const version = db.prepare(`
      SELECT 1 FROM batch_output_versions WHERE id = ? AND planId = ?
    `).get(input.outputVersionId, input.outputPlanId);
    if (!version) {
      throw new Error('成片版本不属于该成片计划');
    }
    const duplicate = db.prepare(`
      SELECT 1 FROM batch_artifacts WHERE outputPlanId = ? AND outputVersionId = ? AND kind = ?
    `).get(input.outputPlanId, input.outputVersionId, input.kind);
    if (duplicate) {
      throw new Error('该成片版本的同类正式产物已登记');
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
    db.prepare(`
      UPDATE batch_output_plans SET currentArtifactId = ? WHERE id = ?
    `).run(id, input.outputPlanId);
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
 * 从历史恢复旧版为当前成片。只改变计划的可变指向,不删除任何历史产物。
 */
export function setCurrentArtifact(
  db: Database.Database,
  projectId: string,
  outputPlanId: string,
  artifactId: string,
): void {
  db.transaction(() => {
    const artifact = db.prepare(`
      SELECT 1 FROM batch_artifacts WHERE id = ? AND projectId = ? AND outputPlanId = ?
    `).get(artifactId, projectId, outputPlanId);
    if (!artifact) {
      throw new Error('正式产物不属于该成片计划');
    }
    db.prepare(`
      UPDATE batch_output_plans SET currentArtifactId = ? WHERE id = ?
    `).run(artifactId, outputPlanId);
  })();
}
