/**
 * 画布用量记账（技术约定 C8）。
 *
 * 画布自己的包装调用通用账本：refType 用画布任务语义、refId 指向 taskId、
 * eventKey 按任务稳定生成——所以查询、补下载、重试、复制、切换画布与导出都不会
 * 增加生成调用数；账本写入失败只是漏记，由 reconcile 补记，绝不触发重新生成。
 *
 * 没有价格依据的模型（例如公司七牛可灵尚未进入计价表）明确按「未计价」返回，
 * 不编造金额，也不伪造一条 0 元记录。
 */

import type Database from 'better-sqlite3';
import {
  createCoreUsageSnapshot,
  resolveCoreUsagePlan,
  type CoreUsageProviderSnapshot,
} from '../usage-pricing.ts';
import { recordUsage, type UsageOperationResult } from '../usage-ledger.ts';
import { requireCanvasTask, type CanvasTaskRecord } from './tasks.ts';

export interface CanvasUsageResult {
  ok: boolean;
  /** 是否真的写入了一条账本记录（重复记账时为 false）。 */
  inserted: boolean;
  /** 是否找到了计价依据；false 表示该模型未计价，不写记录。 */
  priced: boolean;
  reason?: string;
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** 任务身份 → 稳定 eventKey：同一任务无论重试多少次都只记一次生成调用。 */
export function canvasTaskUsageEventKey(taskId: string): string {
  return `canvas-task:${taskId}:submitted`;
}

export interface RecordCanvasTaskUsageOptions {
  taskId: string;
  now?: () => Date;
}

/**
 * 记账是尽力而为的旁路：任何失败（缺表、缺价格、写不进去）都只能导致漏记，
 * 绝不允许影响任务状态，更不允许触发重新生成。
 */
export function recordCanvasTaskUsage(
  db: Database.Database,
  options: RecordCanvasTaskUsageOptions,
): CanvasUsageResult {
  try {
    return recordCanvasTaskUsageUnsafe(db, options);
  } catch {
    return { ok: false, inserted: false, priced: false, reason: 'exception' };
  }
}

function recordCanvasTaskUsageUnsafe(
  db: Database.Database,
  options: RecordCanvasTaskUsageOptions,
): CanvasUsageResult {
  const task: CanvasTaskRecord = requireCanvasTask(db, options.taskId);
  if (task.submissionState !== 'accepted' && task.submissionState !== 'terminal') {
    return { ok: true, inserted: false, priced: false, reason: 'not_submitted' };
  }

  const providerSnapshot = parseJsonObject(task.providerSnapshot);
  const modelAlias = String(providerSnapshot.modelAlias ?? '');
  const providerIdentity = String(providerSnapshot.providerIdentity ?? '');
  if (!modelAlias || !providerIdentity) {
    return { ok: true, inserted: false, priced: false, reason: 'provider_snapshot_missing' };
  }

  const table: CoreUsageProviderSnapshot['providerTable'] = task.mediaKind === 'video' ? 'video_providers' : 'providers';
  const row = db.prepare(
    table === 'video_providers'
      ? `SELECT id, name, type, baseUrl FROM video_providers WHERE id = ? OR defaultModel = ? LIMIT 1`
      : `SELECT id, name, type, baseUrl FROM providers WHERE id = ? OR model = ? LIMIT 1`,
  ).get(providerIdentity, modelAlias) as
    | { id: string; name: string; type: string; baseUrl: string }
    | undefined;

  const identity = {
    providerTable: table,
    providerId: row?.id ?? providerIdentity,
    providerName: row?.name ?? providerIdentity,
    providerType: row?.type ?? (task.mediaKind === 'video' ? 'openai-video' : 'gateway-task-image'),
    executionScope: 'company' as const,
    configuredModel: modelAlias,
    requestModel: modelAlias,
    baseUrl: row?.baseUrl ?? '',
  };
  const plan = resolveCoreUsagePlan(identity);
  if (!plan) {
    return { ok: true, inserted: false, priced: false, reason: 'pricing_unavailable' };
  }

  // parameterSnapshot 的形状是 { generationMode, prompt, parameters: {…节点参数} }
  const snapshotFields = parseJsonObject(task.parameterSnapshot);
  const nodeParameters = parseJsonObject(
    typeof snapshotFields.parameters === 'string'
      ? snapshotFields.parameters
      : JSON.stringify(snapshotFields.parameters ?? {}),
  );
  const durationSec = Number(nodeParameters.durationSec ?? 0);
  const quantity = task.mediaKind === 'video' && Number.isFinite(durationSec) && durationSec > 0
    ? durationSec
    : 1;

  const snapshot = createCoreUsageSnapshot(identity, plan, {
    startedAt: task.createdAt,
    refType: 'canvas-task',
    refId: task.id,
  });

  let result: UsageOperationResult;
  try {
    result = recordUsage(db, {
      eventKey: canvasTaskUsageEventKey(task.id),
      snapshot,
      usage: {
        quantity,
        callCount: 1,
        detail: { source: 'live', taskType: 'canvas-task', canvasId: task.canvasId, nodeId: task.nodeId },
      },
      projectId: null,
      refType: 'canvas-task',
      refId: task.id,
      createdAt: (options.now ?? (() => new Date()))().toISOString(),
    });
  } catch {
    // 账本失败只漏记，由 reconcileUsageLedger 补记；绝不因此重发模型请求
    return { ok: false, inserted: false, priced: true, reason: 'write_failed' };
  }

  return {
    ok: result.ok,
    inserted: result.inserted === true,
    priced: true,
    ...(result.ok ? {} : { reason: result.reason }),
  };
}

/** 画布任务的账本事件键（供测试与对账查询）。 */
export function canvasTaskUsageRows(db: Database.Database, taskId: string): number {
  try {
    const row = db.prepare(
      `SELECT COUNT(*) AS count FROM usage_ledger WHERE eventKey = ?`,
    ).get(canvasTaskUsageEventKey(taskId)) as { count: number } | undefined;
    return Number(row?.count ?? 0);
  } catch {
    return 0;
  }
}
