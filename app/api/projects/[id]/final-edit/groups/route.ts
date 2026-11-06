import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getFinalEditWorkspace, recoverFinalEditPrepareJobs } from '@/lib/final-edit/runtime';
import { finalEditErrorResponse } from '@/lib/final-edit/http';
import { startFinalEditFromHttp, type FinalEditStartBody } from '@/lib/final-edit/start-http';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';


async function __teamRouteGET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    recoverFinalEditPrepareJobs();
    const { id: projectId } = await params;
    const ids = getDb().prepare(`SELECT id FROM final_edit_groups WHERE projectId=? ORDER BY updatedAt DESC, createdAt DESC`).all(projectId) as Array<{ id: string }>;
    return NextResponse.json({ groups: ids.map((row) => getFinalEditWorkspace().load(row.id)) });
  } catch (error) { return finalEditErrorResponse(error); }
}

async function __teamRoutePOST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: projectId } = await params;
    return NextResponse.json(await startFinalEditFromHttp(projectId, await request.json() as FinalEditStartBody), { status: 202 });
  } catch (error) { return finalEditErrorResponse(error); }
}
export const GET = withTeamRoute('/api/projects/[id]/final-edit/groups', 'GET', __teamRouteGET);
export const POST = withTeamRoute('/api/projects/[id]/final-edit/groups', 'POST', __teamRoutePOST);
