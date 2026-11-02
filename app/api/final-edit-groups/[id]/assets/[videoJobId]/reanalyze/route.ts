import { NextResponse } from 'next/server';
import { getFinalEditWorkspace } from '@/lib/final-edit/runtime';
import { finalEditErrorResponse } from '@/lib/final-edit/http';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';


async function __teamRoutePOST(_request: Request, { params }: { params: Promise<{ id: string; videoJobId: string }> }) {
  try {
    const { id, videoJobId } = await params;
    return NextResponse.json(await getFinalEditWorkspace().reanalyzeAsset(id, videoJobId));
  } catch (error) { return finalEditErrorResponse(error); }
}
export const POST = withTeamRoute('/api/final-edit-groups/[id]/assets/[videoJobId]/reanalyze', 'POST', __teamRoutePOST);
