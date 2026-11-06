import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { ScriptStudioError } from '@/lib/script-studio/errors';
import { assertScriptStudioApiReady, errorResponse } from '@/lib/script-studio/http';
import { getTask } from '@/lib/script-studio/tasks';
import { toTaskSnapshot } from '@/lib/script-studio/snapshot';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';


export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function __teamRouteGET(
  _request: Request,
  { params }: { params: Promise<{ id: string; taskId: string }> },
) {
  try {
    await assertScriptStudioApiReady();
    const { id: projectId, taskId } = await params;
    const task = getTask(getDb(), projectId, taskId);
    if (!task) throw new ScriptStudioError('not_found', '任务不存在或不属于当前项目');
    return NextResponse.json({ task: toTaskSnapshot(task) });
  } catch (error) {
    const result = errorResponse(error);
    return NextResponse.json(result.body, { status: result.status });
  }
}
export const GET = withTeamRoute('/api/projects/[id]/script-studio/tasks/[taskId]', 'GET', __teamRouteGET);
