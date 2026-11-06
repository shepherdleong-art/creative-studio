import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { AccessActor } from '../../media-core/access-context.ts';
import { planCleanupBlockers, requestPermanentCleanup, runPermanentCleanup } from '../lifecycle/index.ts';
import type { TeamResourceScope } from '../resource-scopes.ts';
import { assertNoStorageSymlink } from '../../media-core/storage-path.ts';
import { assertNoSymlinkPath, assertSafeRelativePath, dataRootIdentity, safeMaintenanceId } from './paths.ts';
import { hasTeamRestoreHold } from './hold.ts';

export type CleanupCategory = 'failed_task_temporary' | 'expired_cache' | 'recycle_bin';
export type CleanupReasonCode = 'backup_pin' | 'inflight_operation' | 'valid_reference' | 'recoverable_task'
  | 'history_version' | 'restore_reconciliation' | 'maintenance_barrier' | 'path_changed' | 'missing_file' | 'delete_failed';
export interface CleanupProtectedItem { id: string; label: string; reasonCode: CleanupReasonCode; reason: string }
export interface CleanupCategoryView {
  kind: CleanupCategory; label: string; cleanableCount: number; estimatedBytes: number; protected: CleanupProtectedItem[];
}
export interface CleanupPreviewView {
  id: string; status: 'ready' | 'submitted' | 'completed'; createdAt: string; updatedAt: string;
  estimateNote: string; totals: { cleanableCount: number; estimatedBytes: number };
  categories: CleanupCategoryView[]; protectedSummary: Array<{ kind: string; reason: string }>;
}
export interface CleanupOutcomeItem { id: string; reasonCode: CleanupReasonCode; reason: string; error?: string }
export interface CleanupResult {
  previewId: string; deletedCount: number; deletedFileCount: number; freedBytes: number;
  skipped: CleanupOutcomeItem[]; failures: CleanupOutcomeItem[];
}
interface CandidateRow {
  candidateId: string; category: CleanupCategory; sourceType: 'failed_upload' | 'proxy_cache' | 'recycle_scopes';
  sourceId: string; relativePaths: string[]; estimatedBytes: number; fingerprintsJson?: string; jobId?: string | null; status?: string;
  freedBytes?: number; reasonCode?: CleanupReasonCode | null; error?: string | null;
}
interface Context {
  db: Database.Database; storageRoot: string; backupRoot: string; protectedDataRoots: string[]; store?: CleanupPreviewStore;
}
function tableExists(db: Database.Database, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}
function fingerprint(storageRoot: string, relativePath: string): string | null {
  try {
    const absolute = assertNoStorageSymlink(storageRoot, assertSafeRelativePath(relativePath));
    if (!fs.lstatSync(absolute).isFile()) return null;
    return createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
  } catch { return null; }
}
function statBytes(storageRoot: string, relativePath: string): number | null {
  try {
    assertSafeRelativePath(relativePath);
    const absolute = assertNoStorageSymlink(storageRoot, relativePath);
    const stat = fs.lstatSync(absolute);
    return stat.isFile() && !stat.isSymbolicLink() ? stat.size : null;
  } catch { return null; }
}
function descendants(db: Database.Database, ref: { resourceType: string; resourceId: string }): TeamResourceScope[] {
  return db.prepare(`WITH RECURSIVE tree(resourceType, resourceId) AS (
    SELECT ?, ? UNION SELECT s.resourceType, s.resourceId FROM team_resource_scopes s
    JOIN tree t ON s.parentType = t.resourceType AND s.parentId = t.resourceId
  ) SELECT s.* FROM team_resource_scopes s JOIN tree t ON s.resourceType = t.resourceType AND s.resourceId = t.resourceId`)
    .all(ref.resourceType, ref.resourceId) as TeamResourceScope[];
}
function scopeKey(value: { resourceType?: unknown; resourceId?: unknown }): string {
  return `${value.resourceType}:${value.resourceId}`;
}
function categoryLabel(category: CleanupCategory): string {
  return { failed_task_temporary: '失败任务临时文件', expired_cache: '过期缓存', recycle_bin: '回收站无引用产物' }[category];
}
function candidateRows(db: Database.Database, previewId: string): CandidateRow[] {
  return (db.prepare('SELECT * FROM candidates WHERE previewId = ? ORDER BY category, candidateId').all(previewId) as Array<Record<string, unknown>>)
    .map((row) => ({ ...row, relativePaths: JSON.parse(String(row.relativePathsJson)) as string[] })) as unknown as CandidateRow[];
}

