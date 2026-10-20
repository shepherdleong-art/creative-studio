import { getDb } from '@/lib/db';
import { checkLocalRequest } from '@/lib/final-edit/reassembled/access';
import { filmReviewCover } from '@/lib/final-edit/reassembled/review-media';
import { mediaResponse } from '@/lib/final-edit/media-response';
import { finalEditErrorResponse } from '@/lib/final-edit/http';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    checkLocalRequest(request);
    const version = Number(new URL(request.url).searchParams.get('version'));
    return mediaResponse(request, filmReviewCover(getDb(), (await params).id, version), 'image/jpeg');
  } catch (error) { return finalEditErrorResponse(error); }
}
