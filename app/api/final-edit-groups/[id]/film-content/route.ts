import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { checkLocalRequest, filmWriteActor } from '@/lib/final-edit/reassembled/access';
import { filmView } from '@/lib/final-edit/reassembled/store';
import { proposeFilmContent } from '@/lib/final-edit/reassembled/proposals';
import { getFinalEditWorkspace } from '@/lib/final-edit/runtime';
import { finalEditErrorResponse } from '@/lib/final-edit/http';
import { FinalEditError } from '@/lib/final-edit/errors';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';


type Params = { params: Promise<{ id: string }> };
async function __teamRouteGET(request: Request, { params }: Params) {
  try {
    checkLocalRequest(request);
    const { id } = await params;
    if (!filmView(getDb(), id)) throw new FinalEditError('film_not_found', '实拍成片不存在', 404);
    const group = getFinalEditWorkspace().load(id);
    return NextResponse.json({ groupId: id, projectId: group.projectId, shotSetId: group.shotSetId, variantId: group.variants[0].id, revision: group.variants[0].revision, clips: group.variants[0].timeline.clips, ...group.reassembled }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return finalEditErrorResponse(error); }
}
async function __teamRoutePOST(request: Request, { params }: Params) {
  try { const actor = filmWriteActor(request); const { id } = await params; return NextResponse.json(proposeFilmContent(getDb(), id, await request.json(), actor)); }
  catch (error) { return finalEditErrorResponse(error); }
}
export const GET = withTeamRoute('/api/final-edit-groups/[id]/film-content', 'GET', __teamRouteGET);
export const POST = withTeamRoute('/api/final-edit-groups/[id]/film-content', 'POST', __teamRoutePOST);