/** 预览、绑定和执行明细独立于业务库，避免整套还原抹掉维护记录。 */
export class CleanupPreviewStore {
  private readonly controlDb: Database.Database;
  private closed = false;
  constructor(backupRoot: string) {
    const directory = path.join(backupRoot, 'maintenance-control');
    assertNoSymlinkPath(directory);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.controlDb = new Database(path.join(directory, 'cleanup.db'));
    this.controlDb.pragma('busy_timeout = 5000');
    this.controlDb.pragma('foreign_keys = ON');
    this.controlDb.pragma('journal_mode = WAL');
    this.controlDb.exec(`CREATE TABLE IF NOT EXISTS previews (
      id TEXT PRIMARY KEY, requestedBy TEXT NOT NULL, status TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
    ); CREATE TABLE IF NOT EXISTS candidates (
      previewId TEXT NOT NULL, candidateId TEXT NOT NULL, category TEXT NOT NULL, sourceType TEXT NOT NULL,
      sourceId TEXT NOT NULL, relativePathsJson TEXT NOT NULL, estimatedBytes INTEGER NOT NULL, fingerprintsJson TEXT, jobId TEXT,
      status TEXT NOT NULL DEFAULT 'pending', freedBytes INTEGER NOT NULL DEFAULT 0, reasonCode TEXT, error TEXT,
      createdAt TEXT NOT NULL, updatedAt TEXT, PRIMARY KEY(previewId, candidateId),
      FOREIGN KEY(previewId) REFERENCES previews(id) ON DELETE CASCADE
    ); CREATE TABLE IF NOT EXISTS protected_items (
      previewId TEXT NOT NULL, category TEXT NOT NULL, itemJson TEXT NOT NULL,
      FOREIGN KEY(previewId) REFERENCES previews(id) ON DELETE CASCADE
    ); CREATE TABLE IF NOT EXISTS preview_ownership (
      previewId TEXT PRIMARY KEY, dataRootIdentity TEXT NOT NULL,
      FOREIGN KEY(previewId) REFERENCES previews(id) ON DELETE CASCADE
    );`);
  }
  close(): void { if (!this.closed) { this.controlDb.close(); this.closed = true; } }
  get(previewId: string): CleanupPreviewView {
    safeMaintenanceId(previewId, 'previewId');
    const preview = this.controlDb.prepare('SELECT * FROM previews WHERE id = ?').get(previewId) as {
      id: string; status: CleanupPreviewView['status']; createdAt: string; updatedAt: string;
    } | undefined;
    if (!preview) throw new Error('清理预览不存在');
    const candidates = candidateRows(this.controlDb, previewId);
    const protectedItems = new Map<CleanupCategory, CleanupProtectedItem[]>();
    for (const row of this.controlDb.prepare('SELECT * FROM protected_items WHERE previewId = ?').all(previewId) as Array<{
      category: CleanupCategory; itemJson: string;
    }>) {
      const list = protectedItems.get(row.category) ?? [];
      list.push(JSON.parse(row.itemJson) as CleanupProtectedItem); protectedItems.set(row.category, list);
    }
    const categories = (['failed_task_temporary', 'expired_cache', 'recycle_bin'] as const).map((kind) => {
      const rows = candidates.filter((candidate) => candidate.category === kind);
      return { kind, label: categoryLabel(kind), cleanableCount: rows.length,
        estimatedBytes: rows.reduce((total, row) => total + row.estimatedBytes, 0), protected: protectedItems.get(kind) ?? [] };
    });
    return {
      id: preview.id, status: preview.status, createdAt: preview.createdAt, updatedAt: preview.updatedAt,
      estimateNote: '按预览时受管候选的实际文件大小估算；同一物理文件跨引用只计算一次，执行前会重新核验。',
      totals: { cleanableCount: candidates.length, estimatedBytes: candidates.reduce((total, row) => total + row.estimatedBytes, 0) },
      categories,
      protectedSummary: [
        { kind: 'backup_roots', reason: '备份目录、备份 pin 与还原点不参与清理。' },
        { kind: 'retained_data_roots', reason: '备份或还原后保留的数据根即使不再活动也受保护。' },
        { kind: 'project_assets', reason: '正常项目原素材、当前成片和历史正式产物不按时间清理。' },
        { kind: 'diagnostics_and_evidence', reason: '费用账本、执行证据与诊断审计不作为缓存。' },
      ],
    };
  }
  create(candidates: CandidateRow[], protectedItems: Record<CleanupCategory, CleanupProtectedItem[]>, at: string): CleanupPreviewView {
    const id = randomUUID();
    this.controlDb.transaction(() => {
      this.controlDb.prepare("INSERT INTO previews VALUES (?, 'unbound', 'ready', ?, ?)").run(id, at, at);
      const insert = this.controlDb.prepare(`INSERT INTO candidates (
        previewId, candidateId, category, sourceType, sourceId, relativePathsJson, estimatedBytes, fingerprintsJson, createdAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const candidate of candidates) insert.run(id, candidate.candidateId, candidate.category, candidate.sourceType,
        candidate.sourceId, JSON.stringify(candidate.relativePaths), candidate.estimatedBytes, candidate.fingerprintsJson ?? null, at);
      const protect = this.controlDb.prepare('INSERT INTO protected_items VALUES (?, ?, ?)');
      for (const category of Object.keys(protectedItems) as CleanupCategory[]) {
        for (const item of protectedItems[category]) protect.run(id, category, JSON.stringify(item));
      }
    }).immediate();
    return this.get(id);
  }
  bind(previewId: string, requestedBy: string, at = new Date().toISOString()): void {
    const result = this.controlDb.prepare(`UPDATE previews SET requestedBy = ?, status = 'submitted', updatedAt = ?
      WHERE id = ? AND (status = 'ready' OR (status IN ('submitted', 'completed') AND requestedBy = ?))`).run(requestedBy, at, previewId, requestedBy);
    if (result.changes !== 1) throw new Error('清理预览不存在、已提交给其他人或已完成');
  }
  candidates(previewId: string): CandidateRow[] { this.get(previewId); return candidateRows(this.controlDb, previewId); }
  requestedBy(previewId: string): string {
    this.get(previewId);
    return this.controlDb.prepare('SELECT requestedBy FROM previews WHERE id = ?').pluck().get(previewId) as string;
  }
  ownership(previewId: string): string {
    this.get(previewId);
    return this.controlDb.prepare("SELECT dataRootIdentity FROM preview_ownership WHERE previewId = ?").pluck().get(previewId) as string ?? '';
  }
  bindRoot(previewId: string, dataRootIdentity: string): void {
    const existing = this.ownership(previewId);
    if (existing && existing !== dataRootIdentity) throw new Error('清理预览属于其他数据根，拒绝跨范围执行');
    this.controlDb.prepare(`CREATE TABLE IF NOT EXISTS preview_ownership (
      previewId TEXT PRIMARY KEY, dataRootIdentity TEXT NOT NULL,
      FOREIGN KEY(previewId) REFERENCES previews(id) ON DELETE CASCADE
    )`).run();
    this.controlDb.prepare('INSERT OR IGNORE INTO preview_ownership VALUES (?, ?)').run(previewId, dataRootIdentity);
  }
  update(previewId: string, candidateId: string, value: { jobId?: string; status: 'completed' | 'skipped' | 'failed'; freedBytes: number; reasonCode?: CleanupReasonCode; error?: string }, at: string): void {
    this.controlDb.prepare(`UPDATE candidates SET jobId = COALESCE(?, jobId), status = ?, freedBytes = ?, reasonCode = ?, error = ?, updatedAt = ?
      WHERE previewId = ? AND candidateId = ?`).run(value.jobId ?? null, value.status, value.freedBytes, value.reasonCode ?? null, value.error ?? null, at, previewId, candidateId);
  }
  finish(previewId: string, at: string): void {
    const pending = this.controlDb.prepare("SELECT 1 FROM candidates WHERE previewId = ? AND status NOT IN ('completed', 'skipped') LIMIT 1").get(previewId);
    if (!pending) this.controlDb.prepare("UPDATE previews SET status = 'completed', updatedAt = ? WHERE id = ?").run(at, previewId);
  }
}

export function createCleanupPreview(input: Context & { now?: () => Date }): CleanupPreviewView {
  if (!input.backupRoot || input.protectedDataRoots.length === 0) throw new Error('清理必须明确活动及保留数据根');
  const at = (input.now?.() ?? new Date()).toISOString();
  const protectedItems: Record<CleanupCategory, CleanupProtectedItem[]> = { failed_task_temporary: [], expired_cache: [], recycle_bin: [] };
  const candidates: CandidateRow[] = [];
  const countedPaths = new Set<string>();
  const add = (candidate: CandidateRow): void => {
    const paths = [...new Set(candidate.relativePaths)].map(assertSafeRelativePath).sort();
    const bytes = paths.reduce((total, relativePath) => countedPaths.has(relativePath) ? total : total + (statBytes(input.storageRoot, relativePath) ?? 0), 0);
    paths.forEach((relativePath) => countedPaths.add(relativePath));
    const fingerprintsJson = JSON.stringify(paths.map((file) => fingerprint(input.storageRoot, file)));
    candidates.push({ ...candidate, relativePaths: paths, estimatedBytes: bytes, fingerprintsJson });
  };
  if (tableExists(input.db, 'team_uploads')) {
    for (const row of input.db.prepare("SELECT id, state FROM team_uploads WHERE state IN ('receiving', 'validating', 'staged', 'failed') ORDER BY id").all() as Array<{ id: string; state: string }>) {
      const root = path.join(input.storageRoot, 'team-staging', row.id);
      if (row.state !== 'failed') {
        if (fs.existsSync(root)) protectedItems.failed_task_temporary.push({ id: row.id, label: '上传临时文件', reasonCode: row.state === 'staged' ? 'recoverable_task' : 'inflight_operation', reason: '在途或可恢复上传仍需临时文件。' });
        continue;
      }
      if (!fs.existsSync(root) || fs.lstatSync(root).isSymbolicLink()) continue;
      const files: string[] = [];
      const pending = [root];
      while (pending.length > 0) {
        const directory = pending.pop()!;
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          const absolute = path.join(directory, entry.name);
          const relative = path.relative(input.storageRoot, absolute).split(path.sep).join('/');
          if (!relative.startsWith(`team-staging/${row.id}/`)) throw new Error('临时文件越出受管上传目录');
          if (entry.isSymbolicLink()) throw new Error('临时文件目录包含链接，拒绝扫描');
          if (entry.isDirectory()) pending.push(absolute);
          else if (entry.isFile()) files.push(relative);
        }
      }
      if (files.length > 0) add({ candidateId: `upload:${row.id}`, category: 'failed_task_temporary', sourceType: 'failed_upload', sourceId: row.id, relativePaths: files, estimatedBytes: 0 });
    }
  }
  if (tableExists(input.db, 'batch_proxy_cache_items')) {
    for (const row of input.db.prepare("SELECT * FROM batch_proxy_cache_items WHERE status = 'failed' OR pendingDeleteAt IS NOT NULL ORDER BY id").all() as Array<{
      id: string; relativePath: string; status: string; pendingDeleteAt: string | null;
    }>) {
      const active = tableExists(input.db, 'batch_proxy_requests') && Boolean(input.db.prepare(`SELECT 1 FROM batch_proxy_requests r
        JOIN batch_tasks t ON t.targetKind = 'proxy_request' AND t.targetId = r.id
        WHERE r.currentCacheItemId = ? AND t.status IN ('queued', 'running') LIMIT 1`).get(row.id));
      if (active) {
        protectedItems.expired_cache.push({ id: row.id, label: '代理缓存', reasonCode: 'inflight_operation', reason: '缓存仍被在途任务或可恢复请求使用。' });
        continue;
      }
      const relativePath = row.relativePath.startsWith('storage/') ? row.relativePath.slice('storage/'.length) : row.relativePath;
      if (tableExists(input.db, 'team_files') && input.db.prepare("SELECT 1 FROM team_files WHERE relativePath = ? AND state IN ('ready', 'purge_pending')").get(relativePath)) {
        protectedItems.expired_cache.push({ id: row.id, label: '代理缓存', reasonCode: 'valid_reference', reason: '缓存物理文件同时是已登记产物，须通过回收站保护流程处理。' });
        continue;
      }
      add({ candidateId: `cache:${row.id}`, category: row.status === 'failed' ? 'failed_task_temporary' : 'expired_cache', sourceType: 'proxy_cache', sourceId: row.id, relativePaths: [relativePath], estimatedBytes: 0 });
    }
  }
  const recycled = input.db.prepare(`SELECT * FROM team_resource_scopes WHERE deletedAt IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM team_resource_scopes p WHERE p.resourceType = team_resource_scopes.parentType AND p.resourceId = team_resource_scopes.parentId AND p.deletedAt IS NOT NULL
  ) ORDER BY resourceType, resourceId`).all() as TeamResourceScope[];
  const remaining = new Map(recycled.map((root) => [scopeKey(root), root]));
  while (remaining.size > 0) {
    const roots = [remaining.values().next().value!];
    const groupKeys = new Set<string>();
    const groupScopes: TeamResourceScope[] = [];
    const own = new Map<string, { id: string; relativePath: string }>();
    for (let index = 0; index < roots.length; index += 1) {
      const root = roots[index];
      const rootKey = scopeKey(root);
      if (!remaining.has(rootKey)) continue;
      remaining.delete(rootKey); groupKeys.add(rootKey);
      for (const scope of descendants(input.db, root)) {
        if (scope.parentType && scope.parentId) {
          groupScopes.push(scope); groupKeys.add(scopeKey(scope));
        }
      }
      const rows = input.db.prepare(`SELECT f.id, f.relativePath, r.resourceType, r.resourceId FROM team_files f
        JOIN team_file_references r ON r.fileId = f.id WHERE f.state IN ('ready', 'purge_pending') AND r.releasedAt IS NULL`).all() as Array<{
        id: string; relativePath: string; resourceType: string; resourceId: string;
      }>;
      for (const row of rows) {
        if (!groupKeys.has(scopeKey(row))) continue;
        own.set(row.id, { id: row.id, relativePath: row.relativePath });
        for (const candidate of remaining.values()) {
          if (candidate.resourceType === root.resourceType && candidate.resourceId === root.resourceId) continue;
          if (descendants(input.db, candidate).some((scope) => input.db.prepare('SELECT 1 FROM team_file_references WHERE fileId = ? AND resourceType = ? AND resourceId = ? AND releasedAt IS NULL')
            .get(row.id, scope.resourceType, scope.resourceId))) roots.push(candidate);
        }
      }
    }
    if (own.size === 0) continue;
    const blockers = planCleanupBlockers(input.db, groupScopes, [...own.keys()], roots);
    if (blockers.length > 0) {
      protectedItems.recycle_bin.push(...blockers.map((blocker) => ({ id: [...groupKeys].sort().join(','), label: '回收站产物',
        reasonCode: blocker.kind === 'backup' ? 'backup_pin' as const : blocker.kind === 'accepted_task' || blocker.kind === 'inflight_operation' ? 'inflight_operation' as const
          : blocker.kind === 'maintenance_barrier' ? 'maintenance_barrier' as const : 'valid_reference' as const, reason: blocker.detail })));
      continue;
    }
    add({ candidateId: `recycle:${randomUUID()}`, category: 'recycle_bin', sourceType: 'recycle_scopes',
      sourceId: roots.map(scopeKey).sort().join(','), relativePaths: [...own.values()].map((file) => file.relativePath), estimatedBytes: 0 });
  }
  const store = input.store ?? new CleanupPreviewStore(input.backupRoot);
  try {
    const preview = store.create(candidates, protectedItems, at);
    store.bindRoot(preview.id, dataRootIdentity(path.dirname(input.storageRoot)));
    return preview;
  } finally { if (!input.store) store.close(); }
}

function executionActor(db: Database.Database, userId: string): AccessActor {
  const row = db.prepare("SELECT id FROM team_users WHERE id = ? AND role = 'admin' AND status = 'active'").get(userId) as { id: string } | undefined;
  if (!row) throw new Error('预览绑定管理员已失效，拒绝清理');
  return { userId: row.id, role: 'admin' };
}
export function executeCleanupPreview(input: Context & {
  previewId: string; principal?: AccessActor; now?: () => Date; unlink?: (absolutePath: string) => void;
}): CleanupResult {
  const store = input.store ?? new CleanupPreviewStore(input.backupRoot);
  const skipped: CleanupOutcomeItem[] = [];
  const failures: CleanupOutcomeItem[] = [];
  const now = input.now ?? (() => new Date());
  const unlink = input.unlink ?? fs.unlinkSync;
  let deletedCount = 0; let deletedFileCount = 0; let freedBytes = 0;
  try {
    const candidates = store.candidates(input.previewId);
    store.bindRoot(input.previewId, dataRootIdentity(path.dirname(input.storageRoot)));
    if (store.get(input.previewId).status === 'ready') throw new Error('管理员尚未确认该预览，拒绝清理');
    const actor = input.principal ?? executionActor(input.db, store.requestedBy(input.previewId));
    if (actor.role !== 'admin' || (input.principal && actor.userId !== store.requestedBy(input.previewId))) throw new Error('只能由确认该预览的管理员执行清理');
    for (const root of input.protectedDataRoots) if (hasTeamRestoreHold(root)) {
      return { previewId: input.previewId, deletedCount, deletedFileCount, freedBytes,
        skipped: candidates.filter((row) => row.status !== 'completed').map((row) => ({ id: row.candidateId, reasonCode: 'restore_reconciliation', reason: '还原执行核查尚未完成，暂停清理。' })), failures };
    }
    for (const candidate of candidates) {
      if (candidate.status === 'completed' || (candidate.status === 'skipped' && !['valid_reference', 'restore_reconciliation', 'maintenance_barrier'].includes(candidate.reasonCode ?? ''))) continue;
      const at = now().toISOString();
      if (candidate.sourceType === 'recycle_scopes') {
        let failed: string | undefined;
        for (const key of candidate.sourceId.split(',')) {
          const [resourceType, resourceId] = key.split(':');
          try {
            const job = requestPermanentCleanup(input.db, actor, { resourceType, resourceId });
            store.update(input.previewId, candidate.candidateId, { jobId: job.id, status: 'failed', freedBytes: 0 }, at);
            const additionalPurgeScopes = candidate.sourceId.split(',').filter((other) => other !== key).map((other) => {
              const [resourceType, resourceId] = other.split(':'); return { resourceType, resourceId };
            });
            const result = runPermanentCleanup(input.db, { jobId: job.id, storageRoot: input.storageRoot, unlink, additionalPurgeScopes });
            if (result.status === 'deferred') throw new Error(result.blockers.map((item) => item.detail).join('；'));
            if (result.status === 'failed') throw new Error(result.error ?? '回收站产物清理失败');
          } catch (error) { failed = error instanceof Error ? error.message : String(error); break; }
        }
        if (failed) {
          skipped.push({ id: candidate.candidateId, reasonCode: 'valid_reference', reason: failed });
          store.update(input.previewId, candidate.candidateId, { status: 'skipped', freedBytes: 0, reasonCode: 'valid_reference', error: failed }, at);
        } else {
          const bytes = candidate.relativePaths.reduce((total, file) => total + (statBytes(input.storageRoot, file) === null ? candidate.estimatedBytes : 0), 0);
          deletedCount += 1; deletedFileCount += candidate.relativePaths.length; freedBytes += bytes;
          store.update(input.previewId, candidate.candidateId, { status: 'completed', freedBytes: bytes }, at);
        }
        continue;
      }
      if (candidate.sourceType === 'proxy_cache') {
        const proxyRoot = path.resolve(input.storageRoot, 'cache', 'proxies');
        const invalidPath = candidate.relativePaths.some((file) => {
          const absolute = path.resolve(input.storageRoot, ...file.split('/'));
          return absolute !== proxyRoot && !absolute.startsWith(`${proxyRoot}${path.sep}`);
        });
        if (invalidPath || input.db.prepare("SELECT 1 FROM team_files WHERE relativePath = ? AND state IN ('ready', 'purge_pending')").get(candidate.relativePaths[0])) {
          skipped.push({ id: candidate.candidateId, reasonCode: 'valid_reference', reason: '缓存已变成受管产物或越出受控代理范围，拒绝删除。' });
          store.update(input.previewId, candidate.candidateId, { status: 'skipped', freedBytes: 0, reasonCode: 'valid_reference' }, at); continue;
        }
      }
      const valid = candidate.sourceType === 'failed_upload'
        ? input.db.prepare("SELECT state FROM team_uploads WHERE id = ?").pluck().get(candidate.sourceId) === 'failed'
        : Boolean(input.db.prepare("SELECT 1 FROM batch_proxy_cache_items WHERE id = ? AND (status = 'failed' OR pendingDeleteAt IS NOT NULL)").get(candidate.sourceId));
      if (!valid) {
        skipped.push({ id: candidate.candidateId, reasonCode: 'valid_reference', reason: '候选状态已变化，可能恢复或重新被使用。' });
        store.update(input.previewId, candidate.candidateId, { status: 'skipped', freedBytes: 0, reasonCode: 'valid_reference' }, at); continue;
      }
      if (candidate.sourceType === 'proxy_cache' && tableExists(input.db, 'batch_proxy_requests') && input.db.prepare(`SELECT 1 FROM batch_proxy_requests r JOIN batch_tasks t ON t.targetKind = 'proxy_request' AND t.targetId = r.id
        WHERE r.currentCacheItemId = ? AND t.status IN ('queued', 'running')`).get(candidate.sourceId)) {
        skipped.push({ id: candidate.candidateId, reasonCode: 'inflight_operation', reason: '执行前发现新的在途缓存任务。' });
        store.update(input.previewId, candidate.candidateId, { status: 'skipped', freedBytes: 0, reasonCode: 'inflight_operation' }, at); continue;
      }
      const expectedFingerprints = JSON.parse(candidate.fingerprintsJson ?? '[]') as Array<string | null>;
      const substituted = candidate.relativePaths.some((file, index) => {
        if (!fs.existsSync(path.join(input.storageRoot, ...file.split('/')))) return false;
        return !expectedFingerprints[index] || fingerprint(input.storageRoot, file) !== expectedFingerprints[index];
      });
      if (substituted) {
        failures.push({ id: candidate.candidateId, reasonCode: 'path_changed', reason: '受管文件在预览后被替换或无法核验，拒绝删除。' });
        store.update(input.previewId, candidate.candidateId, { status: 'failed', freedBytes: 0, reasonCode: 'path_changed' }, at); continue;
      }
      const sizes = candidate.relativePaths.map((file) => statBytes(input.storageRoot, file));
      if (sizes.some((size, index) => size === null && fs.existsSync(path.join(input.storageRoot, ...candidate.relativePaths[index].split('/'))))) {
        failures.push({ id: candidate.candidateId, reasonCode: 'path_changed', reason: '文件路径或类型已变化，拒绝删除。' });
        store.update(input.previewId, candidate.candidateId, { status: 'failed', freedBytes: 0, reasonCode: 'path_changed' }, at); continue;
      }
      let candidateBytes = 0; let deleted = 0;
      for (let index = 0; index < candidate.relativePaths.length; index += 1) {
        const relativePath = candidate.relativePaths[index];
        if (candidate.sourceType === 'failed_upload' && input.db.prepare("SELECT state FROM team_uploads WHERE id = ?").pluck().get(candidate.sourceId) !== 'failed') {
          skipped.push({ id: candidate.candidateId, reasonCode: 'valid_reference', reason: '上传状态在删除期间发生变化。' });
          store.update(input.previewId, candidate.candidateId, { status: 'skipped', freedBytes: 0, reasonCode: 'valid_reference' }, at);
          break;
        }
        const absolute = assertNoStorageSymlink(input.storageRoot, relativePath);
        try { unlink(absolute); deleted += 1; candidateBytes += sizes[index] ?? 0; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failures.push({ id: candidate.candidateId, reasonCode: 'delete_failed', reason: '文件删除失败，保留候选供安全重试。', error: error instanceof Error ? error.message : String(error) });
        }
      }
      if (deleted > 0) { deletedCount += 1; deletedFileCount += deleted; freedBytes += candidateBytes; }
      store.update(input.previewId, candidate.candidateId, {
        status: failures.some((item) => item.id === candidate.candidateId) ? 'failed'
          : skipped.some((item) => item.id === candidate.candidateId) ? 'skipped' : 'completed',
        freedBytes: candidateBytes,
        ...(skipped.some((item) => item.id === candidate.candidateId) ? { reasonCode: 'valid_reference' as const } : {}),
      }, at);
    }
    store.finish(input.previewId, now().toISOString());
    return { previewId: input.previewId, deletedCount, deletedFileCount, freedBytes, skipped, failures };
  } finally { if (!input.store) store.close(); }
}
