import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { AttemptRecord, ExecutionFacade } from '../media-core/execution/context.ts';
import { readAttempt, readOperation } from '../media-core/execution/records.ts';
import { classifySubmissionOutcome, type SubmissionEvidence } from '../media-core/submission-evidence.ts';
import {
  handleUnifiedImageExplicitFailure,
  unifiedImageAttemptCostMinor,
} from '../media-core/unified-media/execution.ts';
import {
  handleUnifiedKlingExplicitFailure,
} from '../media-core/unified-media/video-execution.ts';
import {
  UNIFIED_KLING3_MODEL_KEY,
  unifiedMediaDisplayName,
} from '../media-core/unified-media/catalog.ts';
import { sanitizeGatewayMediaDiagnostic } from '../gateway-media-url.ts';
import type { TeamViewer } from './diagnostics.ts';

export type UnifiedReconcileAction =
  | 'attach_remote_id'
  | 'confirm_not_created'
  | 'confirm_succeeded'
  | 'confirm_failed'
  | 'still_unknown';

export interface UnifiedReconcileActionInput {
  mediaTaskId: string;
  channelKey: string;
  attemptId: string;
  action: UnifiedReconcileAction;
  evidence: string;
  expectedVersion: number;
  idempotencyKey: string;
  remoteId?: string | null;
  actualCostMinor?: number | null;
  resultRef?: string | null;
}

export interface UnifiedReconcileActionResult {
  actionId: string;
  mediaTaskId: string;
  action: UnifiedReconcileAction;
  replayed: boolean;
  parentStatus: string;
  currentChannelKey: string | null;
  reconcileVersion: number;
  businessStatus: string | null;
  nextChannelKey: string | null;
  message: string;
}

export interface UnifiedReconcileTaskView {
  mediaTaskId: string;
  module: string;
  taskId: string;
  actorUserId: string;
  employeeId: string;
  actorDisplayName: string;
  scopeType: string;
  scopeId: string;
  scopeName: string;
  sourceType: string;
  sourceId: string | null;
  unifiedModel: string;
  unifiedModelLabel: string;
  ruleVersion: string;
  status: string;
  currentChannelKey: string | null;
  cancelRequestedAt: string | null;
  reconcileVersion: number;
  createdAt: string;
  updatedAt: string;
  lastCheckedAt: string;
  businessStatus: string | null;
  businessProviderStatus: string | null;
  businessError: string | null;
  attention: boolean;
  attentionReasons: string[];
  lastAction: {
    action: UnifiedReconcileAction;
    actorUserId: string;
    evidenceSummary: string;
    status: string;
    createdAt: string;
  } | null;
  cost: {
    heldMinor: number;
    reservedMinor: number;
    actualMinor: number;
    costStatus: 'estimated' | 'settled' | 'released' | 'unpriced' | 'uncertain';
    unknownCount: number;
  };
  occupancy: {
    heldConcurrency: number;
    heldCostMinor: number;
  };
  channels: Array<{
    channelKey: string;
    providerId: string;
    providerModel: string;
    priority: number;
    state: string;
    executionRevision: number;
    operationId: string | null;
    operationKey: string | null;
    operationStatus: string | null;
    waitReason: string | null;
    waitDetail: unknown;
    remoteId: string | null;
    configVersion: string | null;
    credentialVersionRef: string | null;
    lastCheckedAt: string;
    costStatus: UnifiedReconcileTaskView['cost']['costStatus'];
    reservedMinor: number;
    actualMinor: number | null;
    heldConcurrency: number;
    heldCostMinor: number;
    attempts: Array<{
      attemptId: string;
      permitId: string;
      transportSeq: number;
      submissionState: string;
      terminalState: string | null;
      remoteId: string | null;
      providerId: string | null;
      providerModel: string | null;
      configVersion: string | null;
      credentialVersionRef: string | null;
      pricingSnapshot: unknown;
      reservedMinor: number;
      actualMinor: number | null;
      costState: string;
      costStatus: UnifiedReconcileTaskView['cost']['costStatus'];
      errorCode: string | null;
      receiptRemoteId: string | null;
      intentJournalSeq: number | null;
      receiptJournalSeq: number | null;
      createdAt: string;
      updatedAt: string;
    }>;
  }>;
}

export interface LegacyUnifiedReconcileItem {
  kind: 'orphan' | 'operation';
  attemptId: string | null;
  operationId: string | null;
  actorUserId: string;
  module: string | null;
  taskId: string | null;
  status: string;
  remoteId: string | null;
  errorCode: string | null;
  createdAt: string;
}

export interface UnifiedReconcileList {
  items: UnifiedReconcileTaskView[];
  legacyItems: LegacyUnifiedReconcileItem[];
  summary: {
    total: number;
    attention: number;
    unknown: number;
    canceled: number;
  };
}

export class UnifiedReconcileError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'UnifiedReconcileError';
    this.status = status;
    this.code = code;
  }
}

interface MediaTaskRow {
  id: string;
  taskKey: string;
  actorId: string;
  scopeType: string;
  scopeId: string;
  module: string;
  taskId: string;
  unifiedModel: string;
  ruleVersion: string;
  sourceType: string;
  sourceId: string | null;
  sourceMetaJson: string;
  status: string;
  cancelRequestedAt: string | null;
  currentChannelKey: string | null;
  reconcileVersion: number;
  createdAt: string;
  updatedAt: string;
}

interface MediaChannelRow {
  id: string;
  mediaTaskId: string;
  channelKey: string;
  providerTable: string;
  providerId: string;
  providerModel: string;
  priority: number;
  state: string;
  executionRevision: number;
  operationId: string | null;
  remoteId: string | null;
  evidenceJson: string | null;
  nextEligibleAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface BusinessTaskRow {
  status: string | null;
  providerStatus: string | null;
  remoteId: string | null;
  remoteMediaUrl: string | null;
  errorMessage: string | null;
  cancelRequestedAt: string | null;
}

interface AttemptRow {
  id: string;
  operationId: string;
  permitId: string;
  transportSeq: number;
  submissionState: string;
  terminalState: string | null;
  remoteId: string | null;
  providerSnapshotJson: string;
  pricingSnapshotJson: string | null;
  reservedMinor: number;
  actualMinor: number | null;
  costState: string;
  errorCode: string | null;
  receiptJson: string | null;
  intentJournalSeq: number | null;
  receiptJournalSeq: number | null;
  createdAt: string;
  updatedAt: string;
}

interface OperationRow {
  id: string;
  operationKey: string;
  mediaTaskId: string | null;
  channelKey: string | null;
  status: string;
  waitReason: string | null;
  waitDetail: string | null;
  configVersion: string | null;
  credentialVersionRef: string | null;
  currentAttemptId: string | null;
  updatedAt: string;
}

interface ClaimedAction {
  actionId: string;
  task: MediaTaskRow;
  channel: MediaChannelRow;
  operation: OperationRow;
  attempt: AttemptRecord;
  version: number;
  before: Record<string, unknown>;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
}

function hash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function parseObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string' || !value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function requiredText(value: unknown, code: string, message: string): string {
  const normalized = text(value);
  if (!normalized) throw new UnifiedReconcileError(400, code, message);
  return normalized;
}

