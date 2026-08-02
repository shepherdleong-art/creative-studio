import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { assertBatchApiReady } from '@/lib/batch-production/runtime-readiness';
import { createBatchProduction, listProjectBatchProductions } from '@/lib/batch-production/versions';
import { BATCH_NO_STORE_HEADERS, batchRouteErrorResponse } from './response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 创建一次批量生产工作单(批次);列表按 projectId 查询当前项目批次。 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null) as { projectId?: unknown; name?: unknown } | null;
  const projectId = typeof body?.projectId === 'string' && body.projectId ? body.projectId : null;
  const name = typeof body?.name === 'string' && body.name.trim() ? body.name.trim() : null;
  if (!projectId || !name) {
    return NextResponse.json({
      error: 'invalid_input',
      message: 'projectId 与 name 不能为空',
    }, { status: 400, headers: BATCH_NO_STORE_HEADERS });
  }
  try {
    await assertBatchApiReady();
    const db = getDb();
    const project = db.prepare(`SELECT id FROM projects WHERE id = ?`).get(projectId);
    if (!project) {
      return NextResponse.json({
        error: 'project_not_found',
        message: '项目不存在',
      }, { status: 404, headers: BATCH_NO_STORE_HEADERS });
    }
    const id = createBatchProduction(db, projectId, name);
    return NextResponse.json({ id, projectId, name }, { status: 201, headers: BATCH_NO_STORE_HEADERS });
  } catch (error) {
    return batchRouteErrorResponse(error, 'create_batch_failed', '批次创建失败');
  }
}

export async function GET(request: NextRequest) {
  const projectId = request.nextUrl.searchParams.get('projectId');
  if (!projectId) {
    return NextResponse.json({
      error: 'missing_project_id',
      message: '缺少 projectId 参数',
    }, { status: 400, headers: BATCH_NO_STORE_HEADERS });
  }
  try {
    await assertBatchApiReady();
    const db = getDb();
    const batches = listProjectBatchProductions(db, projectId);
    return NextResponse.json({ projectId, batches }, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) {
    return batchRouteErrorResponse(error, 'list_batches_failed', '批次列表读取失败');
  }
}
