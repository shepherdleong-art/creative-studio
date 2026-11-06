import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { assertNoSymlinkPath, safeMaintenanceId } from './paths.ts';

export const MAINTENANCE_ACTIONS = ['backup.create', 'release.execute', 'restore.execute', 'cleanup.execute'] as const;
export type MaintenanceAction = typeof MAINTENANCE_ACTIONS[number];
export type MaintenanceBackupType = 'manual' | 'pre-upgrade' | 'pre-restore';
export type MaintenanceTarget =
  | { kind: 'backup'; backupType: MaintenanceBackupType }
  | { kind: 'release'; candidateId: string }
  | { kind: 'restore'; backupType: 'daily' | 'manual' | 'pre-upgrade' | 'pre-restore'; backupId: string }
  | { kind: 'cleanup'; previewId: string };

export interface MaintenancePrincipal {
  userId: string;
  employeeId: string;
  displayName: string;
  role: 'admin';
}

export type MaintenanceJobStatus = 'queued' | 'running' | 'awaiting_confirmation' | 'succeeded' | 'failed' | 'needs_review';
export interface MaintenanceJob {
  schemaVersion: 1;
  id: string;
  deploymentId: string;
  action: MaintenanceAction;
  target: MaintenanceTarget;
  status: MaintenanceJobStatus;
  stage: 'queued' | 'starting' | 'snapshotting' | 'copying_media' | 'verifying' | 'awaiting_confirmation' | 'cutting_over' | 'finishing' | 'completed' | 'failed'
    | 'preflight' | 'maintenance' | 'drain' | 'capture' | 'stop' | 'backup'
    | 'switch' | 'start_maintenance' | 'migrate' | 'self_check' | 'resume';
  progress: number | null;
  requestedBy: MaintenancePrincipal;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  result: Record<string, unknown> | null;
  error: { code: string; message: string } | null;
  reviewReason: string | null;
  integrity: 'ok' | 'audit_corrupt';
  message?: string;
}

export interface MaintenanceAudit {
  schemaVersion: 1;
  auditId: number;
  jobId: string;
  action: MaintenanceAction;
  target: MaintenanceTarget;
  event: string;
  at: string;
  actor: MaintenancePrincipal | { userId: 'system'; employeeId: 'system'; displayName: '受控执行器'; role: 'admin' };
  details: Record<string, unknown> | null;
}

export class MaintenanceControlError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'MaintenanceControlError';
  }
}

export function maintenanceStorePaths(backupRoot: string) {
  return {
    root: path.join(backupRoot, 'maintenance-control'),
    database: path.join(backupRoot, 'maintenance-control', 'jobs.db'),
    audit: path.join(backupRoot, 'maintenance-control', 'audit.jsonl'),
  };
}

function targetHash(target: MaintenanceTarget): string {
  return JSON.stringify(target);
}

function validateTarget(target: MaintenanceTarget): void {
  if (!target || typeof target !== 'object' || !['backup', 'release', 'restore', 'cleanup'].includes(target.kind)) {
    throw new MaintenanceControlError('invalid_target', '维护目标无效。');
  }
  const id = target.kind === 'backup' ? target.backupType
    : target.kind === 'release' ? target.candidateId
      : target.kind === 'restore' ? target.backupId : target.previewId;
  safeMaintenanceId(id, '维护目标');
  if (target.kind === 'backup' && !['manual', 'pre-upgrade', 'pre-restore'].includes(target.backupType)) {
    throw new MaintenanceControlError('invalid_target', '网页备份只允许固定用途。');
  }
  if (target.kind === 'restore' && !['daily', 'manual', 'pre-upgrade', 'pre-restore'].includes(target.backupType)) {
    throw new MaintenanceControlError('invalid_target', '还原备份用途无效。');
  }
}

function mapJob(row: Record<string, unknown>): MaintenanceJob {
  return {
    schemaVersion: 1, id: String(row.id), deploymentId: String(row.deploymentId),
    action: row.action as MaintenanceAction, target: JSON.parse(String(row.targetJson)) as MaintenanceTarget,
    status: row.status as MaintenanceJobStatus, stage: row.stage as MaintenanceJob['stage'],
    progress: row.progress as number | null,
    requestedBy: JSON.parse(String(row.principalJson)) as MaintenancePrincipal,
    createdAt: String(row.createdAt), updatedAt: String(row.updatedAt),
    startedAt: row.startedAt as string | null, finishedAt: row.finishedAt as string | null,
    leaseOwner: row.leaseOwner as string | null, leaseExpiresAt: row.leaseExpiresAt as string | null,
    result: row.resultJson ? JSON.parse(String(row.resultJson)) as Record<string, unknown> : null,
    error: row.errorJson ? JSON.parse(String(row.errorJson)) as MaintenanceJob['error'] : null,
    reviewReason: row.reviewReason as string | null, integrity: 'ok',
  };
}

