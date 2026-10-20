import path from 'node:path';
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { dataRoot } from '@/lib/data-root';
import { assertAgentRequest } from '@/lib/final-edit/reassembled/access';
import { syncProduction } from '@/lib/final-edit/reassembled/production';
import { finalEditErrorResponse } from '@/lib/final-edit/http';
import { FinalEditError } from '@/lib/final-edit/errors';
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertAgentRequest(request); const raw = await request.text();
    if (raw.length > 2_000_000) throw new FinalEditError('production_too_large', '同步快照超过 2MB', 413);
    return NextResponse.json(await syncProduction(getDb(), path.join(dataRoot(), 'storage'), (await params).id, JSON.parse(raw)));
  } catch (error) { return finalEditErrorResponse(error); }
}
