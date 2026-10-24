import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { orchestrateBatchExport } from '@/lib/live-mixcut/export-orchestrator';
import { writeFormulaExportFolderManifest } from '@/lib/live-mixcut/formula/export-manifest';
import { assertBatchApiReady } from '@/lib/live-mixcut/runtime-readiness';
import { writeLog } from '@/lib/logger';
import {
  BATCH_NO_STORE_HEADERS,
  batchProjectIdFromRequest,
  batchRouteErrorResponse,
} from '../../response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 正式导出编排入口。服务端统一判断每条计划:
 * 预检不通过 → skipped;需要渲染 → render_queued/rendering;渲染失败 → render_failed;
 * 已发布且未过期 → already_published(幂等);复制注册成功 → published。
 * 调度器唤醒由编排模块内部完成(幂等),路由不接触任务领取细节。
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id: batchId } = await context.params;
  const projectId = batchProjectIdFromRequest(request);
  if (!projectId) {
    return NextResponse.json({ error: 'missing_project_id', message: '缺少 projectId 参数' }, {
      status: 400,
      headers: BATCH_NO_STORE_HEADERS,
    });
  }
  const body = await request.json().catch(() => null) as { planIds?: unknown; allowPackagingPlaceholder?: unknown } | null;
  if (!Array.isArray(body?.planIds) || !body.planIds.every((value) => typeof value === 'string')) {
    return NextResponse.json({ error: 'invalid_plan_ids', message: 'planIds 必须是成片计划 ID 数组' }, {
      status: 400,
      headers: BATCH_NO_STORE_HEADERS,
    });
  }
  try {
    await assertBatchApiReady();
    const result = await orchestrateBatchExport(getDb(), projectId, batchId, body.planIds as string[], {
      allowPackagingPlaceholder: body.allowPackagingPlaceholder === true,
    });
    if (result.items.some(({ status }) => status === 'published' || status === 'already_published')) {
      try {
        writeFormulaExportFolderManifest(getDb(), projectId, batchId);
      } catch (error) {
        writeLog({ projectId, level: 'error',
          message: `实拍混剪清单写入失败：${error instanceof Error ? error.message : String(error)}` });
      }
    }
    return NextResponse.json(result, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) {
    return batchRouteErrorResponse(error, 'live_mixcut_export_failed', '批次正式导出失败');
  }
}