function assertAdmin(viewer: TeamViewer): void {
  if (viewer.role !== 'admin') {
    throw new UnifiedReconcileError(403, 'reconcile_forbidden', '只有管理员可以查看或处理待核对任务。');
  }
}

function hasTable(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function scopeName(db: Database.Database, scopeType: string, scopeId: string): string {
  if (scopeType === 'project' && hasTable(db, 'projects')) {
    return (db.prepare('SELECT name FROM projects WHERE id = ?').pluck().get(scopeId) as string | undefined)
      ?? '项目已删除或不可用';
  }
  if (scopeType === 'canvas' && hasTable(db, 'creative_canvases')) {
    return (db.prepare('SELECT name FROM creative_canvases WHERE id = ?').pluck().get(scopeId) as string | undefined)
      ?? '画布已删除或不可用';
  }
  return scopeId;
}

function readBusinessTask(db: Database.Database, task: MediaTaskRow): BusinessTaskRow {
  if (task.module === 'image' && hasTable(db, 'jobs')) {
    const row = db.prepare(`SELECT status, providerStatus, providerTaskId, remoteImageUrl,
      errorMessage, cancelRequestedAt FROM jobs WHERE id = ?`).get(task.taskId) as {
        status: string; providerStatus: string | null; providerTaskId: string | null;
        remoteImageUrl: string | null; errorMessage: string | null; cancelRequestedAt: string | null;
      } | undefined;
    return {
      status: row?.status ?? null,
      providerStatus: row?.providerStatus ?? null,
      remoteId: row?.providerTaskId ?? null,
      remoteMediaUrl: row?.remoteImageUrl ?? null,
      errorMessage: row?.errorMessage ?? null,
      cancelRequestedAt: row?.cancelRequestedAt ?? null,
    };
  }
  if (task.module === 'video' && hasTable(db, 'video_jobs')) {
    const row = db.prepare(`SELECT status, providerStatus, providerTaskId, remoteVideoUrl,
      errorMessage, cancelRequestedAt FROM video_jobs WHERE id = ?`).get(task.taskId) as {
        status: string; providerStatus: string | null; providerTaskId: string | null;
        remoteVideoUrl: string | null; errorMessage: string | null; cancelRequestedAt: string | null;
      } | undefined;
    return {
      status: row?.status ?? null,
      providerStatus: row?.providerStatus ?? null,
      remoteId: row?.providerTaskId ?? null,
      remoteMediaUrl: row?.remoteVideoUrl ?? null,
      errorMessage: row?.errorMessage ?? null,
      cancelRequestedAt: row?.cancelRequestedAt ?? null,
    };
  }
  if (task.module === 'canvas' && hasTable(db, 'creative_canvas_tasks')) {
    const row = db.prepare(`SELECT phase, providerTaskId, errorMessage, cancelRequestedAt,
      submissionState FROM creative_canvas_tasks WHERE id = ?`).get(task.taskId) as {
        phase: string; providerTaskId: string | null; errorMessage: string | null;
        cancelRequestedAt: string | null; submissionState: string;
      } | undefined;
    return {
      status: row?.phase ?? null,
      providerStatus: row?.submissionState ?? null,
      remoteId: row?.providerTaskId ?? null,
      remoteMediaUrl: null,
      errorMessage: row?.errorMessage ?? null,
      cancelRequestedAt: row?.cancelRequestedAt ?? null,
    };
  }
  return {
    status: null,
    providerStatus: null,
    remoteId: null,
    remoteMediaUrl: null,
    errorMessage: null,
    cancelRequestedAt: null,
  };
}

function costStatusOf(attempt: {
  costState: string;
  actualMinor: number | null;
}): UnifiedReconcileTaskView['cost']['costStatus'] {
  if (attempt.costState === 'released') return 'released';
  if (attempt.costState === 'unknown') return 'uncertain';
  if (attempt.costState === 'settled') return attempt.actualMinor === null ? 'uncertain' : 'settled';
  return 'estimated';
}

function aggregateCostStatus(statuses: Array<UnifiedReconcileTaskView['cost']['costStatus']>, hasAttempts: boolean) {
  if (statuses.includes('uncertain')) return 'uncertain' as const;
  if (statuses.includes('estimated')) return 'estimated' as const;
  if (statuses.includes('settled')) return 'settled' as const;
  if (statuses.includes('unpriced')) return 'unpriced' as const;
  return hasAttempts ? 'released' as const : 'unpriced' as const;
}

function attemptProjection(attempt: AttemptRow) {
  const provider = parseObject(attempt.providerSnapshotJson);
  const receipt = parseObject(attempt.receiptJson);
  const pricing = parseObject(attempt.pricingSnapshotJson);
  const safePricing = {
    coreModelKey: text(pricing.coreModelKey),
    pricingVersion: text(pricing.pricingVersion),
    priceComponents: Array.isArray(pricing.priceComponents) ? pricing.priceComponents : [],
  };
  return {
    attemptId: attempt.id,
    permitId: attempt.permitId,
    transportSeq: attempt.transportSeq,
    submissionState: attempt.submissionState,
    terminalState: attempt.terminalState,
    remoteId: attempt.remoteId,
    providerId: text(provider.providerId),
    providerModel: text(provider.model) ?? text(provider.requestModel) ?? text(provider.modelAlias),
    configVersion: text(provider.configVersion),
    credentialVersionRef: text(provider.credentialVersionRef),
    pricingSnapshot: safePricing,
    reservedMinor: attempt.reservedMinor,
    actualMinor: attempt.actualMinor,
    costState: attempt.costState,
    costStatus: costStatusOf(attempt),
    errorCode: attempt.errorCode,
    receiptRemoteId: text(receipt.remoteId),
    intentJournalSeq: attempt.intentJournalSeq,
    receiptJournalSeq: attempt.receiptJournalSeq,
    createdAt: attempt.createdAt,
    updatedAt: attempt.updatedAt,
  };
}

function lastChecked(...values: Array<string | null | undefined>): string {
  return values.filter((value): value is string => Boolean(value)).sort().at(-1) ?? '';
}

export function listUnifiedReconcileTasks(
  db: Database.Database,
  viewer: TeamViewer,
  filters: { status?: 'attention' | 'all' } = {},
): UnifiedReconcileList {
  assertAdmin(viewer);
  if (!hasTable(db, 'execution_media_tasks')) {
    return {
      items: [],
      legacyItems: [],
      summary: { total: 0, attention: 0, unknown: 0, canceled: 0 },
    };
  }
  const rows = db.prepare(`
    SELECT t.*, u.employeeId, u.displayName
    FROM execution_media_tasks t
    LEFT JOIN team_users u ON u.id = t.actorId
    ORDER BY t.updatedAt DESC, t.id DESC
    LIMIT 200
  `).all() as Array<MediaTaskRow & { employeeId: string | null; displayName: string | null }>;
  const items = rows.map((row): UnifiedReconcileTaskView => {
    const business = readBusinessTask(db, row);
    const channels = db.prepare(`SELECT * FROM execution_media_channels
      WHERE mediaTaskId = ? ORDER BY priority, channelKey`).all(row.id) as MediaChannelRow[];
    let heldConcurrency = 0;
    let heldCostMinor = 0;
    let reservedMinor = 0;
    let actualMinor = 0;
    let unknownCount = 0;
    let last = row.updatedAt;
    const channelViews = channels.map((channel) => {
      const operation = db.prepare(`SELECT * FROM execution_operations
        WHERE mediaTaskId = ? AND channelKey = ?
        ORDER BY createdAt DESC LIMIT 1`).get(row.id, channel.channelKey) as OperationRow | undefined;
      const attempts = operation
        ? db.prepare(`SELECT * FROM execution_attempts WHERE operationId = ?
            ORDER BY createdAt, transportSeq, id`).all(operation.id) as AttemptRow[]
        : [];
      const attemptViews = attempts.map(attemptProjection);
      for (const attempt of attempts) {
        const reservations = db.prepare(`SELECT kind, state, reservedMinor, actualMinor, costState
          FROM execution_reservations WHERE permitId = ? OR attemptId = ?`).all(attempt.permitId, attempt.id) as Array<{
            kind: string; state: string; reservedMinor: number | null; actualMinor: number | null; costState: string | null;
          }>;
        heldConcurrency += reservations.filter((reservation) =>
          reservation.kind === 'concurrency' && reservation.state === 'held').length;
        heldCostMinor += reservations
          .filter((reservation) => reservation.kind === 'cost' && reservation.state === 'held')
          .reduce((sum, reservation) => sum + (reservation.reservedMinor ?? 0), 0);
        reservedMinor += attempt.costState === 'released' ? 0 : attempt.reservedMinor;
        actualMinor += attempt.actualMinor ?? 0;
        if (attempt.costState === 'unknown') unknownCount += 1;
        last = lastChecked(last, attempt.updatedAt, operation?.updatedAt, channel.updatedAt);
      }
      const channelHeld = attempts.reduce((sum, attempt) => {
        return sum + (db.prepare(`SELECT COUNT(*) FROM execution_reservations
          WHERE permitId = ? AND kind = 'concurrency' AND state = 'held'`)
          .pluck().get(attempt.permitId) as number);
      }, 0);
      const channelHeldCost = attempts.reduce((sum, attempt) => {
        return sum + (db.prepare(`SELECT COALESCE(SUM(reservedMinor), 0) FROM execution_reservations
          WHERE attemptId = ? AND kind = 'cost' AND state = 'held'`)
          .pluck().get(attempt.id) as number);
      }, 0);
      last = lastChecked(last, operation?.updatedAt, channel.updatedAt);
      return {
        channelKey: channel.channelKey,
        providerId: channel.providerId,
        providerModel: channel.providerModel,
        priority: channel.priority,
        state: channel.state,
        executionRevision: channel.executionRevision,
        operationId: operation?.id ?? channel.operationId,
        operationKey: operation?.operationKey ?? null,
        operationStatus: operation?.status ?? null,
        waitReason: operation?.waitReason ?? null,
        waitDetail: parseObject(operation?.waitDetail),
        remoteId: channel.remoteId ?? attemptViews.at(-1)?.remoteId ?? null,
        configVersion: operation?.configVersion ?? null,
        credentialVersionRef: operation?.credentialVersionRef ?? null,
        lastCheckedAt: lastChecked(operation?.updatedAt, channel.updatedAt, attemptViews.at(-1)?.updatedAt),
        costStatus: aggregateCostStatus(attemptViews.map((attempt) => attempt.costStatus), attemptViews.length > 0),
        reservedMinor: attemptViews.reduce((sum, attempt) =>
          sum + (attempt.costState === 'released' ? 0 : attempt.reservedMinor), 0),
        actualMinor: attemptViews.reduce((sum, attempt) => sum + (attempt.actualMinor ?? 0), 0),
        heldConcurrency: channelHeld,
        heldCostMinor: channelHeldCost,
        attempts: attemptViews,
      };
    });
    const hasUnknownAttempt = channelViews.some((channel) =>
      channel.attempts.some((attempt) =>
        attempt.submissionState === 'maybe_sent' && attempt.terminalState === null));
    const reasons: string[] = [];
    if (row.status === 'unknown') reasons.push('结果确认中');
    if (hasUnknownAttempt) reasons.push('提交结果未知');
    if (channelViews.some((channel) => channel.state === 'unknown')) reasons.push('通道结果未知');
    if (row.cancelRequestedAt) reasons.push('已请求取消');
    if (business.status === 'needs_check') reasons.push('业务任务待核对');
    if (business.providerStatus === 'unknown') reasons.push('供应商结果未知');
    if (business.status === 'download_failed') reasons.push('结果待补下载');
    const costStatus = aggregateCostStatus(
      channelViews.flatMap((channel) => channel.attempts.map((attempt) => attempt.costStatus)),
      channelViews.some((channel) => channel.attempts.length > 0),
    );
    const lastActionRow = db.prepare(`SELECT action, actorUserId, evidenceSummary, status, createdAt
      FROM execution_media_reconcile_actions WHERE mediaTaskId = ?
      ORDER BY createdAt DESC, id DESC LIMIT 1`).get(row.id) as {
        action: UnifiedReconcileAction; actorUserId: string; evidenceSummary: string;
        status: string; createdAt: string;
      } | undefined;
    return {
      mediaTaskId: row.id,
      module: row.module,
      taskId: row.taskId,
      actorUserId: row.actorId,
      employeeId: row.employeeId ?? row.actorId,
      actorDisplayName: row.displayName ?? row.actorId,
      scopeType: row.scopeType,
      scopeId: row.scopeId,
      scopeName: scopeName(db, row.scopeType, row.scopeId),
      sourceType: row.sourceType,
      sourceId: row.sourceId,
      unifiedModel: row.unifiedModel,
      unifiedModelLabel: unifiedMediaDisplayName(row.unifiedModel) ?? row.unifiedModel,
      ruleVersion: row.ruleVersion,
      status: row.status,
      currentChannelKey: row.currentChannelKey,
      cancelRequestedAt: row.cancelRequestedAt,
      reconcileVersion: row.reconcileVersion,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      lastCheckedAt: last,
      businessStatus: business.status,
      businessProviderStatus: business.providerStatus,
      businessError: business.errorMessage,
      attention: reasons.length > 0,
      attentionReasons: [...new Set(reasons)],
      lastAction: lastActionRow ?? null,
      cost: {
        heldMinor: heldCostMinor,
        reservedMinor,
        actualMinor,
        costStatus,
        unknownCount,
      },
      occupancy: {
        heldConcurrency,
        heldCostMinor,
      },
      channels: channelViews,
    };
  }).filter((item) => filters.status !== 'attention' || item.attention);

  const legacyItems: LegacyUnifiedReconcileItem[] = [];
  if (hasTable(db, 'execution_reconciliation_orphans')) {
    const orphans = db.prepare(`SELECT attemptId, operationId, actorId, state, evidenceJson,
      createdAt, updatedAt FROM execution_reconciliation_orphans
      ORDER BY updatedAt DESC LIMIT 100`).all() as Array<{
        attemptId: string; operationId: string; actorId: string; state: string;
        evidenceJson: string; createdAt: string; updatedAt: string;
      }>;
    for (const orphan of orphans) {
      const evidence = parseObject(orphan.evidenceJson);
      legacyItems.push({
        kind: 'orphan',
        attemptId: orphan.attemptId,
        operationId: orphan.operationId,
        actorUserId: orphan.actorId,
        module: text(evidence.module),
        taskId: null,
        status: orphan.state,
        remoteId: text(evidence.remoteId),
        errorCode: text(evidence.errorCode),
        createdAt: orphan.createdAt,
      });
    }
  }
  if (hasTable(db, 'execution_operations')) {
    const legacyUnknown = db.prepare(`
      SELECT o.id, o.actorId, o.module, o.taskId, o.status, o.updatedAt,
        a.id AS attemptId, a.remoteId, a.errorCode
      FROM execution_operations o
      LEFT JOIN execution_attempts a ON a.operationId = o.id
      WHERE o.mediaTaskId IS NULL
        AND (o.status = 'unknown' OR a.submissionState = 'maybe_sent')
      ORDER BY o.updatedAt DESC LIMIT 100
    `).all() as Array<{
      id: string; actorId: string; module: string; taskId: string; status: string;
      updatedAt: string; attemptId: string | null; remoteId: string | null; errorCode: string | null;
    }>;
    for (const legacy of legacyUnknown) {
      legacyItems.push({
        kind: 'operation',
        attemptId: legacy.attemptId,
        operationId: legacy.id,
        actorUserId: legacy.actorId,
        module: legacy.module,
        taskId: legacy.taskId,
        status: legacy.status,
        remoteId: legacy.remoteId,
        errorCode: legacy.errorCode,
        createdAt: legacy.updatedAt,
      });
    }
  }
  const summary = {
    total: items.length,
    attention: items.filter((item) => item.attention).length,
    unknown: items.filter((item) => item.attentionReasons.some((reason) => reason.includes('未知') || reason.includes('确认'))).length,
    canceled: items.filter((item) => Boolean(item.cancelRequestedAt)).length,
  };
  return { items, legacyItems, summary };
}

function safeEvidence(value: string): string {
  const withoutQueries = value.replace(/https?:\/\/[^\s<>"']+/gi, (raw) => {
    try {
      const url = new URL(raw);
      return `${url.origin}${url.pathname}${url.search ? '?[REDACTED]' : ''}`;
    } catch {
      return '[URL]';
    }
  });
  const sanitized = sanitizeGatewayMediaDiagnostic(withoutQueries, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1000);
  if (sanitized.length < 4) {
    throw new UnifiedReconcileError(400, 'reconcile_evidence_required', '请填写可复核的核对依据。');
  }
  return sanitized;
}

function safeRemoteId(value: unknown): string {
  const remoteId = requiredText(value, 'remote_id_required', '请填写远端任务 ID。');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,299}$/.test(remoteId)) {
    throw new UnifiedReconcileError(400, 'invalid_remote_id', '远端任务 ID 格式无效。');
  }
  return remoteId;
}

