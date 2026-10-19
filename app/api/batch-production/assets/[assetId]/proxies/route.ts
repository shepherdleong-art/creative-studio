import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { assertBatchApiReady } from '@/lib/batch-production/runtime-readiness';
import { ensureBatchSchedulerStarted } from '@/lib/batch-production/bootstrap';
import { PROXY_PROFILE_VERSION } from '@/lib/batch-production/proxy-executor';
import { requestProxy } from '@/lib/batch-production/proxy-cache';
import { BatchDomainError } from '@/lib/batch-production/errors';
import {
  BATCH_NO_STORE_HEADERS,
  batchProjectIdFromRequest,
  batchRouteErrorResponse,
} from '../../../batches/response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 素材级代理请求:只为单个素材创建代理请求(batchId/batchVersionId 为 NULL)
 * 并排 proxy_generate 任务。不要求批次存在或已确认——代理归属素材、不绑批次
 * (共识 2);幂等由数据库部分唯一索引 UNIQUE(projectId, assetId, proxyKey)
 * 保证,冲突时返回现存请求。
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ assetId: string }> },
) {
  const { assetId } = await context.params;
  const projectId = batchProjectIdFromRequest(request);
  if (!projectId) {
    return NextResponse.json({
      error: 'missing_project_id',
      message: '缺少 projectId 参数',
    }, { status: 400, headers: BATCH_NO_STORE_HEADERS });
  }
  try {
    await assertBatchApiReady();
    ensureBatchSchedulerStarted();
    const db = getDb();

    const asset = db.prepare(`
      SELECT projectId, contentFingerprint FROM batch_assets WHERE id = ?
    `).get(assetId) as { projectId: string; contentFingerprint: string } | undefined;
    if (!asset || asset.projectId !== projectId) {
      throw new BatchDomainError('not_found', '素材不存在');
    }

    const { taskId, requestId, cacheItemId, proxyKey } = requestProxy(db, projectId, null, {
      assetId,
      contentFingerprint: asset.contentFingerprint,
      profileVersion: PROXY_PROFILE_VERSION,
    });
    return NextResponse.json(
      { requested: [{ assetId, taskId, requestId, cacheItemId, proxyKey }] },
      { headers: BATCH_NO_STORE_HEADERS },
    );
  } catch (error) {
    return batchRouteErrorResponse(error, 'proxy_request_failed', '代理请求失败');
  }
}
