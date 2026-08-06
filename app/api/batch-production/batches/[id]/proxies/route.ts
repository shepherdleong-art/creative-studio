import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { assertBatchApiReady } from '@/lib/batch-production/runtime-readiness';
import { ensureBatchSchedulerStarted } from '@/lib/batch-production/bootstrap';
import { PROXY_PROFILE_VERSION } from '@/lib/batch-production/proxy-executor';
import { COLOR_PIPELINE_VERSION, upgradeColorSnapshot } from '@/lib/batch-production/color-pipeline';
import { requestProxy } from '@/lib/batch-production/proxy-cache';
import { BatchDomainError } from '@/lib/batch-production/errors';
import {
  BATCH_NO_STORE_HEADERS,
  batchProjectIdFromRequest,
  batchRouteErrorResponse,
} from '../../response';
import { guardManagedWorkbench } from '@/app/api/managed-deployment/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface PoolAssetRow {
  assetId: string;
  colorJson: string;
  contentFingerprint: string;
}

/**
 * 为当前批次版本素材池中明确选择的素材(或省略 assetIds 时的整个池)请求代理。
 * 色彩快照永远从批次当前版本的素材池记录读取,不接受调用方传入——
 * 代理必须匹配已确认的色彩快照,不能被页面伪造成任意 LUT 组合。
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const managedGuard = await guardManagedWorkbench();
  if (managedGuard) return managedGuard;
  const { id: batchId } = await context.params;
  const projectId = batchProjectIdFromRequest(request);
  if (!projectId) {
    return NextResponse.json({
      error: 'missing_project_id',
      message: '缺少 projectId 参数',
    }, { status: 400, headers: BATCH_NO_STORE_HEADERS });
  }
  const body = await request.json().catch(() => ({})) as { assetIds?: unknown };
  const assetIdsProvided = Object.prototype.hasOwnProperty.call(body, 'assetIds');
  const assetIdsValid = !assetIdsProvided || (
    Array.isArray(body.assetIds)
    && body.assetIds.every((value) => typeof value === 'string' && value.length > 0)
  );
  const requestedAssetIds = Array.isArray(body.assetIds)
    ? body.assetIds.filter((value): value is string => typeof value === 'string')
    : undefined;

  try {
    if (!assetIdsValid) {
      throw new BatchDomainError('invalid_input', 'assetIds 必须是非空字符串数组');
    }
    await assertBatchApiReady();
    ensureBatchSchedulerStarted();
    const db = getDb();

    const batch = db.prepare(`
      SELECT currentVersionId FROM batch_productions WHERE id = ? AND projectId = ? AND deletedAt IS NULL
    `).get(batchId, projectId) as { currentVersionId: string | null } | undefined;
    if (!batch) {
      throw new BatchDomainError('not_found', '批次不存在');
    }
    if (!batch.currentVersionId) {
      throw new BatchDomainError('conflict', '批次还没有任何输入快照');
    }
    const batchVersionId = batch.currentVersionId;

    const poolRows = db.prepare(`
      SELECT pool.assetId AS assetId, pool.colorJson AS colorJson, assets.contentFingerprint AS contentFingerprint
      FROM batch_asset_pool_items pool
      JOIN batch_assets assets ON assets.id = pool.assetId
      WHERE pool.batchVersionId = ?
    `).all(batchVersionId) as PoolAssetRow[];

    const uniqueRequestedAssetIds = requestedAssetIds
      ? [...new Set(requestedAssetIds)]
      : undefined;
    const targets = uniqueRequestedAssetIds
      ? poolRows.filter((row) => uniqueRequestedAssetIds.includes(row.assetId))
      : poolRows;
    if (targets.length === 0) {
      throw new BatchDomainError('invalid_input', '没有可请求代理的素材');
    }
    if (uniqueRequestedAssetIds && targets.length !== uniqueRequestedAssetIds.length) {
      throw new BatchDomainError('invalid_input', '部分素材不属于当前批次版本素材池');
    }

    const results = targets.map((row) => {
      const colorSnapshot = upgradeColorSnapshot(JSON.parse(row.colorJson));
      const { taskId, cacheItemId, proxyKey } = requestProxy(db, projectId, batchId, {
        assetId: row.assetId,
        contentFingerprint: row.contentFingerprint,
        colorSnapshot,
        profileVersion: PROXY_PROFILE_VERSION,
        colorPipelineVersion: COLOR_PIPELINE_VERSION,
        batchVersionId,
      });
      return { assetId: row.assetId, taskId, cacheItemId, proxyKey };
    });

    return NextResponse.json({ requested: results }, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) {
    return batchRouteErrorResponse(error, 'proxy_request_failed', '代理请求失败');
  }
}
