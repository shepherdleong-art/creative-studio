import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { latestMixcutReviewCover } from '@/lib/final-edit/reassembled/review';
import { mediaResponse } from '@/lib/final-edit/media-response';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const file = latestMixcutReviewCover(getDb(), (await params).id);
  if (!file) return NextResponse.json({ error: 'cover_not_found' }, { status: 404 });
  const response = mediaResponse(request, file, 'image/jpeg');
  response.headers.set('Cache-Control', 'no-store');
  return response;
}
