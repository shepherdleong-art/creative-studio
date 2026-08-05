import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { assertBatchApiReady } from '@/lib/batch-production/runtime-readiness';
import { getProxyCacheUsage } from '@/lib/batch-production/proxy-cache';
import {
  BATCH_NO_STORE_HEADERS,
  batchProjectIdFromRequest,
  batchRouteErrorResponse,
} from '../../batches/response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 代理缓存占用查询,供清理前显示预计释放空间。省略 projectId 时返回全部项目合计。 */
export async function GET(request: NextRequest) {
  try {
    await assertBatchApiReady();
    const projectId = batchProjectIdFromRequest(request);
    const usage = getProxyCacheUsage(getDb(), projectId ?? undefined);
    return NextResponse.json(usage, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) {
    return batchRouteErrorResponse(error, 'proxy_usage_failed', '代理占用查询失败');
  }
}
