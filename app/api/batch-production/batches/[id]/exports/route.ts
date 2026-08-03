import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { publishSelectedBatchOutputs } from '@/lib/batch-production/phase-e';
import { assertBatchApiReady } from '@/lib/batch-production/runtime-readiness';
import {
  BATCH_NO_STORE_HEADERS,
  batchProjectIdFromRequest,
  batchRouteErrorResponse,
} from '../../response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 发布选中且已具备真实 narration 的渲染候选；无效卡片逐条跳过并说明。 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id: batchId } = await context.params;
  const projectId = batchProjectIdFromRequest(request);
  if (!projectId) {
    return NextResponse.json({ error: 'missing_project_id', message: '缺少 projectId 参数' }, {
      status: 400,
      headers: BATCH_NO_STORE_HEADERS,
    });
  }
  const body = await request.json().catch(() => null) as { planIds?: unknown } | null;
  if (!Array.isArray(body?.planIds) || !body.planIds.every((value) => typeof value === 'string')) {
    return NextResponse.json({ error: 'invalid_plan_ids', message: 'planIds 必须是成片计划 ID 数组' }, {
      status: 400,
      headers: BATCH_NO_STORE_HEADERS,
    });
  }
  try {
    await assertBatchApiReady();
    const result = await publishSelectedBatchOutputs(getDb(), projectId, batchId, body.planIds as string[]);
    return NextResponse.json(result, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) {
    return batchRouteErrorResponse(error, 'batch_export_failed', '批次正式导出失败');
  }
}
