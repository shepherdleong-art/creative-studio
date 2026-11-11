/**
 * 团队用量尝试查询的共享 SQL 表达式（04 号票）。
 *
 * 金额、费用状态、模型归一化的语义只在 `unified-usage-contract.ts`（纯函数）里定义；
 * 这里是把同一份口径翻译成 SQL 的**唯一**位置，供列表、计数与聚合共用，避免每个
 * section 各写一套含义。所有表达式都不拼接用户输入，筛选值一律由调用方绑定。
 *
 * 分类口径（功能方案第 7 节，三者互斥）：
 * - `channels`：有真实统一制作任务父行（`execution_media_tasks`）的已关联尝试；
 * - `legacy`：既没有统一模型身份也没有 `mediaTaskId` 的旧非统一模型调用；
 * - `unmapped`：声称统一任务身份（`mediaTaskId` 或统一模型）但父行不可用的记录。
 *
 * 父任务存在性只按数据库身份判断，与本页 ID 集合、父任务创建账期无关：父任务在
 * 另一页或创建于筛选日期之前都不是「未映射」。员工范围下额外要求父行属于同一
 * 执行人（与「员工只统计本人任务」的既有口径一致）。
 */
import type Database from 'better-sqlite3';
import { unifiedMediaDisplayName } from '../media-core/unified-media/catalog.ts';

export interface UsageAttemptSqlSources {
  /** FROM 子句：attempts + operations + users（+ 统一列 LEFT JOIN + 分类用父任务 LEFT JOIN）。 */
  from: string;
  /** 展示模型：真实通道/模型标识。 */
  model: string;
  /** 统一模型 key：jobs / video_jobs / providerSnapshot 三者按列存在情况回退。 */
  unifiedModel: string;
  quoteKind: string;
  /** 与 `TeamUsageAttempt['costStatus']` 同口径。 */
  costStatus: string;
  /** 与 `attemptChargedMinor` 同口径的人民币分。 */
  chargedMinor: string;
  /** 金额分类合计的逐行贡献（SUM 后即 `TeamUsageTotals`）。 */
  settledMinor: string;
  estimatedMinor: string;
  unpricedCount: string;
  uncertainCount: string;
  /** 互斥分类条件（可直接放进 WHERE 或 CASE）。 */
  channels: string;
  legacy: string;
  unmapped: string;
}

function tableHasColumn(db: Database.Database, table: string, column: string): boolean {
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) return false;
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .some((item) => item.name === column);
  } catch {
    return false;
  }
}

/**
 * 生成尝试查询的共享来源。`parentScopedToAttemptActor` = true 时（员工范围），
 * 只有属于同一执行人的父任务算「已关联」；管理员看全团队，不受父任务归属限制。
 */
export function attemptSqlSources(
  db: Database.Database,
  options: { parentScopedToAttemptActor: boolean },
): UsageAttemptSqlSources {
  const hasImageUnifiedModel = tableHasColumn(db, 'jobs', 'unifiedModel');
  const hasVideoUnifiedModel = tableHasColumn(db, 'video_jobs', 'unifiedModel');
  const snapshotUnified = `CASE WHEN json_valid(a.providerSnapshotJson)
    THEN json_extract(a.providerSnapshotJson, '$.unifiedModel') END`;
  const unifiedModel = `COALESCE(
    ${hasImageUnifiedModel ? 'j.unifiedModel' : 'NULL'},
    ${hasVideoUnifiedModel ? 'v.unifiedModel' : 'NULL'},
    ${snapshotUnified}
  )`;
  const model = `COALESCE(
    CASE WHEN json_valid(a.pricingSnapshotJson) THEN json_extract(a.pricingSnapshotJson, '$.coreModelKey') END,
    CASE WHEN json_valid(a.providerSnapshotJson) THEN json_extract(a.providerSnapshotJson, '$.coreModelKey') END,
    CASE WHEN json_valid(a.providerSnapshotJson) THEN json_extract(a.providerSnapshotJson, '$.requestModel') END,
    CASE WHEN json_valid(a.providerSnapshotJson) THEN json_extract(a.providerSnapshotJson, '$.model') END,
    CASE WHEN json_valid(a.providerSnapshotJson) THEN json_extract(a.providerSnapshotJson, '$.modelAlias') END
  )`;
  const quoteKind = `CASE WHEN json_valid(o.quoteJson) THEN json_extract(o.quoteJson, '$.kind') ELSE 'unpriced' END`;
  const costStatus = `CASE
    WHEN a.costState = 'released' THEN 'released'
    WHEN a.actualMinor IS NOT NULL AND a.costState = 'settled' THEN 'settled'
    WHEN a.costState = 'unknown' AND a.terminalState IS NOT NULL THEN 'uncertain'
    WHEN ${quoteKind} = 'unpriced' THEN 'unpriced'
    WHEN a.costState = 'unknown' THEN 'uncertain'
    ELSE 'estimated' END`;
  const chargedMinor = `CASE ${costStatus}
    WHEN 'settled' THEN COALESCE(a.actualMinor, 0)
    WHEN 'estimated' THEN a.reservedMinor
    WHEN 'uncertain' THEN a.reservedMinor
    ELSE 0 END`;
  const settledMinor = `CASE ${costStatus} WHEN 'settled' THEN COALESCE(a.actualMinor, 0) ELSE 0 END`;
  const estimatedMinor = `CASE ${costStatus} WHEN 'estimated' THEN a.reservedMinor ELSE 0 END`;
  const unpricedCount = `CASE ${costStatus} WHEN 'unpriced' THEN 1 ELSE 0 END`;
  const uncertainCount = `CASE ${costStatus} WHEN 'uncertain' THEN 1 ELSE 0 END`;
  const parentJoin = options.parentScopedToAttemptActor
    ? 'LEFT JOIN execution_media_tasks pt ON pt.id = o.mediaTaskId AND pt.actorId = a.actorId'
    : 'LEFT JOIN execution_media_tasks pt ON pt.id = o.mediaTaskId';
  return {
    from: `FROM execution_attempts a
      JOIN execution_operations o ON o.id = a.operationId
      JOIN team_users u ON u.id = a.actorId
      ${hasImageUnifiedModel ? "LEFT JOIN jobs j ON o.module = 'image' AND j.id = o.taskId" : ''}
      ${hasVideoUnifiedModel ? "LEFT JOIN video_jobs v ON o.module = 'video' AND v.id = o.taskId" : ''}
      ${parentJoin}`,
    model,
    unifiedModel,
    quoteKind,
    costStatus,
    chargedMinor,
    settledMinor,
    estimatedMinor,
    unpricedCount,
    uncertainCount,
    channels: 'pt.id IS NOT NULL',
    legacy: `o.mediaTaskId IS NULL AND ${unifiedModel} IS NULL`,
    unmapped: `pt.id IS NULL AND (o.mediaTaskId IS NOT NULL OR ${unifiedModel} IS NOT NULL)`,
  };
}

/** 展示模型：统一模型用显示名（如 `Image 2`），否则保留真实模型标识。 */
export function reportingModelName(unifiedModel: string | null, model: string): string {
  return unifiedMediaDisplayName(unifiedModel) ?? model;
}
