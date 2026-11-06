import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { checkLocalRequest } from '@/lib/final-edit/reassembled/access';
import { readProduction } from '@/lib/final-edit/reassembled/production';
import { finalEditErrorResponse } from '@/lib/final-edit/http';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';

async function __teamRouteGET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try { checkLocalRequest(request); return NextResponse.json(readProduction(getDb(), (await params).id), { headers: { 'Cache-Control': 'no-store' } }); }
  catch (error) { return finalEditErrorResponse(error); }
}
export const GET = withTeamRoute('/api/reassembled-films/productions/[id]', 'GET', __teamRouteGET);
