import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { AccessActor } from '../../media-core/access-context.ts';
import type { ResourceRef } from '../../media-core/access-context.ts';
import {
  registerRootScope,
  requireResourceAccess,
  ResourceAccessError,
  type TeamResourceScope,
} from '../resource-scopes.ts';
import { deleteProjectRecords } from '../../project-delete.ts';
import { resolveStoragePath } from '../../media-core/storage-path.ts';

export interface LifecycleMutation extends ResourceRef {
  deletedAt?: string;
  restored: boolean;
  scopeCount: number;
}

function readScope(db: Database.Database, ref: ResourceRef): TeamResourceScope | undefined {
  return db.prepare(`
    SELECT * FROM team_resource_scopes WHERE resourceType = ? AND resourceId = ?
  `).get(ref.resourceType, ref.resourceId) as TeamResourceScope | undefined;
}

function descendants(db: Database.Database, ref: ResourceRef): TeamResourceScope[] {
  return db.prepare(`
    WITH RECURSIVE tree(resourceType, resourceId) AS (
      SELECT ?, ?
      UNION
      SELECT s.resourceType, s.resourceId FROM team_resource_scopes s
      JOIN tree t ON s.parentType = t.resourceType AND s.parentId = t.resourceId
    )
    SELECT s.* FROM team_resource_scopes s
    JOIN tree t ON s.resourceType = t.resourceType AND s.resourceId = t.resourceId
  `).all(ref.resourceType, ref.resourceId) as TeamResourceScope[];
}

function assertLifecycleOwner(scope: TeamResourceScope | undefined, principal: AccessActor): TeamResourceScope {
  if (!scope) throw new ResourceAccessError('resource_not_found', '资源不存在或不可用。');
  if (principal.role !== 'admin' && scope.ownerUserId !== principal.userId) {
    throw new ResourceAccessError('resource_forbidden', '无权访问此资源。', 403);
  }
  return scope;
}

export function softDeleteResource(
  db: Database.Database,
  principal: AccessActor,
  ref: ResourceRef,
  now: () => Date = () => new Date(),
): LifecycleMutation & { deletedAt: string } {
  requireResourceAccess(db, principal, ref.resourceType, ref.resourceId, 'write');
  const at = now().toISOString();
  return db.transaction(() => {
    const scopes = descendants(db, ref);
    const eventId = randomUUID();
    db.prepare(`
      INSERT INTO team_lifecycle_events (id, action, resourceType, resourceId, actorUserId, createdAt)
      VALUES (?, 'delete', ?, ?, ?, ?)
    `).run(eventId, ref.resourceType, ref.resourceId, principal.userId, at);
    const insertEventScope = db.prepare(`
      INSERT INTO team_lifecycle_event_scopes (eventId, resourceType, resourceId) VALUES (?, ?, ?)
    `);
    const markDeleted = db.prepare(`
      UPDATE team_resource_scopes SET deletedAt = ?, deletedBy = ?, updatedAt = ?
      WHERE resourceType = ? AND resourceId = ? AND deletedAt IS NULL
    `);
    let scopeCount = 0;
    for (const scope of scopes) {
      const changed = markDeleted.run(at, principal.userId, at, scope.resourceType, scope.resourceId).changes;
      if (changed === 1) insertEventScope.run(eventId, scope.resourceType, scope.resourceId);
      scopeCount += changed;
    }
    return { ...ref, deletedAt: at, restored: false, scopeCount };
  }).immediate();
}

