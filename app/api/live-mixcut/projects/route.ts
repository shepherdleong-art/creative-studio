import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { createLiveMixcutProject, listLiveMixcutProjects } from '@/lib/live-mixcut/projects';
import { assertBatchApiReady } from '@/lib/live-mixcut/runtime-readiness';
import { BATCH_NO_STORE_HEADERS, batchRouteErrorResponse } from '../batches/response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await assertBatchApiReady();
    return NextResponse.json({ projects: listLiveMixcutProjects(getDb()) }, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) {
    return batchRouteErrorResponse(error, 'list_live_mixcut_projects_failed', '任务列表读取失败');
  }
}

export async function POST(request: NextRequest) {
  try {
    await assertBatchApiReady();
    const body = await request.json().catch(() => ({})) as {
      storeCode?: unknown; productCode?: unknown; editorName?: unknown;
    };
    const project = createLiveMixcutProject(getDb(), {
      storeCode: body.storeCode,
      productCode: body.productCode,
      editorName: body.editorName,
    });
    return NextResponse.json({ project }, { status: 201, headers: BATCH_NO_STORE_HEADERS });
  } catch (error) {
    return batchRouteErrorResponse(error, 'create_live_mixcut_project_failed', '任务创建失败');
  }
}