function safeResultRef(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  const resultRef = requiredText(value, 'invalid_result_ref', '原结果地址格式无效。').trim();
  if (resultRef.length > 4_000 || /\s/.test(resultRef)) {
    throw new UnifiedReconcileError(400, 'invalid_result_ref', '原结果地址格式无效。');
  }
  try {
    const url = new URL(resultRef);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('scheme');
  } catch {
    throw new UnifiedReconcileError(400, 'invalid_result_ref', '原结果地址必须是 http 或 https 地址。');
  }
  return resultRef;
}

function actionInputHash(input: UnifiedReconcileActionInput): string {
  return hash({
    mediaTaskId: input.mediaTaskId,
    channelKey: input.channelKey,
    attemptId: input.attemptId,
    action: input.action,
    evidence: safeEvidence(input.evidence),
    expectedVersion: input.expectedVersion,
    remoteId: input.remoteId ?? null,
    actualCostMinor: input.actualCostMinor ?? null,
    resultRef: input.resultRef ?? null,
  });
}

function attemptReceiptResultRef(attempt: AttemptRecord): string | null {
  const receipt = parseObject(attempt.receipt);
  const value = text(receipt.resultRef);
  return value && (value.startsWith('https://') || value.startsWith('http://')) ? value : null;
}

function statusBefore(task: MediaTaskRow, channel: MediaChannelRow, operation: OperationRow, attempt: AttemptRecord) {
  return {
    parentStatus: task.status,
    currentChannelKey: task.currentChannelKey,
    channelState: channel.state,
    operationStatus: operation.status,
    submissionState: attempt.submissionState,
    terminalState: attempt.terminalState,
    remoteId: attempt.remoteId,
    costState: attempt.costState,
  };
}