export function restoreResource(
  db: Database.Database,
  principal: AccessActor,
  ref: ResourceRef,
  now: () => Date = () => new Date(),
): LifecycleMutation {
  const scope = assertLifecycleOwner(readScope(db, ref), principal);
  if (!scope.deletedAt) return { ...ref, restored: false, scopeCount: 0 };
  if (scope.parentType && scope.parentId) {
    const parent = readScope(db, { resourceType: scope.parentType, resourceId: scope.parentId });
    if (parent?.deletedAt) throw new ResourceAccessError('scope_inconsistent', '请先恢复父资源。', 409);
  }
  const deletion = db.prepare(`
    SELECT id, createdAt, actorUserId FROM team_lifecycle_events
    WHERE resourceType = ? AND resourceId = ? AND action = 'delete'
    ORDER BY createdAt DESC, rowid DESC LIMIT 1
  `).get(ref.resourceType, ref.resourceId) as { id: string; createdAt: string; actorUserId: string } | undefined;
  if (!deletion) throw new ResourceAccessError('scope_inconsistent', '删除记录不完整，无法恢复。', 409);
  const at = now().toISOString();
  return db.transaction(() => {
    const rows = db.prepare(`
      SELECT resourceType, resourceId FROM team_lifecycle_event_scopes WHERE eventId = ?
    `).all(deletion.id) as ResourceRef[];
    const restore = db.prepare(`
      UPDATE team_resource_scopes SET deletedAt = NULL, deletedBy = NULL, updatedAt = ?
      WHERE resourceType = ? AND resourceId = ? AND deletedAt = ? AND deletedBy = ?
    `);
    let scopeCount = 0;
    for (const row of rows) {
      scopeCount += restore.run(at, row.resourceType, row.resourceId, deletion.createdAt, deletion.actorUserId).changes;
    }
    const eventId = randomUUID();
    db.prepare(`
      INSERT INTO team_lifecycle_events (id, action, resourceType, resourceId, actorUserId, createdAt)
      VALUES (?, 'restore', ?, ?, ?, ?)
    `).run(eventId, ref.resourceType, ref.resourceId, principal.userId, at);
    const insertEventScope = db.prepare(`
      INSERT INTO team_lifecycle_event_scopes (eventId, resourceType, resourceId) VALUES (?, ?, ?)
    `);
    for (const row of rows) insertEventScope.run(eventId, row.resourceType, row.resourceId);
    return { ...ref, restored: scopeCount > 0, scopeCount };
  }).immediate();
}

export function listRecycleBin(db: Database.Database, principal: AccessActor): TeamResourceScope[] {
  const owner = principal.role === 'admin' ? '' : 'AND s.ownerUserId = ?';
  return db.prepare(`
    SELECT s.* FROM team_resource_scopes s
    WHERE s.deletedAt IS NOT NULL ${owner}
      AND NOT EXISTS (
        SELECT 1 FROM team_resource_scopes parent
        WHERE parent.resourceType = s.parentType AND parent.resourceId = s.parentId
          AND parent.deletedAt IS NOT NULL
      )
    ORDER BY s.deletedAt DESC, s.resourceType, s.resourceId
  `).all(...(principal.role === 'admin' ? [] : [principal.userId])) as TeamResourceScope[];
}

/** ticket 11 的自动交付入口只消费此合同；手工下载仍走正常资源授权。 */
export function isAutomaticDeliverySuppressed(db: Database.Database, projectId: string): boolean {
  const scope = readScope(db, { resourceType: 'project', resourceId: projectId });
  return !scope || scope.deletedAt !== null;
}

export type CleanupBlockerKind = 'backup' | 'cross_module' | 'accepted_task' | 'inflight_operation' | 'maintenance_barrier';
export interface CleanupBlocker {
  kind: CleanupBlockerKind;
  resourceType?: string;
  resourceId?: string;
  fileId?: string;
  detail: string;
}