export class MaintenanceJobStore {
  private readonly db: Database.Database;
  private readonly auditPath: string;
  private closed = false;

  private readonly options: { backupRoot: string; deploymentId: string };
  constructor(options: { backupRoot: string; deploymentId: string }) {
    this.options = options;
    safeMaintenanceId(options.deploymentId, 'deploymentId');
    const paths = maintenanceStorePaths(options.backupRoot);
    assertNoSymlinkPath(paths.root);
    fs.mkdirSync(paths.root, { recursive: true, mode: 0o700 });
    this.auditPath = paths.audit;
    this.db = new Database(paths.database);
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS maintenance_jobs (
        id TEXT PRIMARY KEY, deploymentId TEXT NOT NULL, action TEXT NOT NULL,
        targetJson TEXT NOT NULL, targetHash TEXT NOT NULL, idempotencyKey TEXT NOT NULL,
        status TEXT NOT NULL, stage TEXT NOT NULL, progress INTEGER,
        principalJson TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
        startedAt TEXT, finishedAt TEXT, leaseOwner TEXT, leaseExpiresAt TEXT,
        resultJson TEXT, errorJson TEXT, reviewReason TEXT,
        UNIQUE(deploymentId, action, targetHash, idempotencyKey)
      );
      CREATE INDEX IF NOT EXISTS idx_maintenance_active
        ON maintenance_jobs(deploymentId, status) WHERE status IN ('queued', 'running');
      CREATE TABLE IF NOT EXISTS maintenance_lease (
        deploymentId TEXT PRIMARY KEY, jobId TEXT NOT NULL, workerId TEXT NOT NULL, expiresAt TEXT NOT NULL,
        FOREIGN KEY(jobId) REFERENCES maintenance_jobs(id)
      );
    `);
  }

  close(): void {
    if (!this.closed) { this.db.close(); this.closed = true; }
  }

  private now(now?: Date): string { return (now ?? new Date()).toISOString(); }

  private appendAudit(job: MaintenanceJob, event: string, at: string, details?: Record<string, unknown>): void {
    const record = {
      schemaVersion: 1, auditId: randomUUID(), jobId: job.id, action: job.action, target: job.target,
      event, at, actor: job.requestedBy, ...(details ? { details } : {}),
    };
    const fd = fs.openSync(this.auditPath, 'a', 0o600);
    try { fs.writeFileSync(fd, `${JSON.stringify(record)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }

  private read(id: string): MaintenanceJob | null {
    const row = this.db.prepare('SELECT * FROM maintenance_jobs WHERE id = ? AND deploymentId = ?')
      .get(id, this.options.deploymentId) as Record<string, unknown> | undefined;
    return row ? mapJob(row) : null;
  }

  submit(options: {
    action: MaintenanceAction; target: MaintenanceTarget; principal: MaintenancePrincipal;
    idempotencyKey: string; retryRelease?: boolean; now?: Date;
  }): { job: MaintenanceJob; created: boolean } {
    if (!MAINTENANCE_ACTIONS.includes(options.action)) throw new MaintenanceControlError('invalid_action', '维护动作无效。');
    if (options.action.split('.')[0] !== options.target.kind) throw new MaintenanceControlError('invalid_target', '动作与维护目标不匹配。');
    validateTarget(options.target);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(options.idempotencyKey)) {
      throw new MaintenanceControlError('invalid_idempotency_key', '请求标识无效。');
    }
    if (options.principal.role !== 'admin' || !options.principal.userId || !options.principal.employeeId || !options.principal.displayName) {
      throw new MaintenanceControlError('admin_required', '仅管理员可发起维护。');
    }
    const at = this.now(options.now);
    return this.db.transaction(() => {
      const existing = this.db.prepare(`SELECT * FROM maintenance_jobs
        WHERE deploymentId = ? AND action = ? AND targetHash = ? AND idempotencyKey = ?`)
        .get(this.options.deploymentId, options.action, targetHash(options.target), options.idempotencyKey) as Record<string, unknown> | undefined;
      if (existing) {
        const job = mapJob(existing);
        if (job.requestedBy.userId !== options.principal.userId) throw new MaintenanceControlError('idempotency_conflict', '请求标识已被另一管理员使用。');
        return { job, created: false };
      }
      if (options.retryRelease === true && options.action === 'release.execute') {
        const previous = this.db.prepare(`SELECT * FROM maintenance_jobs WHERE deploymentId = ? AND action = 'release.execute'
          AND targetHash = ? AND status = 'failed' ORDER BY createdAt DESC LIMIT 1`)
          .get(this.options.deploymentId, targetHash(options.target)) as Record<string, unknown> | undefined;
        if (previous) {
          const job = mapJob(previous);
          if (job.requestedBy.userId !== options.principal.userId) throw new MaintenanceControlError('maintenance_conflict', '只能由原管理员续跑失败升级。');
          if (this.withIntegrity(job).integrity !== 'ok') throw new MaintenanceControlError('maintenance_review_required', '升级审计不完整，拒绝续跑。');
          this.db.prepare(`UPDATE maintenance_jobs SET status = 'queued', stage = 'queued', errorJson = NULL,
            finishedAt = NULL, leaseOwner = NULL, leaseExpiresAt = NULL, resultJson = NULL, updatedAt = ?,
            idempotencyKey = ? WHERE id = ?`).run(at, options.idempotencyKey, job.id);
          this.appendAudit(job, 'retry_requested', at);
          return { job: this.read(job.id)!, created: true };
        }
      }
      const conflict = this.db.prepare("SELECT id FROM maintenance_jobs WHERE deploymentId = ? AND status IN ('queued', 'running', 'awaiting_confirmation')")
        .get(this.options.deploymentId);
      if (conflict) {
        const current = this.read((conflict as { id: string }).id)!;
        if (this.withIntegrity(current).integrity !== 'ok') throw new MaintenanceControlError('maintenance_review_required', '维护审计不完整，请核查后再操作。');
        throw new MaintenanceControlError('maintenance_conflict', '已有维护作业待执行或运行中，请完成后再操作。');
      }
      const review = this.db.prepare("SELECT id FROM maintenance_jobs WHERE deploymentId = ? AND status = 'needs_review' LIMIT 1")
        .get(this.options.deploymentId);
      if (review) throw new MaintenanceControlError('maintenance_review_required', '存在执行结果不明的维护作业，请核查后才能继续。');
      const job: MaintenanceJob = {
        schemaVersion: 1, id: randomUUID(), deploymentId: this.options.deploymentId,
        action: options.action, target: options.target, status: 'queued', stage: 'queued', progress: null,
        requestedBy: { ...options.principal }, createdAt: at, updatedAt: at, startedAt: null, finishedAt: null,
        leaseOwner: null, leaseExpiresAt: null, result: null, error: null, reviewReason: null, integrity: 'ok',
      };
      this.db.prepare(`INSERT INTO maintenance_jobs (
        id, deploymentId, action, targetJson, targetHash, idempotencyKey, status, stage, progress,
        principalJson, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        job.id, job.deploymentId, job.action, JSON.stringify(job.target), targetHash(job.target), options.idempotencyKey,
        job.status, job.stage, job.progress, JSON.stringify(job.requestedBy), job.createdAt, job.updatedAt,
      );
      this.appendAudit(job, 'submitted', at);
      return { job, created: true };
    })();
  }

  get(id: string): { job: MaintenanceJob } {
    safeMaintenanceId(id, 'jobId');
    const job = this.read(id);
    if (!job) throw new MaintenanceControlError('job_not_found', '维护作业不存在。');
    return { job: this.withIntegrity(job) };
  }

  private withIntegrity(job: MaintenanceJob): MaintenanceJob {
    if (job.status !== 'needs_review' && !fs.existsSync(this.auditPath)) return job;
    let corrupt = false;
    let hasSubmitted = false;
    let terminal = false;
    if (fs.existsSync(this.auditPath)) {
      for (const line of fs.readFileSync(this.auditPath, 'utf8').split(/\r?\n/).filter(Boolean)) {
        try {
          const record = JSON.parse(line) as MaintenanceAudit;
          if (record.schemaVersion !== 1 || record.jobId !== job.id || typeof record.event !== 'string') continue;
          if (record.event === 'submitted') hasSubmitted = true;
          if (['succeeded', 'failed', 'needs_review'].includes(record.event)) terminal = true;
        } catch { corrupt = true; }
      }
    }
    if (corrupt || !hasSubmitted || (!terminal && !['queued', 'running', 'awaiting_confirmation'].includes(job.status))) {
      return { ...job, integrity: 'audit_corrupt', message: '维护审计记录损坏或不完整，请核查，不要重跑。' };
    }
    return job;
  }

  list(limit = 50): { jobs: MaintenanceJob[] } {
    const bounded = Math.min(100, Math.max(1, Math.trunc(limit)));
    return {
      jobs: (this.db.prepare('SELECT * FROM maintenance_jobs WHERE deploymentId = ? ORDER BY createdAt DESC LIMIT ?')
        .all(this.options.deploymentId, bounded) as Array<Record<string, unknown>>).map((row) => this.withIntegrity(mapJob(row))),
    };
  }

  claimNext(options: { workerId: string; jobId?: string; now?: Date; leaseMs?: number }): { job: MaintenanceJob } | null {
    safeMaintenanceId(options.workerId, 'workerId');
    if (options.jobId) this.get(options.jobId);
    const at = this.now(options.now);
    this.reconcile({ workerId: options.workerId, now: new Date(at) });
    const interruptedRelease = this.db.prepare("SELECT id FROM maintenance_jobs WHERE deploymentId = ? AND status = 'running' AND action = 'release.execute'")
      .get(this.options.deploymentId);
    if (interruptedRelease) return null;
    return this.db.transaction(() => {
      const held = this.db.prepare('SELECT * FROM maintenance_lease WHERE deploymentId = ? AND expiresAt > ?')
        .get(this.options.deploymentId, at) as { jobId: string; workerId: string } | undefined;
      if (held) throw new MaintenanceControlError('maintenance_conflict', '另一受控执行器正在执行维护。');
      const running = this.db.prepare("SELECT * FROM maintenance_jobs WHERE deploymentId = ? AND status = 'running'")
        .get(this.options.deploymentId) as Record<string, unknown> | undefined;
      if (running) throw new MaintenanceControlError('maintenance_conflict', '已有作业处于执行状态。');
      if (options.jobId) {
        const awaited = this.db.prepare(`SELECT id FROM maintenance_jobs WHERE id = ? AND deploymentId = ? AND status = 'awaiting_confirmation'`)
          .get(options.jobId, this.options.deploymentId);
        if (awaited) return null;
      }
      const row = this.db.prepare(`SELECT * FROM maintenance_jobs WHERE deploymentId = ? AND status = 'queued'
        ${options.jobId ? 'AND id = ?' : ''} ORDER BY createdAt LIMIT 1`)
        .get(...(options.jobId ? [this.options.deploymentId, options.jobId] : [this.options.deploymentId])) as Record<string, unknown> | undefined;
      if (!row) return null;
      const job = mapJob(row);
      this.db.prepare(`UPDATE maintenance_jobs SET status = 'running', stage = ?, startedAt = COALESCE(startedAt, ?),
        updatedAt = ?, leaseOwner = ?, leaseExpiresAt = ? WHERE id = ?`)
        .run(job.result ? 'cutting_over' : 'starting', at, at, options.workerId, new Date(new Date(at).getTime() + (options.leaseMs ?? 60_000)).toISOString(), job.id);
      this.db.prepare('INSERT INTO maintenance_lease (deploymentId, jobId, workerId, expiresAt) VALUES (?, ?, ?, ?)')
        .run(this.options.deploymentId, job.id, options.workerId, new Date(new Date(at).getTime() + (options.leaseMs ?? 60_000)).toISOString());
      this.appendAudit(job, 'started', at, { workerId: options.workerId });
      return { job: this.read(job.id)! };
    })();
  }

  updateStage(options: { jobId: string; workerId: string; stage: MaintenanceJob['stage']; now?: Date; leaseMs?: number }): MaintenanceJob {
    const at = this.now(options.now);
    return this.db.transaction(() => {
      const job = this.assertLease(options.jobId, options.workerId, at);
      const lease = this.db.prepare('SELECT expiresAt FROM maintenance_lease WHERE deploymentId = ?').get(this.options.deploymentId) as { expiresAt: string };
      if (lease.expiresAt <= at) throw new MaintenanceControlError('worker_lease_lost', '执行租约已过期，状态需人工核查。');
      const expiresAt = new Date(new Date(at).getTime() + (options.leaseMs ?? 60_000)).toISOString();
      this.db.prepare('UPDATE maintenance_jobs SET stage = ?, updatedAt = ?, leaseExpiresAt = ? WHERE id = ?')
        .run(options.stage, at, expiresAt, job.id);
      this.db.prepare('UPDATE maintenance_lease SET expiresAt = ? WHERE deploymentId = ?').run(expiresAt, this.options.deploymentId);
      this.appendAudit(job, options.stage, at);
      return this.read(job.id)!;
    })();
  }

  awaitConfirmation(options: { jobId: string; workerId: string; result: Record<string, unknown>; now?: Date }): MaintenanceJob {
    const at = this.now(options.now);
    return this.db.transaction(() => {
      const job = this.assertLease(options.jobId, options.workerId, at);
      this.db.prepare(`UPDATE maintenance_jobs SET status = 'awaiting_confirmation', stage = 'awaiting_confirmation',
        resultJson = ?, updatedAt = ?, leaseOwner = NULL, leaseExpiresAt = NULL WHERE id = ?`)
        .run(JSON.stringify(options.result), at, job.id);
      this.db.prepare('DELETE FROM maintenance_lease WHERE deploymentId = ?').run(this.options.deploymentId);
      this.appendAudit(job, 'awaiting_confirmation', at, options.result);
      return this.read(job.id)!;
    })();
  }

  confirm(options: { jobId: string; principal: MaintenancePrincipal; now?: Date }): { job: MaintenanceJob } {
    const at = this.now(options.now);
    return this.db.transaction(() => {
      const job = this.read(options.jobId);
      if (!job || job.action !== 'restore.execute' || job.status !== 'awaiting_confirmation') {
        throw new MaintenanceControlError('restore_not_ready', '备份尚未完成隔离还原与校验，不能确认切换。');
      }
      if (job.requestedBy.userId !== options.principal.userId) {
        throw new MaintenanceControlError('restore_initiator_required', '只能由发起本次还原的管理员确认切换。');
      }
      this.db.prepare(`UPDATE maintenance_jobs SET status = 'queued', stage = 'queued', updatedAt = ? WHERE id = ?`)
        .run(at, job.id);
      this.appendAudit(job, 'cutover_confirmed', at);
      return { job: this.read(job.id)! };
    })();
  }

  private assertLease(jobId: string, workerId: string, at: string): MaintenanceJob {
    const job = this.read(jobId);
    if (!job) throw new MaintenanceControlError('job_not_found', '维护作业不存在。');
    const lease = this.db.prepare('SELECT * FROM maintenance_lease WHERE deploymentId = ? AND jobId = ?')
      .get(this.options.deploymentId, jobId) as { workerId: string; expiresAt: string } | undefined;
    if (!lease || lease.workerId !== workerId || lease.expiresAt <= at || job.leaseOwner !== workerId || job.status !== 'running') {
      throw new MaintenanceControlError('worker_lease_lost', '执行器不再持有有效作业租约。');
    }
    return job;
  }

  /** Application replacement is a lease-safe state machine, not a killable backup lease. */
  resumeRelease(options: { workerId: string; now?: Date; leaseMs?: number }): { job: MaintenanceJob } | null {
    safeMaintenanceId(options.workerId, 'workerId');
    const at = this.now(options.now);
    this.reconcile({ workerId: options.workerId, now: new Date(at) });
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT * FROM maintenance_jobs WHERE deploymentId = ? AND status = 'running' AND action = 'release.execute'")
        .get(this.options.deploymentId) as Record<string, unknown> | undefined;
      if (!row) return null;
      const job = mapJob(row);
      const lease = this.db.prepare('SELECT * FROM maintenance_lease WHERE deploymentId = ?').get(this.options.deploymentId) as { workerId: string } | undefined;
      if (lease && lease.workerId !== options.workerId && new Date(job.leaseExpiresAt ?? 0).getTime() > new Date(at).getTime()) {
        // The global schema-upgrade lock is still held by this new worker. Its old lease proves
        // only the dead process's identity, not a live executor that can advance this operation.
        this.appendAudit(job, 'executor_replaced', at, { previousWorkerId: lease.workerId, nextWorkerId: options.workerId });
      }
      const expiresAt = new Date(new Date(at).getTime() + (options.leaseMs ?? 60_000)).toISOString();
      this.db.prepare('UPDATE maintenance_jobs SET leaseOwner = ?, leaseExpiresAt = ?, updatedAt = ? WHERE id = ?')
        .run(options.workerId, expiresAt, at, job.id);
      this.db.prepare('DELETE FROM maintenance_lease WHERE deploymentId = ?').run(this.options.deploymentId);
      this.db.prepare('INSERT INTO maintenance_lease (deploymentId, jobId, workerId, expiresAt) VALUES (?, ?, ?, ?)')
        .run(this.options.deploymentId, job.id, options.workerId, expiresAt);
      this.appendAudit(job, 'resumed', at, { workerId: options.workerId });
      return { job: this.read(job.id)! };
    })();
  }

  complete(options: { jobId: string; workerId: string; result: Record<string, unknown>; now?: Date }): MaintenanceJob {
    const at = this.now(options.now);
    return this.db.transaction(() => {
      const job = this.assertLease(options.jobId, options.workerId, at);
      this.db.prepare(`UPDATE maintenance_jobs SET status = 'succeeded', stage = 'completed', resultJson = ?,
        updatedAt = ?, finishedAt = ?, leaseOwner = NULL, leaseExpiresAt = NULL WHERE id = ?`)
        .run(JSON.stringify(options.result), at, at, job.id);
      this.db.prepare('DELETE FROM maintenance_lease WHERE deploymentId = ?').run(this.options.deploymentId);
      this.appendAudit(job, 'succeeded', at, options.result);
      return this.read(job.id)!;
    })();
  }

  fail(options: { jobId: string; workerId: string; code: string; message: string; now?: Date }): MaintenanceJob {
    const at = this.now(options.now);
    return this.db.transaction(() => {
      const job = this.assertLease(options.jobId, options.workerId, at);
      const error = { code: options.code.slice(0, 80), message: options.message.slice(0, 500) };
      this.db.prepare(`UPDATE maintenance_jobs SET status = 'failed', stage = 'failed', errorJson = ?,
        updatedAt = ?, finishedAt = ?, leaseOwner = NULL, leaseExpiresAt = NULL WHERE id = ?`)
        .run(JSON.stringify(error), at, at, job.id);
      this.db.prepare('DELETE FROM maintenance_lease WHERE deploymentId = ?').run(this.options.deploymentId);
      this.appendAudit(job, 'failed', at, error);
      return this.read(job.id)!;
    })();
  }

  reconcile(options: { workerId: string; now?: Date }): { needsReviewJobIds: string[] } {
    const at = this.now(options.now);
    return this.db.transaction(() => {
      const expired = this.db.prepare("SELECT * FROM maintenance_jobs WHERE deploymentId = ? AND status = 'running' AND action = 'backup.create' AND leaseExpiresAt <= ?")
        .all(this.options.deploymentId, at) as Array<Record<string, unknown>>;
      const ids: string[] = [];
      for (const row of expired) {
        const job = mapJob(row);
        this.db.prepare(`UPDATE maintenance_jobs SET status = 'needs_review', errorJson = ?, reviewReason = ?,
          updatedAt = ?, leaseOwner = NULL, leaseExpiresAt = NULL WHERE id = ?`)
          .run(JSON.stringify({ code: 'execution_unknown', message: '执行器中断，备份或维护结果需要核查。' }),
            '执行租约已过期，不能确认是否完成；拒绝自动重跑。', at, job.id);
        this.appendAudit(job, 'needs_review', at, { workerId: options.workerId, reason: 'lease_expired' });
        ids.push(job.id);
      }
      this.db.prepare('DELETE FROM maintenance_lease WHERE deploymentId = ? AND expiresAt <= ?')
        .run(this.options.deploymentId, at);
      return { needsReviewJobIds: ids };
    })();
  }

  audit(jobId: string): MaintenanceAudit[] {
    this.get(jobId);
    if (!fs.existsSync(this.auditPath)) return [];
    const records: MaintenanceAudit[] = [];
    for (const line of fs.readFileSync(this.auditPath, 'utf8').split(/\r?\n/).filter(Boolean)) {
      try {
        const record = JSON.parse(line) as MaintenanceAudit;
        if (record.schemaVersion === 1 && record.jobId === jobId && typeof record.event === 'string') records.push(record);
      } catch { /* 损坏记录由待核查扫描报告，不静默重写审计。 */ }
    }
    return records;
  }
}
