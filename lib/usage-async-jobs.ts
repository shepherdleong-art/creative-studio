import type Database from 'better-sqlite3';

import {
  createCoreUsageSnapshot,
  resolveCoreUsagePlan,
  type CoreUsageProviderSnapshot,
} from './usage-pricing.ts';
import {
  recordUsage,
  type UsageOperationResult,
} from './usage-ledger.ts';
import { isUsageSchemaReady } from './usage-schema.ts';

export interface ImageUsageProviderIdentity {
  id: string;
  name?: string | null;
  type?: string | null;
  model?: string | null;
}

export interface PersistImageJobUsageSnapshotInput {
  jobId: string;
  projectId?: string | null;
  requestModel: string;
  provider: ImageUsageProviderIdentity;
  refType?: string;
  refId?: string;
  startedAt?: string;
}

export interface RecordImageJobUsageInput {
  jobId: string;
  projectId?: string | null;
  attempt?: number | null;
  snapshot?: string | null;
  finishedAt: string;
}

export interface VideoUsageProviderIdentity {
  id: string;
  name?: string | null;
  type?: string | null;
  model?: string | null;
  /** 解析期身份辅助：用于公司网关（回环地址）判定，不写入持久化快照。 */
  baseUrl?: string | null;
}

export interface PersistVideoJobUsageSnapshotInput {
  jobId: string;
  projectId?: string | null;
  requestModel: string;
  provider: VideoUsageProviderIdentity;
  refType?: string;
  refId?: string;
  startedAt?: string;
}

export interface RecordVideoJobUsageInput {
  jobId: string;
  projectId?: string | null;
  durationSec?: number | null;
  snapshot?: string | null;
  finishedAt: string;
}

