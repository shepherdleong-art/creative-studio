import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

export type BatchScriptSourceKind = 'script_draft' | 'external';

export interface BatchScriptRow {
  id: string;
  projectId: string;
  sourceKind: BatchScriptSourceKind;
  sourceId: string;
  title: string;
  bodyText: string;
  sourceVersion: string;
  createdAt: string;
  updatedAt: string;
}

export interface BatchScriptSnapshotRow {
  id: string;
  batchVersionId: string;
  sourceScriptId: string;
  title: string;
  bodyText: string;
  sourceVersion: string;
  copyCount: number;
  createdAt: string;
}

function nowIso(now?: () => Date): string {
  return (now ?? (() => new Date()))().toISOString();
}

/**
 * 登记项目脚本。同一来源(script_drafts 或明确保存的外部文案)在项目内
 * 只保留一份;再次导入只更新当前正文与标题,不重复建行。
 */
export function createProjectScript(
  db: Database.Database,
  projectId: string,
  input: {
    sourceKind: BatchScriptSourceKind;
    sourceId: string;
    title: string;
    bodyText: string;
    sourceVersion: string;
    now?: () => Date;
  },
): string {
  const updatedAt = nowIso(input.now);
  const existing = db.prepare(`
    SELECT id FROM batch_scripts WHERE projectId = ? AND sourceId = ?
  `).get(projectId, input.sourceId) as { id: string } | undefined;
  if (existing) {
    db.prepare(`
      UPDATE batch_scripts SET title = ?, bodyText = ?, sourceVersion = ?, updatedAt = ?
      WHERE id = ?
    `).run(input.title, input.bodyText, input.sourceVersion, updatedAt, existing.id);
    return existing.id;
  }
  const id = randomUUID();
  db.prepare(`
    INSERT INTO batch_scripts (id, projectId, sourceKind, sourceId, title, bodyText, sourceVersion, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, projectId, input.sourceKind, input.sourceId, input.title, input.bodyText, input.sourceVersion, updatedAt, updatedAt);
  return id;
}

export function getProjectScript(
  db: Database.Database,
  projectId: string,
  scriptId: string,
): BatchScriptRow | undefined {
  return db.prepare(`
    SELECT * FROM batch_scripts WHERE id = ? AND projectId = ?
  `).get(scriptId, projectId) as BatchScriptRow | undefined;
}

export function listProjectScripts(db: Database.Database, projectId: string): BatchScriptRow[] {
  return db.prepare(`
    SELECT * FROM batch_scripts WHERE projectId = ? ORDER BY createdAt, id
  `).all(projectId) as BatchScriptRow[];
}

/** 项目脚本在批次开始前可以继续修改 */
export function updateProjectScript(
  db: Database.Database,
  projectId: string,
  scriptId: string,
  input: {
    title: string;
    bodyText: string;
    sourceVersion: string;
    now?: () => Date;
  },
): void {
  const result = db.prepare(`
    UPDATE batch_scripts SET title = ?, bodyText = ?, sourceVersion = ?, updatedAt = ?
    WHERE id = ? AND projectId = ?
  `).run(input.title, input.bodyText, input.sourceVersion, nowIso(input.now), scriptId, projectId);
  if (result.changes === 0) {
    throw new Error('项目脚本不存在');
  }
}

/**
 * 把一份项目脚本连同其正文、标题、来源版本和生成份数固化为批次版本的脚本快照。
 * 快照一旦创建,上游脚本更新不会改写它;同一批次版本不能重复快照同一来源脚本。
 */
export function snapshotScriptIntoBatch(
  db: Database.Database,
  batchVersionId: string,
  input: {
    scriptId: string;
    copyCount: number;
    now?: () => Date;
  },
): string {
  const createdAt = nowIso(input.now);
  return db.transaction(() => {
    const script = db.prepare(`
      SELECT id, title, bodyText, sourceVersion FROM batch_scripts WHERE id = ?
    `).get(input.scriptId) as Pick<BatchScriptRow, 'id' | 'title' | 'bodyText' | 'sourceVersion'> | undefined;
    if (!script) {
      throw new Error('项目脚本不存在');
    }
    const duplicate = db.prepare(`
      SELECT 1 FROM batch_script_snapshots WHERE batchVersionId = ? AND sourceScriptId = ?
    `).get(batchVersionId, input.scriptId);
    if (duplicate) {
      throw new Error('同一批次版本不能重复快照同一来源脚本');
    }
    const id = randomUUID();
    db.prepare(`
      INSERT INTO batch_script_snapshots (id, batchVersionId, sourceScriptId, title, bodyText, sourceVersion, copyCount, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      batchVersionId,
      script.id,
      script.title,
      script.bodyText,
      script.sourceVersion,
      input.copyCount,
      createdAt,
    );
    return id;
  })();
}

export function getScriptSnapshot(
  db: Database.Database,
  batchVersionId: string,
  snapshotId: string,
): BatchScriptSnapshotRow | undefined {
  return db.prepare(`
    SELECT * FROM batch_script_snapshots WHERE id = ? AND batchVersionId = ?
  `).get(snapshotId, batchVersionId) as BatchScriptSnapshotRow | undefined;
}

export function listScriptSnapshots(db: Database.Database, batchVersionId: string): BatchScriptSnapshotRow[] {
  return db.prepare(`
    SELECT * FROM batch_script_snapshots WHERE batchVersionId = ? ORDER BY createdAt, id
  `).all(batchVersionId) as BatchScriptSnapshotRow[];
}