function statusAfter(db: Database.Database, taskId: string) {
  const task = db.prepare('SELECT status, currentChannelKey, reconcileVersion, cancelRequestedAt FROM execution_media_tasks WHERE id = ?')
    .get(taskId) as { status: string; currentChannelKey: string | null; reconcileVersion: number; cancelRequestedAt: string | null } | undefined;
  return task ?? null;
}

function businessCanceled(db: Database.Database, task: MediaTaskRow): boolean {
  const business = readBusinessTask(db, task);
  return Boolean(task.cancelRequestedAt || business.cancelRequestedAt || business.status === 'canceled');
}

function updateBusinessAfterAccepted(
  db: Database.Database,
  task: MediaTaskRow,
  remoteId: string | null,
  resultRef: string | null,
  canceled: boolean,
): void {
  const at = new Date().toISOString();
  if (task.module === 'image') {
    const estimatedCost = unifiedImageAttemptCostMinor(db, task.taskId) / 100;
    if (canceled) {
      db.prepare(`UPDATE jobs SET status = ?, providerTaskId = COALESCE(?, providerTaskId),
        providerStatus = ?, remoteImageUrl = COALESCE(?, remoteImageUrl), estimatedCost = ?,
        errorMessage = '管理员已核对远端结果；任务已取消，仅保留收尾记录。',
        finishedAt = CASE WHEN ? IS NULL THEN NULL ELSE COALESCE(finishedAt, ?) END
        WHERE id = ?`).run(
        resultRef ? 'needs_check' : 'canceled',
        remoteId, resultRef ? 'download_failed' : 'accepted', resultRef, estimatedCost,
        resultRef, at, task.taskId,
      );
    } else {
      db.prepare(`UPDATE jobs SET status = 'needs_check', providerTaskId = COALESCE(?, providerTaskId),
        providerStatus = ?, remoteImageUrl = COALESCE(?, remoteImageUrl), estimatedCost = ?,
        errorMessage = ?, finishedAt = NULL WHERE id = ?`).run(
        remoteId, resultRef ? 'download_failed' : 'accepted', resultRef, estimatedCost,
        resultRef ? '管理员已补齐远端结果，等待补下载；不会重新生成。' : '管理员已补齐远端任务 ID，等待原通道续查。',
        task.taskId,
      );
    }
    return;
  }
  if (task.module === 'video') {
    if (canceled) {
      db.prepare(`UPDATE video_jobs SET status = ?, providerTaskId = COALESCE(?, providerTaskId),
        providerStatus = ?, remoteVideoUrl = COALESCE(?, remoteVideoUrl),
        errorMessage = '管理员已核对远端结果；任务已取消，仅保留收尾记录。',
        finishedAt = CASE WHEN ? IS NULL THEN COALESCE(finishedAt, datetime('now')) ELSE NULL END
        WHERE id = ?`)
        .run(
          resultRef ? 'needs_check' : 'canceled',
          remoteId, resultRef ? 'download_failed' : 'accepted', resultRef,
          resultRef, task.taskId,
        );
    } else {
      db.prepare(`UPDATE video_jobs SET status = 'needs_check', providerTaskId = COALESCE(?, providerTaskId),
        providerStatus = ?, remoteVideoUrl = COALESCE(?, remoteVideoUrl),
        errorMessage = '管理员已补齐远端任务 ID，等待原通道续查。', finishedAt = NULL WHERE id = ?`).run(
        remoteId, resultRef ? 'download_failed' : 'accepted', resultRef, task.taskId,
      );
    }
    return;
  }
  if (task.module === 'canvas') {
    if (canceled) {
      db.prepare(`UPDATE creative_canvas_tasks SET phase = 'cancelled', providerTaskId = COALESCE(?, providerTaskId),
        submissionState = 'accepted', errorMessage = '管理员已核对远端结果；任务已取消，仅保留收尾记录。'
        WHERE id = ?`).run(remoteId, task.taskId);
    } else {
      db.prepare(`UPDATE creative_canvas_tasks SET phase = 'polling', submissionState = 'accepted',
        providerTaskId = COALESCE(?, providerTaskId), errorCode = NULL,
        errorMessage = '管理员已补齐远端任务 ID，等待原通道续查。', leaseOwner = NULL, leaseUntil = NULL
        WHERE id = ?`).run(remoteId, task.taskId);
    }
  }
}