function nonEmptySnapshot(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function readImageJobUsageSnapshot(db: Database.Database, jobId: string): string | null {
  try {
    const row = db.prepare(`SELECT usageSnapshotJson FROM jobs WHERE id = ?`).get(jobId) as
      { usageSnapshotJson?: unknown } | undefined;
    return nonEmptySnapshot(row?.usageSnapshotJson);
  } catch {
    return null;
  }
}

function hasExistingImageProviderTask(db: Database.Database, jobId: string): boolean {
  try {
    const row = db.prepare(`SELECT providerTaskId FROM jobs WHERE id = ?`).get(jobId) as
      { providerTaskId?: unknown } | undefined;
    return nonEmptySnapshot(row?.providerTaskId) !== null;
  } catch {
    // If the task column cannot be read, fail closed for snapshot creation.
    return true;
  }
}

/**
 * Freeze the eligible image provider's price before its first real request.
 * Existing non-empty snapshots always win, including when the usage schema is
 * currently unavailable, so retries and recovery retain their original price.
 */
export function persistImageJobUsageSnapshot(
  db: Database.Database,
  input: PersistImageJobUsageSnapshotInput,
): string | null {
  const existing = readImageJobUsageSnapshot(db, input.jobId);
  if (existing) return existing;
  if (hasExistingImageProviderTask(db, input.jobId)) return null;

  const provider: CoreUsageProviderSnapshot = {
    providerTable: 'providers',
    providerId: input.provider.id,
    providerName: input.provider.name ?? '',
    providerType: input.provider.type ?? '',
    configuredModel: input.provider.model ?? '',
    requestModel: input.requestModel,
  };
  const plan = resolveCoreUsagePlan(provider);
  if (!plan) return null;
  if (!isUsageSchemaReady(db)) {
    // 核心模型调用仍照常执行，但本次不进入消耗统计；必须留下脱敏告警。
    console.error('[usage-ledger] schema unavailable; usage accounting skipped for this image job');
    return null;
  }

  const snapshot = createCoreUsageSnapshot(provider, plan, {
    startedAt: input.startedAt,
    projectId: input.projectId ?? undefined,
    refType: input.refType ?? 'job',
    refId: input.refId ?? input.jobId,
  });
  const snapshotJson = JSON.stringify(snapshot);

  try {
    const result = db.prepare(`
      UPDATE jobs
      SET usageSnapshotJson = ?
      WHERE id = ?
        AND (usageSnapshotJson IS NULL OR TRIM(usageSnapshotJson) = '')
        AND (providerTaskId IS NULL OR TRIM(providerTaskId) = '')
    `).run(snapshotJson, input.jobId);
    if (result.changes === 1) return snapshotJson;
  } catch {
    // A missing/temporarily unavailable core column must not block the request.
    return null;
  }

  return readImageJobUsageSnapshot(db, input.jobId);
}

function positiveAttempt(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
}

/** Record one immutable image success from its already-frozen snapshot. */
export function recordImageJobUsage(
  db: Database.Database,
  input: RecordImageJobUsageInput,
): UsageOperationResult {
  const snapshot = nonEmptySnapshot(input.snapshot);
  if (!snapshot) return { ok: true, inserted: false };

  const attempt = positiveAttempt(input.attempt);
  try {
    return recordUsage(db, {
      eventKey: `image-job:${input.jobId}:succeeded`,
      snapshot,
      usage: {
        quantity: attempt,
        callCount: attempt,
        detail: { source: 'live', taskType: 'image-job' },
      },
      projectId: input.projectId,
      refType: 'job',
      refId: input.jobId,
      createdAt: input.finishedAt,
    });
  } catch {
    // Ledger failure is reconciled later and must never undo a succeeded job.
    return { ok: false, reason: 'write_failed' };
  }
}

function readVideoJobUsageSnapshot(db: Database.Database, jobId: string): string | null {
  try {
    const row = db.prepare(`SELECT usageSnapshotJson FROM video_jobs WHERE id = ?`).get(jobId) as
      { usageSnapshotJson?: unknown } | undefined;
    return nonEmptySnapshot(row?.usageSnapshotJson);
  } catch {
    return null;
  }
}

function hasExistingVideoProviderTask(db: Database.Database, jobId: string): boolean {
  try {
    const row = db.prepare(`SELECT providerTaskId FROM video_jobs WHERE id = ?`).get(jobId) as
      { providerTaskId?: unknown } | undefined;
    return nonEmptySnapshot(row?.providerTaskId) !== null;
  } catch {
    // If the task column cannot be read, fail closed for snapshot creation.
    return true;
  }
}

/**
 * Freeze an eligible video provider's price immediately before its first
 * adapter.submit. Existing snapshots win; an already submitted remote task
 * never receives a newly synthesized snapshot.
 */
export function persistVideoJobUsageSnapshot(
  db: Database.Database,
  input: PersistVideoJobUsageSnapshotInput,
): string | null {
  const existing = readVideoJobUsageSnapshot(db, input.jobId);
  if (existing) return existing;
  if (hasExistingVideoProviderTask(db, input.jobId)) return null;

  const provider: CoreUsageProviderSnapshot = {
    providerTable: 'video_providers',
    providerId: input.provider.id,
    providerName: input.provider.name ?? '',
    providerType: input.provider.type ?? '',
    configuredModel: input.provider.model ?? '',
    requestModel: input.requestModel,
    baseUrl: input.provider.baseUrl ?? '',
  };
  const plan = resolveCoreUsagePlan(provider);
  if (!plan) return null;
  if (!isUsageSchemaReady(db)) {
    // 核心模型调用仍照常执行，但本次不进入消耗统计；必须留下脱敏告警。
    console.error('[usage-ledger] schema unavailable; usage accounting skipped for this video job');
    return null;
  }

  const snapshot = createCoreUsageSnapshot(provider, plan, {
    startedAt: input.startedAt,
    projectId: input.projectId ?? undefined,
    refType: input.refType ?? 'video-job',
    refId: input.refId ?? input.jobId,
  });
  const snapshotJson = JSON.stringify(snapshot);

  try {
    const result = db.prepare(`
      UPDATE video_jobs
      SET usageSnapshotJson = ?
      WHERE id = ?
        AND (usageSnapshotJson IS NULL OR TRIM(usageSnapshotJson) = '')
        AND (providerTaskId IS NULL OR TRIM(providerTaskId) = '')
    `).run(snapshotJson, input.jobId);
    if (result.changes === 1) return snapshotJson;
  } catch {
    // A missing/temporarily unavailable core column must not block submission.
    return null;
  }

  return readVideoJobUsageSnapshot(db, input.jobId);
}

function nonNegativeDuration(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}

/** Record one immutable video success from its already-frozen snapshot. */
export function recordVideoJobUsage(
  db: Database.Database,
  input: RecordVideoJobUsageInput,
): UsageOperationResult {
  const snapshot = nonEmptySnapshot(input.snapshot) ?? readVideoJobUsageSnapshot(db, input.jobId);
  if (!snapshot) return { ok: true, inserted: false };

  try {
    return recordUsage(db, {
      eventKey: `video-job:${input.jobId}:succeeded`,
      snapshot,
      usage: {
        quantity: nonNegativeDuration(input.durationSec),
        callCount: 1,
        detail: { source: 'live', taskType: 'video-job' },
      },
      projectId: input.projectId,
      refType: 'video-job',
      refId: input.jobId,
      createdAt: input.finishedAt,
    });
  } catch {
    // Ledger failure is reconciled later and must never undo a succeeded job.
    return { ok: false, reason: 'write_failed' };
  }
}
