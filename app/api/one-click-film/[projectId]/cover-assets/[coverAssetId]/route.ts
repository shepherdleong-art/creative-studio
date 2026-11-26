import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { fileResponse } from '@/lib/media-core/file-response';
import { resolveGeneratedFilmCoverPath } from '@/lib/one-click-film/cover-assets';
import { readCoverThumbnail } from '@/lib/one-click-film/cover-render';
import { OneClickFilmError } from '@/lib/one-click-film/errors';
import { assertOneClickFilmApiReady, jsonError } from '@/lib/one-click-film/http';
import { getEntry, getRunForProject } from '@/lib/one-click-film/store';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';

async function __teamRouteGET(request: NextRequest, { params }: { params: Promise<{ projectId: string; coverAssetId: string }> }) {
  try {
    await assertOneClickFilmApiReady();
    const { projectId, coverAssetId } = await params;
    const db = getDb();
    const run = getRunForProject(db, projectId);
    const entryCode = request.nextUrl.searchParams.get('entryCode');
    const unavailable = new OneClickFilmError('not_found', '找不到此条目的全景封面。', 404);
    if (!run || !entryCode) throw unavailable;
    const entry = getEntry(db, run.id, entryCode);
    const file = resolveGeneratedFilmCoverPath(db, run, entry.id, coverAssetId);
    if (!file) throw unavailable;
    if (request.nextUrl.searchParams.get('thumbnail') === '1') {
      const { jpeg } = await readCoverThumbnail(file, 240);
      return new NextResponse(new Uint8Array(jpeg), { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, no-store' } });
    }
    return fileResponse(request, file, 'image/png', { cacheControl: 'private, no-store' });
  } catch (error) {
    return jsonError(error instanceof OneClickFilmError ? error : new OneClickFilmError('not_found', '找不到此条目的全景封面。', 404));
  }
}

export const GET = withTeamRoute('/api/one-click-film/[projectId]/cover-assets/[coverAssetId]', 'GET', __teamRouteGET);