function updateBusinessAfterCanceledClose(
  db: Database.Database,
  task: MediaTaskRow,
  outcome: 'failed' | 'not_created',
  message: string,
): void {
  if (task.module === 'image') {
    db.prepare(`UPDATE jobs SET status = 'canceled', providerStatus = ?, errorMessage = ?,
      finishedAt = COALESCE(finishedAt, datetime('now')) WHERE id = ?`).run(
      outcome === 'not_created' ? 'not_created' : 'failed', message, task.taskId,
    );
  } else if (task.module === 'video') {
    db.prepare(`UPDATE video_jobs SET status = 'canceled', providerStatus = ?, errorMessage = ?,
      finishedAt = COALESCE(finishedAt, datetime('now')) WHERE id = ?`).run(
      outcome === 'not_created' ? 'not_created' : 'failed', message, task.taskId,
    );
  } else if (task.module === 'canvas') {
    db.prepare(`UPDATE creative_canvas_tasks SET phase = 'cancelled', submissionState = 'terminal',
      errorCode = ?, errorMessage = ? WHERE id = ?`).run(outcome, message, task.taskId);
  }
}

function updateBusinessAfterClose(
  db: Database.Database,
  task: MediaTaskRow,
  outcome: 'failed' | 'not_created',
  message: string,
): void {
  if (task.module === 'image') {
    db.prepare(`UPDATE jobs SET status = 'failed', providerStatus = ?, errorMessage = ?,
      finishedAt = COALESCE(finishedAt, datetime('now')) WHERE id = ?`).run(
      outcome === 'not_created' ? 'not_created' : 'failed', message, task.taskId,
    );
  } else if (task.module === 'video') {
    db.prepare(`UPDATE video_jobs SET status = 'failed', providerStatus = ?, errorMessage = ?,
      finishedAt = COALESCE(finishedAt, datetime('now')) WHERE id = ?`).run(
      outcome === 'not_created' ? 'not_created' : 'failed', message, task.taskId,
    );
  } else if (task.module === 'canvas') {
    db.prepare(`UPDATE creative_canvas_tasks SET phase = 'failed', submissionState = 'terminal',
      errorCode = ?, errorMessage = ?, leaseOwner = NULL, leaseUntil = NULL WHERE id = ?`).run(
      outcome, message, task.taskId,
    );
  }
}

