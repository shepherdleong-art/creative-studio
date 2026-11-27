import type Database from 'better-sqlite3';

export function filmQueuePolicyNotice(db: Database.Database, operationId: unknown): string | undefined {
  if (typeof operationId !== 'string') return;
  const row = db.prepare(`SELECT waitReason, json_extract(waitDetail,'$.effectiveConcurrency') AS concurrency
    FROM execution_operations WHERE id=? AND status='deferred'`).get(operationId) as
    { waitReason: string | null; concurrency: number | null } | undefined;
  if (row?.waitReason === 'personal_concurrency' && row.concurrency === 0) {
    return '当前账号的个人并发上限为 0，请在「成员与账号 → 模型与额度」调整。';
  }
  if (row?.waitReason === 'pricing_required') return '当前账号有月度金额上限，此通道缺少计费单价，暂时无法执行。';
  if (row?.waitReason === 'monthly_budget') return '当前账号的月度可用金额不足，暂时无法执行。';
}
