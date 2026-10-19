import { NextResponse } from 'next/server';

import { getDb } from '@/lib/db';
import { reconcileUsageLedger } from '@/lib/usage-ledger';
import {
  isCoreUsageCategory,
  isCoreUsageModelKey,
  parseUsageBoundary,
  queryUsageDashboard,
} from '@/lib/usage-query';
import { getUsageSchemaReadiness } from '@/lib/usage-schema';
import type { CoreUsageCategory, CoreUsageModelKey } from '@/lib/usage-pricing';

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' } as const;

export async function GET(request: Request) {
  const db = getDb();
  const readiness = getUsageSchemaReadiness(db);
  if (!readiness.available) {
    return NextResponse.json(
      { error: 'usage_unavailable', message: '消耗统计暂不可用，其他工作台功能不受影响。' },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }

  let query: {
    from?: string;
    to?: string;
    coreModelKey?: CoreUsageModelKey;
    category?: CoreUsageCategory;
  };
  try {
    const params = new URL(request.url).searchParams;
    const modelValue = params.get('coreModelKey')?.trim() || undefined;
    const categoryValue = params.get('category')?.trim() || undefined;
    if (modelValue && !isCoreUsageModelKey(modelValue)) throw new Error('无效的核心模型筛选');
    if (categoryValue && !isCoreUsageCategory(categoryValue)) throw new Error('无效的类别筛选');
    const coreModelKey: CoreUsageModelKey | undefined = modelValue && isCoreUsageModelKey(modelValue) ? modelValue : undefined;
    const category: CoreUsageCategory | undefined = categoryValue && isCoreUsageCategory(categoryValue) ? categoryValue : undefined;
    const from = parseUsageBoundary(params.get('from'));
    const to = parseUsageBoundary(params.get('to'));
    if (from && to && from >= to) throw new Error('开始时间必须早于结束时间');

    query = {
      from,
      to,
      coreModelKey,
      category,
    };
  } catch (error) {
    return NextResponse.json(
      { error: 'invalid_usage_query', message: error instanceof Error ? error.message : '查询参数无效' },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  // Reconciliation is idempotent. Transient write failures do not prevent
  // reading committed rows, but missing/damaged usage tables fail this API closed.
  const reconciliation = reconcileUsageLedger(db);
  if (reconciliation.reason === 'schema_unavailable') {
    return NextResponse.json(
      { error: 'usage_unavailable', message: '消耗统计暂不可用，其他工作台功能不受影响。' },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }
  try {
    return NextResponse.json(queryUsageDashboard(db, query), { headers: NO_STORE_HEADERS });
  } catch {
    return NextResponse.json(
      { error: 'usage_unavailable', message: '消耗统计读取失败，其他工作台功能不受影响。' },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }
}
