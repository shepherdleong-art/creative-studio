import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  buildProjectBaseName,
  assertSafeIdentityName,
  ProjectIdentityError,
} from './project-production-identity.ts';
import type { ProjectProductionIdentity } from './project-production-identity.ts';

/**
 * 不可变导出身份（详见 `docs/superpowers/plans/2026-09-03-项目生产身份与脚本知识模板-执行方案.md`
 * §2.4 / §5.1）。首次正式导出时把当前生产身份冻结为 `project_export_identities` 修订；
 * 用户显式「启用新的导出名称」时追加新修订并切换当前指针，旧修订保持可追溯，
 * 旧文件不移动，运行中任务继续引用旧快照。
 *
 * 语义：
 * - `baseName` 与 `exportDirName` 使用同一个唯一消解结果（项目名与文件夹名同基础名）。
 * - `identityJson` 保存完整生产身份快照，读取端不得从文件名反推字段。
 * - 普通编辑不能静默改变已冻结身份；切换只能通过 `activateNewExportIdentity`。
 */

export interface ExportIdentityRecord {
  id: string;
  projectId: string;
  revisionNumber: number;
  baseName: string;
  exportDirName: string;
  identityJson: string;
  createdAt: string;
  supersededAt: string | null;
}

export interface ExportIdentityView {
  id: string;
  projectId: string;
  revisionNumber: number;
  baseName: string;
  exportDirName: string;
  identity: ProjectProductionIdentity;
  createdAt: string;
  supersededAt: string | null;
}

export interface CreateExportIdentityInput {
  projectId: string;
  identity: ProjectProductionIdentity;
  now?: Date;
}

function toView(record: ExportIdentityRecord): ExportIdentityView {
  let identity: ProjectProductionIdentity;
  try {
    identity = JSON.parse(record.identityJson) as ProjectProductionIdentity;
  } catch {
    throw new ProjectIdentityError('identity_corrupt', '导出身份快照损坏', 500);
  }
  return {
    id: record.id,
    projectId: record.projectId,
    revisionNumber: record.revisionNumber,
    baseName: record.baseName,
    exportDirName: record.exportDirName,
    identity,
    createdAt: record.createdAt,
    supersededAt: record.supersededAt,
  };
}

/** 身份表是否已迁移（旧库/测试内存库可能还没有这张表，读取路径应安全回落）。 */
function hasExportIdentitiesTable(db: Database.Database): boolean {
  try {
    return db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_export_identities'`).get() != null;
  } catch {
    return false;
  }
}

function nextRevisionNumber(db: Database.Database, projectId: string): number {
  const row = db
    .prepare(`SELECT MAX(revisionNumber) AS maxRev FROM project_export_identities WHERE projectId = ?`)
    .get(projectId) as { maxRev: number | null };
  return (row.maxRev ?? 0) + 1;
}

/**
 * 基础名与目录名共用同一个唯一消解：同时避开其他项目的 `projects.name`、
 * 其他项目已冻结的 `projects.exportDirName` 与身份表里的 `exportDirName`。
 */
function resolveUniqueBaseAndDir(db: Database.Database, base: string, projectId: string): string {
  let candidate = base;
  for (let sequence = 2; ; sequence += 1) {
    const nameTaken = db.prepare(`SELECT id FROM projects WHERE name = ? AND id != ?`).get(candidate, projectId);
    const dirTaken = db.prepare(`SELECT id FROM project_export_identities WHERE exportDirName = ?`).get(candidate)
      || db.prepare(`SELECT id FROM projects WHERE exportDirName = ? AND id != ?`).get(candidate, projectId);
    if (!nameTaken && !dirTaken) return candidate;
    candidate = `${base}-${String(sequence).padStart(2, '0')}`;
  }
}

/**
 * 冻结当前生产身份为新修订，并把它设为当前身份。同步镜像 `projects.name` /
 * `projects.exportDirName` / `projects.currentExportIdentityId`。
 */
