import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { deleteLiveMixcutProject, readLiveMixcutProject, updateLiveMixcutProject } from '@/lib/live-mixcut/projects';
import { assertBatchApiReady } from '@/lib/live-mixcut/runtime-readiness';
import { BATCH_NO_STORE_HEADERS, batchRouteErrorResponse } from '../../batches/response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type ProjectContext = { params: Promise<{ projectId: string }> };

export async function GET(_request: NextRequest, context: ProjectContext) {
  try {
    await assertBatchApiReady();
    const { projectId } = await context.params;
    return NextResponse.json({ project: readLiveMixcutProject(getDb(), projectId) }, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) {
    return batchRouteErrorResponse(error, 'read_live_mixcut_project_failed', '任务读取失败');
  }
}

export async function PATCH(request: NextRequest, context: ProjectContext) {
  try {
    await assertBatchApiReady();
    const { projectId } = await context.params;
    const body = await request.json().catch(() => ({})) as { name?: unknown; productName?: unknown };
    const project = updateLiveMixcutProject(getDb(), projectId, { name: body.name, productName: body.productName });
    return NextResponse.json({ project }, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) {
    return batchRouteErrorResponse(error, 'update_live_mixcut_project_failed', '任务更新失败');
  }
}

export async function DELETE(_request: NextRequest, context: ProjectContext) {
  try {
    await assertBatchApiReady();
    const { projectId } = await context.params;
    deleteLiveMixcutProject(getDb(), projectId);
    return NextResponse.json({ deleted: true }, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) {
    return batchRouteErrorResponse(error, 'delete_live_mixcut_project_failed', '任务删除失败');
  }
}
