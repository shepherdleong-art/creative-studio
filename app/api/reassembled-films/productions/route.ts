import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { assertAgentRequest, checkLocalRequest } from '@/lib/final-edit/reassembled/access';
import { beginProduction, readProduction } from '@/lib/final-edit/reassembled/production';
import { finalEditErrorResponse } from '@/lib/final-edit/http';
import { FinalEditError } from '@/lib/final-edit/errors';

export async function POST(request: Request) {
  try {
    assertAgentRequest(request);
    const raw = await request.text();
    if (raw.length > 2_000_000) throw new FinalEditError('production_too_large', '制作请求超过 2MB', 413);
    return NextResponse.json(beginProduction(getDb(), JSON.parse(raw)));
  } catch (error) { return finalEditErrorResponse(error); }
}
export function GET(request: Request) {
  try {
    checkLocalRequest(request);
    const projectId = new URL(request.url).searchParams.get('projectId');
    const db = getDb();
    const ids = db.prepare('SELECT id FROM final_edit_film_productions WHERE projectId=? ORDER BY createdAt DESC').all(projectId || '') as Array<{ id: string }>;
    return NextResponse.json(ids.map(({ id }) => readProduction(db, id)), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return finalEditErrorResponse(error); }
}