export function createExportIdentity(
  db: Database.Database,
  input: CreateExportIdentityInput,
): ExportIdentityView {
  const base = buildProjectBaseName(input.identity);
  assertSafeIdentityName(base);
  const uniqueName = resolveUniqueBaseAndDir(db, base, input.projectId);
  assertSafeIdentityName(uniqueName);
  const record: ExportIdentityRecord = {
    id: crypto.randomUUID(),
    projectId: input.projectId,
    revisionNumber: nextRevisionNumber(db, input.projectId),
    baseName: uniqueName,
    exportDirName: uniqueName,
    identityJson: JSON.stringify(input.identity),
    createdAt: (input.now ?? new Date()).toISOString(),
    supersededAt: null,
  };
  db.prepare(`
    INSERT INTO project_export_identities (id, projectId, revisionNumber, baseName, exportDirName, identityJson, createdAt, supersededAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id, record.projectId, record.revisionNumber, record.baseName,
    record.exportDirName, record.identityJson, record.createdAt, record.supersededAt,
  );
  db.prepare(`UPDATE projects SET currentExportIdentityId = ?, exportDirName = ?, name = ? WHERE id = ?`)
    .run(record.id, record.exportDirName, record.baseName, record.projectId);
  return toView(record);
}

/**
 * 显式「启用新的导出名称」：旧修订标记 superseded，新身份成为当前身份。
 * 已有目录与产物保持原路径；历史任务继续引用旧快照。
 */
export function activateNewExportIdentity(
  db: Database.Database,
  input: CreateExportIdentityInput,
): ExportIdentityView {
  const base = buildProjectBaseName(input.identity);
  assertSafeIdentityName(base);
  const uniqueName = resolveUniqueBaseAndDir(db, base, input.projectId);
  assertSafeIdentityName(uniqueName);
  const now = (input.now ?? new Date()).toISOString();
  db.prepare(`UPDATE project_export_identities SET supersededAt = ? WHERE projectId = ? AND supersededAt IS NULL`)
    .run(now, input.projectId);
  const record: ExportIdentityRecord = {
    id: crypto.randomUUID(),
    projectId: input.projectId,
    revisionNumber: nextRevisionNumber(db, input.projectId),
    baseName: uniqueName,
    exportDirName: uniqueName,
    identityJson: JSON.stringify(input.identity),
    createdAt: now,
    supersededAt: null,
  };
  db.prepare(`
    INSERT INTO project_export_identities (id, projectId, revisionNumber, baseName, exportDirName, identityJson, createdAt, supersededAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id, record.projectId, record.revisionNumber, record.baseName,
    record.exportDirName, record.identityJson, record.createdAt, record.supersededAt,
  );
  db.prepare(`UPDATE projects SET currentExportIdentityId = ?, exportDirName = ?, name = ? WHERE id = ?`)
    .run(record.id, record.exportDirName, record.baseName, record.projectId);
  return toView(record);
}

export function getExportIdentity(db: Database.Database, identityId: string): ExportIdentityView {
  const record = db.prepare(`SELECT * FROM project_export_identities WHERE id = ?`).get(identityId) as ExportIdentityRecord | undefined;
  if (!record) throw new ProjectIdentityError('identity_not_found', '导出身份不存在', 404);
  return toView(record);
}

export function getCurrentExportIdentity(db: Database.Database, projectId: string): ExportIdentityView | null {
  if (!hasExportIdentitiesTable(db)) return null;
  const record = db.prepare(`
    SELECT * FROM project_export_identities WHERE id = (SELECT currentExportIdentityId FROM projects WHERE id = ?)
  `).get(projectId) as ExportIdentityRecord | undefined;
  return record ? toView(record) : null;
}

/** 当前导出目录名：优先冻结身份，未冻结返回 null（调用方回退旧解析）。 */
export function getCurrentExportDirName(db: Database.Database, projectId: string): string | null {
  return getCurrentExportIdentity(db, projectId)?.exportDirName ?? null;
}

/**
 * 首次正式导出时冻结当前生产身份；已冻结则复用当前身份，绝不重复创建修订。
 * 调用方必须保证 `identity` 字段完整（历史项目走「补齐项目信息」后再进入导出）。
 */
export function getOrCreateCurrentExportIdentity(
  db: Database.Database,
  projectId: string,
  identity: ProjectProductionIdentity,
  now?: Date,
): ExportIdentityView {
  const current = getCurrentExportIdentity(db, projectId);
  if (current) return current;
  return createExportIdentity(db, { projectId, identity, now });
}

export function listExportIdentities(db: Database.Database, projectId: string): ExportIdentityView[] {
  const records = db
    .prepare(`SELECT * FROM project_export_identities WHERE projectId = ? ORDER BY revisionNumber ASC`)
    .all(projectId) as ExportIdentityRecord[];
  return records.map(toView);
}

/** 项目是否已冻结过任何正式导出身份（用于决定编辑是否被 409 阻止）。 */
export function hasExportIdentity(db: Database.Database, projectId: string): boolean {
  if (!hasExportIdentitiesTable(db)) return false;
  const row = db.prepare(`SELECT 1 FROM project_export_identities WHERE projectId = ? LIMIT 1`).get(projectId);
  return row != null;
}
