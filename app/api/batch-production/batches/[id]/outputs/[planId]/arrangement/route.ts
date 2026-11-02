import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { assertBatchApiReady } from '@/lib/batch-production/runtime-readiness';
import { getBatchOutputArrangementView } from '@/lib/batch-production/output-arrangement';
import {
  BATCH_NO_STORE_HEADERS,
  batchProjectIdFromRequest,
  batchRouteErrorResponse,
} from '../../../../response';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';


export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 检查成片的编辑器数据视图:当前候选片段、口播/字幕/BGM 与冻结池素材使用标记。 */
async function __teamRouteGET(request: NextRequest, context: { params: Promise<{ id: string; planId: string }> }) {
  const { id, planId } = await context.params;
  const projectId = batchProjectIdFromRequest(request);
  if (!projectId) {
    return NextResponse.json({
      error: 'missing_project_id',
      message: '缺少 projectId 参数',
    }, { status: 400, headers: BATCH_NO_STORE_HEADERS });
  }
  try {
    await assertBatchApiReady();
    const view = getBatchOutputArrangementView(getDb(), projectId, id, planId);
    return NextResponse.json(view, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) {
    return batchRouteErrorResponse(error, 'batch_arrangement_failed', '读取成片安排失败');
  }
}
export const GET = withTeamRoute('/api/batch-production/batches/[id]/outputs/[planId]/arrangement', 'GET', __teamRouteGET);