export interface CleanupJobView extends ResourceRef {
  id: string;
  status: 'pending' | 'running' | 'deferred' | 'completed' | 'failed';
  phase: 'plan' | 'database' | 'files' | 'done';
  blockers: CleanupBlocker[];
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

interface CleanupJobRow {
  id: string;
  resourceType: string;
  resourceId: string;
  requestedBy: string;
  status: CleanupJobView['status'];
  phase: CleanupJobView['phase'];
  blockersJson: string;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

function assertAdmin(principal: AccessActor): void {
  if (principal.role !== 'admin') throw new ResourceAccessError('resource_forbidden', '只有管理员可以执行永久清理或维护操作。', 403);
}

function cleanupView(row: CleanupJobRow): CleanupJobView {
  return {
    id: row.id,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    status: row.status,
    phase: row.phase,
    blockers: JSON.parse(row.blockersJson || '[]') as CleanupBlocker[],
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function cleanupJob(db: Database.Database, jobId: string): CleanupJobRow {
  const row = db.prepare('SELECT * FROM team_cleanup_jobs WHERE id = ?').get(jobId) as CleanupJobRow | undefined;
  if (!row) throw new ResourceAccessError('resource_not_found', '清理任务不存在。');
  return row;
}

export function createBackupPin(
  db: Database.Database,
  principal: AccessActor,
  input: { releaseId: string; configVersion: string; fileIds: string[] },
  now: () => Date = () => new Date(),
): { id: string; releaseId: string; configVersion: string; fileIds: string[] } {
  assertAdmin(principal);
  const fileIds = [...new Set(input.fileIds)];
  if (!input.releaseId.trim() || !input.configVersion.trim() || fileIds.length === 0) {
    throw new ResourceAccessError('scope_inconsistent', '备份 pin 需要 release、配置版本和文件清单。', 400);
  }
  const id = randomUUID();
  const at = now().toISOString();
  db.transaction(() => {
    const cleaning = db.prepare(`
      SELECT 1 FROM team_cleanup_files cf JOIN team_cleanup_jobs cj ON cj.id = cf.jobId
      WHERE cf.fileId = ? AND cj.status = 'running' LIMIT 1
    `);
    const insertReference = db.prepare(`
      INSERT INTO team_file_references (fileId, resourceType, resourceId, role, pinKind, createdAt)
      VALUES (?, 'backup_pin', ?, 'backup', 'backup', ?)
    `);
    db.prepare(`
      INSERT INTO team_backup_pins (id, ownerUserId, releaseId, configVersion, createdAt)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, principal.userId, input.releaseId, input.configVersion, at);
    registerRootScope(db, { resourceType: 'backup_pin', resourceId: id, ownerUserId: principal.userId });
    for (const fileId of fileIds) {
      const file = db.prepare("SELECT 1 FROM team_files WHERE id = ? AND state = 'ready'").get(fileId);
      if (!file) throw new ResourceAccessError('resource_not_found', '只能 pin 已就绪的不可变文件。');
      if (cleaning.get(fileId)) throw new ResourceAccessError('scope_inconsistent', '文件正在物理清理，不能建立备份 pin。', 409);
      insertReference.run(fileId, id, at);
    }
  }).immediate();
  return { id, releaseId: input.releaseId, configVersion: input.configVersion, fileIds };
}

export function releaseBackupPin(
  db: Database.Database,
  principal: AccessActor,
  pinId: string,
  now: () => Date = () => new Date(),
): boolean {
  assertAdmin(principal);
  const at = now().toISOString();
  return db.transaction(() => {
    const result = db.prepare(`
      UPDATE team_backup_pins SET releasedAt = ? WHERE id = ? AND releasedAt IS NULL
    `).run(at, pinId);
    if (result.changes === 0) return false;
    db.prepare(`
      UPDATE team_file_references SET releasedAt = ?
      WHERE resourceType = 'backup_pin' AND resourceId = ? AND releasedAt IS NULL
    `).run(at, pinId);
    return true;
  }).immediate();
}

export function acquireLifecycleBarrier(
  db: Database.Database,
  principal: AccessActor,
  kind: 'backup' | 'release' | 'config',
  metadata: Record<string, unknown> = {},
  now: () => Date = () => new Date(),
): { id: string; kind: typeof kind; metadata: Record<string, unknown>; createdAt: string } {
  assertAdmin(principal);
  const id = randomUUID();
  const at = now().toISOString();
  db.transaction(() => {
    const running = db.prepare("SELECT 1 FROM team_cleanup_jobs WHERE status = 'running' LIMIT 1").get();
    if (running) throw new ResourceAccessError('scope_inconsistent', '物理清理正在执行，暂不能建立维护屏障。', 409);
    const active = db.prepare('SELECT 1 FROM team_lifecycle_barriers WHERE releasedAt IS NULL LIMIT 1').get();
    if (active) throw new ResourceAccessError('scope_inconsistent', '已有维护屏障生效，不能并发进入发布、配置或备份临界区。', 409);
    db.prepare(`
      INSERT INTO team_lifecycle_barriers (id, kind, ownerUserId, metadataJson, createdAt)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, kind, principal.userId, JSON.stringify(metadata), at);
  }).immediate();
  return { id, kind, metadata, createdAt: at };
}

export function releaseLifecycleBarrier(
  db: Database.Database,
  principal: AccessActor,
  barrierId: string,
  now: () => Date = () => new Date(),
): boolean {
  assertAdmin(principal);
  return db.prepare(`
    UPDATE team_lifecycle_barriers SET releasedAt = ? WHERE id = ? AND releasedAt IS NULL
  `).run(now().toISOString(), barrierId).changes === 1;
}

export function getPermanentCleanupJob(db: Database.Database, jobId: string): CleanupJobView {
  return cleanupView(cleanupJob(db, jobId));
}

export function requestPermanentCleanup(
  db: Database.Database,
  principal: AccessActor,
  ref: ResourceRef,
  now: () => Date = () => new Date(),
): CleanupJobView {
  assertAdmin(principal);
  const currentScope = readScope(db, ref);
  if (currentScope && !currentScope.deletedAt) {
    throw new ResourceAccessError('scope_inconsistent', '只有回收站中的资源可以永久清理。', 409);
  }
  const existing = db.prepare(`
    SELECT * FROM team_cleanup_jobs WHERE resourceType = ? AND resourceId = ?
    ORDER BY createdAt DESC, rowid DESC LIMIT 1
  `).get(ref.resourceType, ref.resourceId) as CleanupJobRow | undefined;
  if (existing) return cleanupView(existing);
  assertLifecycleOwner(currentScope, principal);
  const id = randomUUID();
  const at = now().toISOString();
  db.prepare(`
    INSERT INTO team_cleanup_jobs (
      id, resourceType, resourceId, requestedBy, status, phase, blockersJson, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, 'pending', 'plan', '[]', ?, ?)
  `).run(id, ref.resourceType, ref.resourceId, principal.userId, at, at);
  return cleanupView(cleanupJob(db, id));
}

function scopeKey(ref: ResourceRef): string {
  return `${ref.resourceType}:${ref.resourceId}`;
}

function activeBarriers(db: Database.Database): CleanupBlocker[] {
  return (db.prepare('SELECT kind FROM team_lifecycle_barriers WHERE releasedAt IS NULL').all() as Array<{ kind: string }>)
    .map((row) => ({ kind: 'maintenance_barrier' as const, detail: `维护屏障 ${row.kind} 正在生效。` }));
}

function cleanupCandidates(db: Database.Database, scopes: TeamResourceScope[]): string[] {
  if (scopes.length === 0) return [];
  const candidates = new Set<string>();
  const findReferences = db.prepare(`
    SELECT fileId FROM team_file_references
    WHERE resourceType = ? AND resourceId = ? AND releasedAt IS NULL
  `);
  for (const scope of scopes) {
    for (const row of findReferences.all(scope.resourceType, scope.resourceId) as Array<{ fileId: string }>) {
      candidates.add(row.fileId);
    }
  }
  const derived = db.prepare('SELECT id FROM team_files WHERE derivedFromFileId = ?');
  const queue = [...candidates];
  for (let index = 0; index < queue.length; index += 1) {
    for (const row of derived.all(queue[index]) as Array<{ id: string }>) {
      if (!candidates.has(row.id)) { candidates.add(row.id); queue.push(row.id); }
    }
  }
  return [...candidates];
}

function referenceBlockers(
  db: Database.Database,
  scopes: TeamResourceScope[],
  fileIds: string[],
): CleanupBlocker[] {
  const purgeScopes = new Set(scopes.map(scopeKey));
  const blockers: CleanupBlocker[] = [];
  const readReferences = db.prepare(`
    SELECT fileId, resourceType, resourceId, pinKind FROM team_file_references
    WHERE fileId = ? AND releasedAt IS NULL
  `);
  for (const fileId of fileIds) {
    for (const reference of readReferences.all(fileId) as Array<{
      fileId: string; resourceType: string; resourceId: string; pinKind: string;
    }>) {
      const internal = purgeScopes.has(scopeKey(reference));
      if (reference.pinKind === 'backup') {
        blockers.push({
          kind: 'backup', fileId, resourceType: reference.resourceType, resourceId: reference.resourceId,
          detail: '文件仍被备份 pin 引用。',
        });
      } else if (reference.pinKind === 'accepted_task') {
        blockers.push({
          kind: 'accepted_task', fileId, resourceType: reference.resourceType, resourceId: reference.resourceId,
          detail: '文件仍被已接受任务引用。',
        });
      } else if (!internal) {
        blockers.push({
          kind: 'cross_module', fileId, resourceType: reference.resourceType, resourceId: reference.resourceId,
          detail: '文件仍被清理范围外的模块或版本引用。',
        });
      }
    }
  }
  return blockers;
}

function executionBlockers(db: Database.Database, scopes: TeamResourceScope[]): CleanupBlocker[] {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'execution_operations'").get()) return [];
  const purgeScopes = new Set(scopes.map(scopeKey));
  const rows = db.prepare(`
    SELECT id, scopeType, scopeId FROM execution_operations
    WHERE status NOT IN ('succeeded', 'failed')
  `).all() as Array<{ id: string; scopeType: string; scopeId: string }>;
  return rows.filter((row) => purgeScopes.has(scopeKey({ resourceType: row.scopeType, resourceId: row.scopeId })))
    .map((row) => ({
      kind: 'inflight_operation' as const,
      resourceType: row.scopeType,
      resourceId: row.scopeId,
      detail: `在途操作 ${row.id} 尚未终态。`,
    }));
}

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function imageBusinessBlockers(db: Database.Database, scopes: TeamResourceScope[]): CleanupBlocker[] {
  const images = new Set(scopes.filter((scope) => scope.resourceType === 'image').map((scope) => scope.resourceId));
  if (images.size === 0) return [];
  const purgeScopes = new Set(scopes.map(scopeKey));
  const blockers: CleanupBlocker[] = [];
  const external = (resourceType: string, resourceId: string, imageId: string) => {
    if (!purgeScopes.has(`${resourceType}:${resourceId}`)) {
      blockers.push({
        kind: 'cross_module', resourceType, resourceId,
        detail: `图片 ${imageId} 仍被 ${resourceType}:${resourceId} 引用。`,
      });
    }
  };
  if (tableExists(db, 'jobs')) {
    const rows = db.prepare('SELECT id, inputImageId, outputImageId, referenceImageIds FROM jobs').all() as Array<{
      id: string; inputImageId: string | null; outputImageId: string | null; referenceImageIds: string;
    }>;
    for (const row of rows) {
      let references: unknown[] = [];
      try { references = JSON.parse(row.referenceImageIds || '[]') as unknown[]; } catch { references = []; }
      for (const imageId of [row.inputImageId, row.outputImageId, ...references]) {
        if (typeof imageId === 'string' && images.has(imageId)) external('job', row.id, imageId);
      }
    }
  }
  const direct: Array<{ table: string; resourceType: string; columns: string[] }> = [
    { table: 'scene_references', resourceType: 'scene_reference', columns: ['imageAssetId'] },
    { table: 'shots', resourceType: 'shot', columns: ['sourceImageId', 'latestGeneratedImageId'] },
    { table: 'video_jobs', resourceType: 'video_job', columns: ['sourceImageId', 'tailImageId'] },
  ];
  for (const relation of direct) {
    if (!tableExists(db, relation.table)) continue;
    const rows = db.prepare(`SELECT id, ${relation.columns.join(', ')} FROM ${relation.table}`).all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      for (const column of relation.columns) {
        const imageId = row[column];
        if (typeof imageId === 'string' && images.has(imageId)) external(relation.resourceType, String(row.id), imageId);
      }
    }
  }
  return blockers;
}

function batchHistoryBlockers(db: Database.Database, scopes: TeamResourceScope[]): CleanupBlocker[] {
  const ids = (type: string) => new Set(scopes.filter((scope) => scope.resourceType === type).map((scope) => scope.resourceId));
  const scripts = ids('batch_script');
  const versions = ids('batch_version');
  const plans = ids('batch_plan');
  const outputVersions = ids('batch_output_version');
  const batches = ids('batch');
  const projects = ids('project');
  const blockers: CleanupBlocker[] = [];
  const add = (resourceType: string, resourceId: string, detail: string) => {
    blockers.push({ kind: 'cross_module', resourceType, resourceId, detail });
  };
  if (tableExists(db, 'batch_script_snapshots') && (scripts.size > 0 || versions.size > 0)) {
    const rows = db.prepare('SELECT id, batchVersionId, sourceScriptId FROM batch_script_snapshots').all() as Array<{
      id: string; batchVersionId: string; sourceScriptId: string;
    }>;
    for (const row of rows) {
      if (scripts.has(row.sourceScriptId) || versions.has(row.batchVersionId)) {
        add('batch_script_snapshot', row.id, '批量脚本仍被历史快照或冻结批次版本引用。');
      }
    }
  }
  if (tableExists(db, 'batch_output_plans') && (versions.size > 0 || plans.size > 0)) {
    const rows = db.prepare('SELECT id, batchVersionId FROM batch_output_plans').all() as Array<{ id: string; batchVersionId: string }>;
    for (const row of rows) {
      if (versions.has(row.batchVersionId) || plans.has(row.id)) {
        add('batch_plan', row.id, '批次仍有成片计划及历史版本引用。');
      }
    }
  }
  if (tableExists(db, 'batch_artifacts') && (projects.size > 0 || batches.size > 0 || versions.size > 0
    || plans.size > 0 || outputVersions.size > 0)) {
    const rows = db.prepare(`
      SELECT id, projectId, batchId, batchVersionId, outputPlanId, outputVersionId FROM batch_artifacts
    `).all() as Array<{
      id: string; projectId: string; batchId: string; batchVersionId: string; outputPlanId: string; outputVersionId: string;
    }>;
    for (const row of rows) {
      if (projects.has(row.projectId) || batches.has(row.batchId) || versions.has(row.batchVersionId)
        || plans.has(row.outputPlanId) || outputVersions.has(row.outputVersionId)) {
        add('batch_artifact', row.id, '正式产物仍被历史成片版本引用。');
      }
    }
  }
  return blockers;
}

function uniqueBlockers(blockers: CleanupBlocker[]): CleanupBlocker[] {
  return [...new Map(blockers.map((blocker) => [
    `${blocker.kind}:${blocker.resourceType ?? ''}:${blocker.resourceId ?? ''}:${blocker.fileId ?? ''}:${blocker.detail}`,
    blocker,
  ])).values()];
}

function planBlockers(db: Database.Database, scopes: TeamResourceScope[], fileIds: string[]): CleanupBlocker[] {
  return uniqueBlockers([
    ...activeBarriers(db),
    ...referenceBlockers(db, scopes, fileIds),
    ...executionBlockers(db, scopes),
    ...imageBusinessBlockers(db, scopes),
    ...batchHistoryBlockers(db, scopes),
  ]);
}

const BUSINESS_TABLE: Record<string, string> = {
  project: 'projects', canvas: 'creative_canvases', image: 'image_assets', batch: 'batch_productions',
  batch_script: 'batch_scripts', project_script: 'project_scripts',
};

function deleteBusinessResource(db: Database.Database, ref: ResourceRef): void {
  if (ref.resourceType === 'project') {
    if (deleteProjectRecords(db, ref.resourceId) === null) throw new Error('项目实体已不存在。');
    return;
  }
  const table = BUSINESS_TABLE[ref.resourceType];
  if (!table || !tableExists(db, table)) throw new Error(`不支持永久清理资源类型 ${ref.resourceType}。`);
  const result = db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(ref.resourceId);
  if (result.changes !== 1) throw new Error('资源实体已不存在或仍受数据库引用保护。');
}

function deleteScopes(db: Database.Database, scopes: TeamResourceScope[]): void {
  const deletePrincipal = db.prepare('DELETE FROM team_task_principals WHERE scopeType = ? AND scopeId = ?');
  const deleteReferences = db.prepare(`
    DELETE FROM team_file_references WHERE resourceType = ? AND resourceId = ?
  `);
  for (const scope of scopes) {
    deletePrincipal.run(scope.resourceType, scope.resourceId);
    deleteReferences.run(scope.resourceType, scope.resourceId);
  }
  const pending = new Set(scopes.map(scopeKey));
  const deleteScope = db.prepare('DELETE FROM team_resource_scopes WHERE resourceType = ? AND resourceId = ?');
  while (pending.size > 0) {
    let progressed = false;
    for (const scope of scopes) {
      const key = scopeKey(scope);
      if (!pending.has(key)) continue;
      const hasPendingChild = scopes.some((candidate) => pending.has(scopeKey(candidate))
        && candidate.parentType === scope.resourceType && candidate.parentId === scope.resourceId);
      if (hasPendingChild) continue;
      deleteScope.run(scope.resourceType, scope.resourceId);
      pending.delete(key);
      progressed = true;
    }
    if (!progressed) throw new Error('资源归属树存在循环，无法清理。');
  }
}

function saveDeferred(db: Database.Database, jobId: string, phase: CleanupJobView['phase'], blockers: CleanupBlocker[], at: string): CleanupJobView {
  db.prepare(`
    UPDATE team_cleanup_jobs SET status = 'deferred', phase = ?, blockersJson = ?, error = NULL, updatedAt = ? WHERE id = ?
  `).run(phase, JSON.stringify(blockers), at, jobId);
  return cleanupView(cleanupJob(db, jobId));
}

function saveFailure(db: Database.Database, jobId: string, phase: CleanupJobView['phase'], error: unknown, at: string): CleanupJobView {
  const message = error instanceof Error ? error.message : String(error);
  db.prepare(`
    UPDATE team_cleanup_jobs SET status = 'failed', phase = ?, error = ?, updatedAt = ? WHERE id = ?
  `).run(phase, message, at, jobId);
  return cleanupView(cleanupJob(db, jobId));
}

export function runPermanentCleanup(
  db: Database.Database,
  options: {
    jobId: string;
    storageRoot: string;
    now?: () => Date;
    unlink?: (absolutePath: string) => void;
  },
): CleanupJobView {
  const now = options.now ?? (() => new Date());
  const unlink = options.unlink ?? ((absolutePath: string) => fs.unlinkSync(absolutePath));
  let job = cleanupJob(db, options.jobId);
  if (job.status === 'completed') return cleanupView(job);
  if (job.phase === 'plan' || job.phase === 'database') {
    const ref = { resourceType: job.resourceType, resourceId: job.resourceId };
    const scope = readScope(db, ref);
    if (scope && !scope.deletedAt) {
      throw new ResourceAccessError('scope_inconsistent', '资源已恢复，不再处于回收站，已停止永久清理。', 409);
    }
    if (scope) {
      const scopes = descendants(db, ref);
      const fileIds = cleanupCandidates(db, scopes);
      const blockers = planBlockers(db, scopes, fileIds);
      if (blockers.length > 0) return saveDeferred(db, job.id, 'plan', blockers, now().toISOString());
      const at = now().toISOString();
      try {
        db.transaction(() => {
          const currentScope = readScope(db, ref);
          if (!currentScope?.deletedAt) {
            throw new ResourceAccessError('scope_inconsistent', '资源已恢复，不再处于回收站，已停止永久清理。', 409);
          }
          const rechecked = planBlockers(db, descendants(db, ref), fileIds);
          if (rechecked.length > 0) throw new Error(`清理引用复核失败：${JSON.stringify(rechecked)}`);
          db.prepare(`
            UPDATE team_cleanup_jobs SET status = 'running', phase = 'database', blockersJson = '[]', error = NULL, updatedAt = ? WHERE id = ?
          `).run(at, job.id);
          db.prepare('DELETE FROM team_cleanup_files WHERE jobId = ?').run(job.id);
          const insertFile = db.prepare(`
            INSERT INTO team_cleanup_files (jobId, fileId, relativePath, status, updatedAt)
            SELECT ?, id, relativePath, 'pending', ? FROM team_files WHERE id = ?
          `);
          const markPending = db.prepare(`
            UPDATE team_files SET state = 'purge_pending', readySeq = NULL, readyAt = NULL WHERE id = ?
          `);
          for (const fileId of fileIds) {
            insertFile.run(job.id, at, fileId);
            markPending.run(fileId);
          }
          deleteBusinessResource(db, ref);
          deleteScopes(db, scopes);
          db.prepare("UPDATE team_cleanup_jobs SET phase = 'files', updatedAt = ? WHERE id = ?").run(at, job.id);
        }).immediate();
      } catch (error) {
        if (error instanceof ResourceAccessError) throw error;
        if ((error as { code?: string }).code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
          return saveDeferred(db, job.id, 'plan', [{
            kind: 'cross_module', ...ref, detail: '数据库仍存在外键或历史版本引用，物理清理已延期。',
          }], now().toISOString());
        }
        return saveFailure(db, job.id, 'plan', error, now().toISOString());
      }
    } else {
      db.prepare("UPDATE team_cleanup_jobs SET phase = 'files', status = 'running', updatedAt = ? WHERE id = ?")
        .run(now().toISOString(), job.id);
    }
  }

  job = cleanupJob(db, job.id);
  const files = db.prepare('SELECT * FROM team_cleanup_files WHERE jobId = ? ORDER BY rowid').all(job.id) as Array<{
    fileId: string; relativePath: string; status: string;
  }>;
  for (const file of files) {
    if (file.status === 'verified' || file.status === 'unlinked' || file.status === 'missing') continue;
    const blockers = activeBarriers(db);
    const activeReferences = db.prepare(`
      SELECT resourceType, resourceId, pinKind FROM team_file_references WHERE fileId = ? AND releasedAt IS NULL
    `).all(file.fileId) as Array<{ resourceType: string; resourceId: string; pinKind: string }>;
    for (const reference of activeReferences) {
      blockers.push({
        kind: reference.pinKind === 'backup' ? 'backup' : 'cross_module',
        fileId: file.fileId,
        ...reference,
        detail: '文件在物理清理前出现新的引用。',
      });
    }
    if (blockers.length > 0) return saveDeferred(db, job.id, 'files', uniqueBlockers(blockers), now().toISOString());
    const at = now().toISOString();
    try {
      const absolutePath = resolveStoragePath(options.storageRoot, file.relativePath);
      try {
        if (!fs.existsSync(absolutePath)) {
          db.prepare("UPDATE team_cleanup_files SET status = 'missing', error = NULL, updatedAt = ? WHERE jobId = ? AND fileId = ?")
            .run(at, job.id, file.fileId);
        } else {
          unlink(absolutePath);
          db.prepare("UPDATE team_cleanup_files SET status = 'unlinked', error = NULL, updatedAt = ? WHERE jobId = ? AND fileId = ?")
            .run(at, job.id, file.fileId);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          db.prepare("UPDATE team_cleanup_files SET status = 'missing', error = NULL, updatedAt = ? WHERE jobId = ? AND fileId = ?")
            .run(at, job.id, file.fileId);
        } else {
          throw error;
        }
      }
    } catch (error) {
      db.prepare('UPDATE team_cleanup_files SET error = ?, updatedAt = ? WHERE jobId = ? AND fileId = ?')
        .run(error instanceof Error ? error.message : String(error), at, job.id, file.fileId);
      return saveFailure(db, job.id, 'files', error, at);
    }
  }
  const at = now().toISOString();
  db.transaction(() => {
    db.prepare("UPDATE team_cleanup_files SET status = 'verified', updatedAt = ? WHERE jobId = ? AND status IN ('unlinked', 'missing')")
      .run(at, job.id);
    db.prepare("UPDATE team_cleanup_jobs SET status = 'completed', phase = 'done', blockersJson = '[]', error = NULL, updatedAt = ? WHERE id = ?")
      .run(at, job.id);
  }).immediate();
  return cleanupView(cleanupJob(db, job.id));
}

export function cleanupUnreferencedStaging(
  db: Database.Database,
  options: { storageRoot: string; candidates: string[] },
): { deleted: string[]; skipped: string[] } {
  const deleted: string[] = [];
  const skipped: string[] = [];
  for (const candidate of [...new Set(options.candidates)]) {
    const absolutePath = resolveStoragePath(options.storageRoot, candidate);
    const relativePath = path.relative(path.resolve(options.storageRoot), absolutePath).split(path.sep).join('/');
    const registered = db.prepare('SELECT 1 FROM team_files WHERE relativePath = ?').get(relativePath);
    if (registered) { skipped.push(relativePath); continue; }
    try {
      fs.unlinkSync(absolutePath);
      deleted.push(relativePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') deleted.push(relativePath);
      else skipped.push(relativePath);
    }
  }
  return { deleted, skipped };
}