function evidenceForFailure(
  task: MediaTaskRow,
  attempt: AttemptRecord,
  outcome: 'confirmed_not_created' | 'terminal_failed',
  remoteId: string | null,
): SubmissionEvidence {
  const entry = task.module === 'image' || task.module === 'video' || task.module === 'canvas'
    ? task.module : 'image';
  return classifySubmissionOutcome({
    entry,
    taskId: task.taskId,
    businessAttemptNo: attempt.businessAttemptNo,
    adapterId: text(parseObject(attempt.providerSnapshot).type) ?? 'operator',
    stage: 'poll',
    source: 'operator',
    outcome,
    remoteId,
    errorCode: outcome === 'confirmed_not_created' ? 'operator_confirmed_not_created' : 'operator_confirmed_failed',
  });
}

function updateChannelAndParent(
  db: Database.Database,
  task: MediaTaskRow,
  channel: MediaChannelRow,
  state: string,
  remoteId: string | null,
  evidence: Record<string, unknown>,
  parentStatus: string,
): void {
  const at = new Date().toISOString();
  db.prepare(`UPDATE execution_media_channels SET state = ?, remoteId = COALESCE(?, remoteId),
    evidenceJson = ?, updatedAt = ? WHERE id = ?`).run(
    state, remoteId, JSON.stringify(evidence), at, channel.id,
  );
  db.prepare(`UPDATE execution_media_tasks SET status = ?, updatedAt = ? WHERE id = ?`)
    .run(parentStatus, at, task.id);
}

function completeAction(
  db: Database.Database,
  claimed: ClaimedAction,
  result: Omit<UnifiedReconcileActionResult, 'replayed'>,
): void {
  const after = statusAfter(db, claimed.task.id);
  db.prepare(`UPDATE execution_media_reconcile_actions
    SET status = 'completed', afterJson = ?, resultJson = ?, completedAt = ?
    WHERE id = ? AND status = 'in_progress'`).run(
    JSON.stringify(after ? { parentStatus: after.status, ...after } : null),
    JSON.stringify(result), new Date().toISOString(), claimed.actionId,
  );
}

function failAction(db: Database.Database, actionId: string, errorCode: string): void {
  db.prepare(`UPDATE execution_media_reconcile_actions
    SET status = 'failed', errorCode = ?, completedAt = ?
    WHERE id = ? AND status = 'in_progress'`).run(
    errorCode.slice(0, 200), new Date().toISOString(), actionId,
  );
}

function actionErrorCode(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  return /^[A-Za-z0-9_.:-]{1,200}$/.test(code)
    ? code
    : error instanceof UnifiedReconcileError ? error.code : 'reconcile_action_failed';
}

