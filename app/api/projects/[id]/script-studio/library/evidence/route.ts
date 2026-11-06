import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { assertScriptStudioApiReady, errorResponse } from '@/lib/script-studio/http';
import { loadSellingPointEvidenceImages } from '@/lib/script-studio/evidence-images';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';


export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function __teamRouteGET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await assertScriptStudioApiReady();
    const { id } = await params;
    const query = new URL(request.url).searchParams;
    const result = await loadSellingPointEvidenceImages(getDb(), id, query.get('revisionId') || '', query.get('pointId') || '', request.signal);
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const response = errorResponse(error);
    return NextResponse.json(response.body, { status: response.status });
  }
}
export const GET = withTeamRoute('/api/projects/[id]/script-studio/library/evidence', 'GET', __teamRouteGET);
