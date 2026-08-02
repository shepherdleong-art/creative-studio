import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { createBatchSnapshot } from '@/lib/batch-production/batch-flow';
import { assertBatchApiReady } from '@/lib/batch-production/runtime-readiness';
import {
  BATCH_NO_STORE_HEADERS,
  batchProjectIdFromRequest,
  batchRouteErrorResponse,
} from '../../response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 确认整体输入并建立可检查的 draft 快照；真正冻结发生在 start。 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const projectId = batchProjectIdFromRequest(request);
  if (!projectId) {
    return NextResponse.json({ error: 'missing_project_id', message: '缺少 projectId 参数' }, {
      status: 400,
      headers: BATCH_NO_STORE_HEADERS,
    });
  }
  const body = await request.json().catch(() => null) as {
    scriptSelections?: Array<{ scriptId: string; copyCount: number }>;
    assetSelections?: Array<{ assetId: string; analysisId: string }>;
    defaultsJson?: unknown;
  } | null;
  if (!body?.scriptSelections || body.scriptSelections.length === 0) {
    return NextResponse.json({ error: 'invalid_input', code: 'invalid_input', message: 'scriptSelections 不能为空' }, {
      status: 400,
      headers: BATCH_NO_STORE_HEADERS,
    });
  }
  if (!body.assetSelections || body.assetSelections.length === 0) {
    return NextResponse.json({ error: 'invalid_input', code: 'invalid_input', message: 'assetSelections 不能为空' }, {
      status: 400,
      headers: BATCH_NO_STORE_HEADERS,
    });
  }
  try {
    await assertBatchApiReady();
    const result = createBatchSnapshot(getDb(), projectId, id, {
      scriptSelections: body.scriptSelections,
      assetSelections: body.assetSelections,
      defaultsJson: body.defaultsJson,
    });
    return NextResponse.json({ batchId: id, ...result }, { status: 201, headers: BATCH_NO_STORE_HEADERS });
  } catch (error) {
    return batchRouteErrorResponse(error, 'batch_snapshot_failed', '批次快照建立失败');
  }
}