export async function applyUnifiedReconcileAction(
  db: Database.Database,
  facade: ExecutionFacade,
  viewer: TeamViewer,
  input: UnifiedReconcileActionInput,
): Promise<UnifiedReconcileActionResult> {
  assertAdmin(viewer);
  const supportedActions: readonly UnifiedReconcileAction[] = [
    'attach_remote_id', 'confirm_not_created', 'confirm_succeeded', 'confirm_failed', 'still_unknown',
  ];
  if (!supportedActions.includes(input.action)) {
    throw new UnifiedReconcileError(400, 'invalid_reconcile_action', '未知的核对动作。');
  }
  if (!input.mediaTaskId.trim() || !input.channelKey.trim() || !input.attemptId.trim()) {
    throw new UnifiedReconcileError(400, 'reconcile_target_required', '必须指定统一任务、通道和原尝试。');
  }
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw new UnifiedReconcileError(400, 'invalid_reconcile_version', '核对版本必须是非负整数。');
  }
  if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(input.idempotencyKey)) {
    throw new UnifiedReconcileError(400, 'invalid_idempotency_key', '缺少有效的幂等键。');
  }
  const requestHash = actionInputHash(input);
  const evidenceSummary = safeEvidence(input.evidence);
  const remoteId = input.remoteId ? safeRemoteId(input.remoteId) : null;
  const resultRef = safeResultRef(input.resultRef);
  if (input.actualCostMinor !== undefined && input.actualCostMinor !== null
    && (!Number.isSafeInteger(input.actualCostMinor) || input.actualCostMinor < 0)) {
    throw new UnifiedReconcileError(400, 'invalid_cost', '费用必须是 NULL 或非负整数 minor。');
  }
  if ((input.action === 'attach_remote_id') && !remoteId) {
    throw new UnifiedReconcileError(400, 'remote_id_required', '补远端 ID 时必须填写任务 ID。');
  }

  const claimed = db.transaction((): ClaimedAction | UnifiedReconcileActionResult => {
    const existing = db.prepare(`SELECT * FROM execution_media_reconcile_actions
      WHERE mediaTaskId = ? AND idempotencyKey = ?`).get(input.mediaTaskId, input.idempotencyKey) as {
        id: string; requestHash: string; status: string; resultJson: string | null; errorCode: string | null;
      } | undefined;
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new UnifiedReconcileError(409, 'idempotency_conflict', '相同幂等键已被不同的核对请求使用。');
      }
      if (existing.status === 'completed' && existing.resultJson) {
        const result = JSON.parse(existing.resultJson) as Omit<UnifiedReconcileActionResult, 'replayed'>;
        return { ...result, replayed: true };
      }
      if (existing.status === 'in_progress') {
        throw new UnifiedReconcileError(409, 'reconcile_in_progress', '同一核对操作正在处理中，请稍后刷新。');
      }
      throw new UnifiedReconcileError(409, 'reconcile_action_failed', `上次核对失败：${existing.errorCode ?? '未知原因'}。`);
    }
    const task = db.prepare('SELECT * FROM execution_media_tasks WHERE id = ?').get(input.mediaTaskId) as
      MediaTaskRow | undefined;
    if (!task) throw new UnifiedReconcileError(404, 'reconcile_task_not_found', '待核对任务不存在。');
    if (task.reconcileVersion !== input.expectedVersion) {
      throw new UnifiedReconcileError(
        409,
        'reconcile_version_conflict',
        `任务已被其他人处理或更新（当前版本 ${task.reconcileVersion}），请刷新后再操作。`,
      );
    }
    const channel = db.prepare(`SELECT * FROM execution_media_channels
      WHERE mediaTaskId = ? AND channelKey = ?`).get(task.id, input.channelKey) as MediaChannelRow | undefined;
    if (!channel) {
      throw new UnifiedReconcileError(400, 'reconcile_channel_mismatch', '指定通道不属于这条任务。');
    }
    const operation = db.prepare(`SELECT * FROM execution_operations
      WHERE mediaTaskId = ? AND channelKey = ?
      ORDER BY createdAt DESC LIMIT 1`).get(task.id, channel.channelKey) as OperationRow | undefined;
    if (!operation) {
      throw new UnifiedReconcileError(409, 'reconcile_operation_missing', '当前通道没有可核对的执行操作。');
    }
    const attempt = db.prepare(`SELECT * FROM execution_attempts
      WHERE id = ? AND operationId = ?`).get(input.attemptId, operation.id);
    if (!attempt) {
      throw new UnifiedReconcileError(400, 'reconcile_attempt_mismatch', '指定尝试不属于当前通道。');
    }
    const attemptRecord = readAttempt(db, input.attemptId);
    if (remoteId) {
      const duplicate = db.prepare(`SELECT a.id, o.mediaTaskId FROM execution_attempts a
        JOIN execution_operations o ON o.id = a.operationId
        WHERE a.remoteId = ? AND a.id <> ?`).get(remoteId, attemptRecord.id) as {
          id: string; mediaTaskId: string | null;
        } | undefined;
      if (duplicate) {
        throw new UnifiedReconcileError(409, 'remote_id_conflict', '该远端任务 ID 已关联到另一条尝试。');
      }
    }
    const version = task.reconcileVersion + 1;
    const actionId = randomUUID();
    const before = statusBefore(task, channel, operation, attemptRecord);
    const at = new Date().toISOString();
    const updated = db.prepare(`UPDATE execution_media_tasks
      SET reconcileVersion = ?, updatedAt = ? WHERE id = ? AND reconcileVersion = ?`).run(
      version, at, task.id, input.expectedVersion,
    );
    if (updated.changes !== 1) {
      throw new UnifiedReconcileError(409, 'reconcile_version_conflict', '任务版本已变化，请刷新后再操作。');
    }
    db.prepare(`INSERT INTO execution_media_reconcile_actions (
      id, mediaTaskId, channelKey, attemptId, actorUserId, action, idempotencyKey,
      requestHash, evidenceSummary, beforeJson, status, createdAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_progress', ?)`).run(
      actionId, task.id, channel.channelKey, attemptRecord.id, viewer.userId, input.action,
      input.idempotencyKey, requestHash, evidenceSummary, JSON.stringify(before), at,
    );
    return {
      actionId,
      task: { ...task, reconcileVersion: version, updatedAt: at },
      channel,
      operation,
      attempt: attemptRecord,
      version,
      before,
    };
  }).immediate();
  if ('replayed' in claimed) return claimed;

  try {
    let attempt = readAttempt(db, claimed.attempt.id);
    const operation = readOperation(db, claimed.operation.id);
    const canceled = businessCanceled(db, claimed.task);
    const cost = input.actualCostMinor === undefined || input.actualCostMinor === null
      ? null
      : { currency: 'CNY' as const, minor: input.actualCostMinor };

    if (input.action === 'still_unknown') {
      if (attempt.terminalState !== null) {
        throw new UnifiedReconcileError(409, 'reconcile_terminal_conflict', '已有明确终态的尝试不能再保持未知。');
      }
      await facade.reconcile({
        attemptId: attempt.id,
        evidence: { kind: 'still_unknown', errorCode: 'operator_still_unknown' },
        source: 'operator',
      });
      attempt = readAttempt(db, attempt.id);
      db.transaction(() => {
        updateChannelAndParent(
          db, claimed.task, claimed.channel, 'unknown', attempt.remoteId,
          { action: input.action, evidence: evidenceSummary, attemptId: attempt.id, at: new Date().toISOString() },
          canceled ? 'canceled' : 'unknown',
        );
      }).immediate();
    } else if (input.action === 'attach_remote_id') {
      if (attempt.terminalState !== null
        && !(attempt.terminalState === 'succeeded' && attempt.remoteId === remoteId)) {
        throw new UnifiedReconcileError(409, 'reconcile_terminal_conflict', '已有明确终态的尝试不能补挂远端 ID。');
      }
      if (attempt.submissionState === 'maybe_sent' || attempt.remoteId !== remoteId) {
        await facade.reconcile({
          attemptId: attempt.id,
          evidence: { kind: 'remote_id', remoteId: remoteId! },
          source: 'operator',
        });
        attempt = readAttempt(db, attempt.id);
      }
      db.transaction(() => {
        updateChannelAndParent(
          db, claimed.task, claimed.channel, 'accepted', remoteId,
          { action: input.action, evidence: evidenceSummary, attemptId: attempt.id, at: new Date().toISOString() },
          canceled ? 'canceled' : 'accepted',
        );
        updateBusinessAfterAccepted(
          db, claimed.task, remoteId, resultRef ?? attemptReceiptResultRef(attempt), canceled,
        );
      }).immediate();
    } else if (input.action === 'confirm_succeeded') {
      if (attempt.terminalState === 'failed' || attempt.terminalState === 'not_created') {
        throw new UnifiedReconcileError(409, 'reconcile_terminal_conflict', '尝试已有相反的远端终态。');
      }
      if (remoteId && !attempt.remoteId) {
        await facade.reconcile({
          attemptId: attempt.id,
          evidence: { kind: 'remote_id', remoteId },
          source: 'operator',
        });
        attempt = readAttempt(db, attempt.id);
      }
      if (attempt.terminalState !== 'succeeded' || (cost && attempt.actualMinor !== cost.minor)) {
        await facade.reconcile({
          attemptId: attempt.id,
          evidence: {
            kind: 'terminal', outcome: 'succeeded', actualCost: cost,
            errorCode: 'operator_confirmed_succeeded',
          },
          source: 'operator',
        });
        attempt = readAttempt(db, attempt.id);
      }
      db.transaction(() => {
        updateChannelAndParent(
          db, claimed.task, claimed.channel, canceled ? 'accepted' : 'accepted', attempt.remoteId,
          { action: input.action, evidence: evidenceSummary, attemptId: attempt.id, at: new Date().toISOString() },
          canceled ? 'canceled' : 'accepted',
        );
        updateBusinessAfterAccepted(
          db, claimed.task, attempt.remoteId, resultRef ?? attemptReceiptResultRef(attempt), canceled,
        );
      }).immediate();
    } else if (input.action === 'confirm_not_created' || input.action === 'confirm_failed') {
      const terminal = input.action === 'confirm_not_created' ? 'not_created' : 'failed';
      if (attempt.terminalState === 'succeeded') {
        throw new UnifiedReconcileError(409, 'reconcile_terminal_conflict', '尝试已明确成功，不能改为失败。');
      }
      if (attempt.terminalState === 'failed' && terminal === 'not_created') {
        throw new UnifiedReconcileError(409, 'reconcile_terminal_conflict', '尝试已明确失败，不能改为未创建。');
      }
      if (attempt.terminalState === 'not_created' && terminal === 'failed') {
        throw new UnifiedReconcileError(409, 'reconcile_terminal_conflict', '尝试已确认未创建，不能改为远端失败。');
      }
      if (remoteId && !attempt.remoteId) {
        await facade.reconcile({
          attemptId: attempt.id,
          evidence: { kind: 'remote_id', remoteId },
          source: 'operator',
        });
        attempt = readAttempt(db, attempt.id);
      }
      if (attempt.terminalState !== terminal || (terminal === 'failed' && cost && attempt.actualMinor !== cost.minor)) {
        await facade.reconcile({
          attemptId: attempt.id,
          evidence: terminal === 'not_created'
            ? { kind: 'confirmed_not_created', errorCode: 'operator_confirmed_not_created' }
            : {
              kind: 'terminal', outcome: 'failed', actualCost: cost,
              errorCode: 'operator_confirmed_failed',
            },
          source: 'operator',
        });
        attempt = readAttempt(db, attempt.id);
      }
      const finalAttempt = attempt;
      if (canceled) {
        db.transaction(() => {
          updateChannelAndParent(
            db, claimed.task, claimed.channel, terminal,
            finalAttempt.remoteId,
            { action: input.action, evidence: evidenceSummary, attemptId: finalAttempt.id, at: new Date().toISOString() },
            'canceled',
          );
          updateBusinessAfterCanceledClose(db, claimed.task, terminal, '任务已取消，核对结果仅用于收尾。');
        }).immediate();
      } else if (claimed.task.module === 'image' && claimed.task.unifiedModel === 'image2') {
        const decision = handleUnifiedImageExplicitFailure(db, claimed.task.taskId, {
          evidence: evidenceForFailure(
            claimed.task,
            finalAttempt,
            input.action === 'confirm_not_created' ? 'confirmed_not_created' : 'terminal_failed',
            finalAttempt.remoteId,
          ),
          attemptId: finalAttempt.id,
          operationId: operation.id,
          channelKey: claimed.channel.channelKey,
        });
        if (decision.outcome === 'ignored') {
          throw new UnifiedReconcileError(409, 'reconcile_state_conflict', '任务状态已变化，未能继续备用通道。');
        }
      } else if (claimed.task.module === 'video'
        && claimed.task.unifiedModel === UNIFIED_KLING3_MODEL_KEY) {
        const decision = handleUnifiedKlingExplicitFailure(db, claimed.task.taskId, {
          evidence: evidenceForFailure(
            claimed.task,
            finalAttempt,
            input.action === 'confirm_not_created' ? 'confirmed_not_created' : 'terminal_failed',
            finalAttempt.remoteId,
          ),
          attemptId: finalAttempt.id,
          operationId: operation.id,
          channelKey: claimed.channel.channelKey,
        });
        if (decision.outcome === 'ignored') {
          throw new UnifiedReconcileError(409, 'reconcile_state_conflict', '任务状态已变化，未能继续备用通道。');
        }
      } else {
        db.transaction(() => {
          updateChannelAndParent(
            db, claimed.task, claimed.channel, terminal,
            finalAttempt.remoteId,
            { action: input.action, evidence: evidenceSummary, attemptId: finalAttempt.id, at: new Date().toISOString() },
            'failed',
          );
          updateBusinessAfterClose(db, claimed.task, terminal, '管理员已确认远端终态。');
        }).immediate();
      }
    } else {
      throw new UnifiedReconcileError(400, 'invalid_reconcile_action', '未知的核对动作。');
    }

    const after = statusAfter(db, claimed.task.id);
    if (!after) throw new UnifiedReconcileError(409, 'reconcile_state_missing', '核对后任务状态不存在。');
    const channelAfter = db.prepare(`SELECT state FROM execution_media_channels
      WHERE mediaTaskId = ? AND channelKey = ?`).pluck().get(claimed.task.id, claimed.channel.channelKey) as string | undefined;
    const business = readBusinessTask(db, claimed.task);
    const result: Omit<UnifiedReconcileActionResult, 'replayed'> = {
      actionId: claimed.actionId,
      mediaTaskId: claimed.task.id,
      action: input.action,
      parentStatus: after.status,
      currentChannelKey: after.currentChannelKey,
      reconcileVersion: after.reconcileVersion,
      businessStatus: business.status,
      nextChannelKey: after.currentChannelKey !== claimed.channel.channelKey ? after.currentChannelKey : null,
      message: channelAfter === 'failed' || channelAfter === 'not_created'
        ? '核对结果已保存，原尝试与费用证据保留。'
        : '核对结果已保存。',
    };
    db.transaction(() => completeAction(db, claimed, result)).immediate();
    return { ...result, replayed: false };
  } catch (error) {
    failAction(db, claimed.actionId, actionErrorCode(error));
    if (error instanceof UnifiedReconcileError) throw error;
    if (error && typeof error === 'object' && 'code' in error) {
      const code = String((error as { code?: unknown }).code);
      if (/conflict|missing|invalid|forbidden|mismatch|exhausted/.test(code)) {
        throw new UnifiedReconcileError(409, code, error instanceof Error ? error.message : '核对冲突。');
      }
    }
    throw new UnifiedReconcileError(
      500,
      'reconcile_action_failed',
      '核对动作执行失败，请刷新任务状态后再处理。',
    );
  }
}
