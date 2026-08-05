import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { assertBatchApiReady } from '@/lib/batch-production/runtime-readiness';
import { cleanupAllProjectsProxyCache, cleanupProxyCache } from '@/lib/batch-production/proxy-cache';
import {
  BATCH_NO_STORE_HEADERS,
  batchProjectIdFromRequest,
  batchRouteErrorResponse,
} from '../../batches/response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 清理代理缓存。带 projectId 时清理选中素材(assetIds)或整个项目;
 * 省略 projectId 时是设置页"清理全部代理"入口,按项目分别清理并汇总结果。
 * 正在使用中的代理会被跳过并标记 pending-delete,不会一边使用一边删除。
 */
export async function POST(request: NextRequest) {
  const projectId = batchProjectIdFromRequest(request);
  const body = await request.json().catch(() => ({})) as { assetIds?: unknown };
  const assetIds = Array.isArray(body.assetIds)
    ? body.assetIds.filter((value): value is string => typeof value === 'string')
    : undefined;
  try {
    await assertBatchApiReady();
    const db = getDb();
    const result = projectId
      ? cleanupProxyCache(db, projectId, { assetIds })
      : cleanupAllProjectsProxyCache(db);
    return NextResponse.json(result, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) {
    return batchRouteErrorResponse(error, 'proxy_cleanup_failed', '代理清理失败');
  }
}
