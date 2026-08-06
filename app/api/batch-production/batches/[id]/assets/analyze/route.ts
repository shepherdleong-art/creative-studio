import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { ensureBatchSchedulerStarted } from '@/lib/batch-production/bootstrap';
import { queueAssetPreparation } from '@/lib/batch-production/asset-preparation';
import { assertBatchApiReady } from '@/lib/batch-production/runtime-readiness';
import {
  assertStoredScriptProviderExecutionAvailable,
  getAvailableProviders,
} from '@/lib/script-providers';
import { isCosMediaConfigured } from '@/lib/cos-media';
import {
  BATCH_NO_STORE_HEADERS,
  batchProjectIdFromRequest,
  batchRouteErrorResponse,
} from '../../../response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 在确认批次快照前为项目素材排队技术分析。分析版本属于项目素材库，
 * 所选 draft batch 只作为任务的调度/恢复载体；重复请求使用稳定 requestKey。
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id: batchId } = await context.params;
  const projectId = batchProjectIdFromRequest(request);
  if (!projectId) {
    return NextResponse.json({ error: 'missing_project_id', message: '缺少 projectId 参数' }, {
      status: 400,
      headers: BATCH_NO_STORE_HEADERS,
    });
  }
  const body = await request.json().catch(() => null) as {
    assetIds?: unknown;
    mode?: unknown;
    providerId?: unknown;
  } | null;
  if (!Array.isArray(body?.assetIds) || body.assetIds.length === 0 || body.assetIds.some((id) => typeof id !== 'string')) {
    return NextResponse.json({
      error: 'invalid_input',
      code: 'invalid_input',
      message: 'assetIds 必须是非空字符串数组',
    }, { status: 400, headers: BATCH_NO_STORE_HEADERS });
  }
  const mode = body?.mode === 'content' ? 'content' : 'technical';
  let contentProvider: ReturnType<typeof getAvailableProviders>[number] | undefined;
  if (mode === 'content') {
    if (typeof body?.providerId !== 'string' || !body.providerId.trim()) {
      return NextResponse.json({
        error: 'invalid_input',
        code: 'invalid_input',
        message: '内容分析必须选择视觉分析供应商',
      }, { status: 400, headers: BATCH_NO_STORE_HEADERS });
    }
    contentProvider = getAvailableProviders().find((provider) => (
      provider.id === body.providerId
      && provider.configured
      && provider.supportsVision
    ));
    if (!contentProvider) {
      return NextResponse.json({
        error: 'analysis_provider_unavailable',
        code: 'analysis_provider_unavailable',
        message: '视觉分析供应商不存在、未配置或不支持图片理解',
      }, { status: 409, headers: BATCH_NO_STORE_HEADERS });
    }
  }

  try {
    await assertBatchApiReady();
    if (mode === 'content') {
      await assertStoredScriptProviderExecutionAvailable(contentProvider!.id, {
        capability: 'media',
        // 公司供应商的抽帧图片经 completeJson 的 COS 受控传输发送（同执行器门禁口径）。
        mediaTransportAvailable: isCosMediaConfigured(),
      });
    }
    const result = queueAssetPreparation(
      getDb(),
      projectId,
      batchId,
      body.assetIds as string[],
      undefined,
      mode === 'content'
        ? {
            mode,
            providerId: contentProvider!.id,
            model: contentProvider!.model,
            executionScope: contentProvider!.executionScope,
          }
        : { mode },
    );
    // 只有任务写入成功后才唤醒单例调度器；重复调用仍然幂等。
    ensureBatchSchedulerStarted();
    return NextResponse.json(result, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) {
    return batchRouteErrorResponse(error, 'asset_analysis_enqueue_failed', '素材分析排队失败');
  }
}
