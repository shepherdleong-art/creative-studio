import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { assertBatchApiReady } from '@/lib/batch-production/runtime-readiness';
import { archiveLut, deleteLutIfUnreferenced, restoreLut } from '@/lib/batch-production/lut-catalog';
import {
  BATCH_NO_STORE_HEADERS,
  batchProjectIdFromRequest,
  batchRouteErrorResponse,
} from '../../../batches/response';
import { guardManagedWorkbench } from '@/app/api/managed-deployment/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * LUT 生命周期控制:归档(从新批次选择器隐藏,可恢复)、恢复,或在没有任何
 * 引用时物理清理(仍被引用时安全拒绝,只能归档——见 deleteLutIfUnreferenced)。
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const managedGuard = await guardManagedWorkbench();
  if (managedGuard) return managedGuard;
  const { id: lutId } = await context.params;
  const projectId = batchProjectIdFromRequest(request);
  if (!projectId) {
    return NextResponse.json({
      error: 'missing_project_id',
      message: '缺少 projectId 参数',
    }, { status: 400, headers: BATCH_NO_STORE_HEADERS });
  }
  const body = await request.json().catch(() => null) as { action?: unknown } | null;
  const action = body?.action;
  if (action !== 'archive' && action !== 'restore' && action !== 'delete') {
    return NextResponse.json({
      error: 'invalid_action',
      message: 'action 必须是 archive、restore 或 delete',
    }, { status: 400, headers: BATCH_NO_STORE_HEADERS });
  }
  try {
    await assertBatchApiReady();
    const db = getDb();
    if (action === 'archive') {
      archiveLut(db, projectId, lutId);
      return NextResponse.json({ lutId, status: 'archived' }, { headers: BATCH_NO_STORE_HEADERS });
    }
    if (action === 'restore') {
      restoreLut(db, projectId, lutId);
      return NextResponse.json({ lutId, status: 'active' }, { headers: BATCH_NO_STORE_HEADERS });
    }
    const deleted = deleteLutIfUnreferenced(db, projectId, lutId);
    return NextResponse.json({ lutId, deleted }, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) {
    return batchRouteErrorResponse(error, 'lut_control_failed', 'LUT 操作失败');
  }
}
