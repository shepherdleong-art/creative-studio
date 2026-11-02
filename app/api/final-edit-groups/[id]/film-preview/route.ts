import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { enqueueFilmRender } from '@/lib/final-edit/reassembled/jobs';
import { checkLocalRequest } from '@/lib/final-edit/reassembled/access';
import { wakeFinalEditWorker } from '@/lib/final-edit/worker';
import { finalEditErrorResponse } from '@/lib/final-edit/http';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';

async function __teamRoutePOST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try { checkLocalRequest(request); const input = await request.json(); const result = enqueueFilmRender(getDb(), { ...input, groupId: (await params).id }, 'preview'); wakeFinalEditWorker(); return NextResponse.json(result, { status: 202 }); }
  catch (error) { return finalEditErrorResponse(error); }
}
export const POST = withTeamRoute('/api/final-edit-groups/[id]/film-preview', 'POST', __teamRoutePOST);
