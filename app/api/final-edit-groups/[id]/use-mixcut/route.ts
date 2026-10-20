import path from 'node:path';
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { dataRoot } from '@/lib/data-root';
import { adoptFilmIntoMixcut } from '@/lib/final-edit/reassembled/adopt';
import { getFinalEditWorkspace } from '@/lib/final-edit/runtime';
import { finalEditErrorResponse } from '@/lib/final-edit/http';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const origin = request.headers.get('origin');
  const host = request.headers.get('host');
  if (request.headers.has('x-reassembled-token') || request.headers.get('sec-fetch-site') !== 'same-origin' || !origin || new URL(origin).host !== host) return NextResponse.json({ error: 'origin_denied' }, { status: 403 });
  try {
    const { id } = await params;
    adoptFilmIntoMixcut(getDb(), path.join(dataRoot(), 'storage'), id);
    return NextResponse.json(getFinalEditWorkspace().load(id));
  } catch (error) { return finalEditErrorResponse(error); }
}
