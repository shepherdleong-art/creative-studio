import { NextResponse } from 'next/server';
import { finalEditErrorResponse } from '@/lib/final-edit/http';
import { startFinalEditFromHttp, type FinalEditStartBody } from '@/lib/final-edit/start-http';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';


async function __teamRoutePOST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: projectId } = await params;
    return NextResponse.json(await startFinalEditFromHttp(projectId, await request.json() as FinalEditStartBody), { status: 202 });
  } catch (error) {
    return finalEditErrorResponse(error);
  }
}
export const POST = withTeamRoute('/api/projects/[id]/final-edit/start', 'POST', __teamRoutePOST);
