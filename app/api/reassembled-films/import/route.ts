import path from 'node:path';
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { dataRoot } from '@/lib/data-root';
import { assertAgentRequest } from '@/lib/final-edit/reassembled/access';
import { importFilm } from '@/lib/final-edit/reassembled/import';
import { refreshFilmReview } from '@/lib/final-edit/reassembled/review';
import { finalEditErrorResponse } from '@/lib/final-edit/http';
import { FinalEditError } from '@/lib/final-edit/errors';
export async function POST(request: Request) {
  try {
    const identity = assertAgentRequest(request);
    const raw = await request.text();
    if (raw.length > 2_000_000) throw new FinalEditError('manifest_too_large', '导入清单超过 2MB', 413);
    const binding = await importFilm(getDb(), path.join(dataRoot(), 'storage'), JSON.parse(raw));
    const reviewFile = refreshFilmReview(getDb(), binding.id, true);
    return NextResponse.json({ ...identity, id: binding.id, projectId: binding.projectId, groupId: binding.groupId, variantId: binding.variantId, shotSetId: binding.shotSetId, reviewFile, reviewUrl: `${identity.origin}/api/reassembled-films/${binding.id}/review` });
  } catch (error) { return finalEditErrorResponse(error); }
}
