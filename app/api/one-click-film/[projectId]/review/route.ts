import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';
import { requireAccessContext } from '@/lib/media-core/access-context';
import { getRunForProject } from '@/lib/one-click-film/store';
import {
  approveReview,
  listReviews,
  markShotReview,
  mergeShots,
  splitShot,
  undoableMergeId,
  undoMerge,
} from '@/lib/one-click-film/review';
import { syncGenerationStatus } from '@/lib/one-click-film/generation';
import { getFilmPreview, readFilmBody, readyHdPaths, sourceIdsForBody } from '@/lib/one-click-film/composition';
import { assertOneClickFilmApiReady, jsonError, readJsonBody } from '@/lib/one-click-film/http';
import { OneClickFilmError } from '@/lib/one-click-film/errors';

/** A 布局审片：读取成片与镜头区间，手动切分/合并、标记通过。 */
async function __teamRouteGET(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  try {
    await assertOneClickFilmApiReady();
    const { projectId } = await params;
    const db = getDb();
    const access = requireAccessContext();
    if (access.kind === 'team') access.assertAccess('project', projectId, 'read');
    const run = getRunForProject(db, projectId);
    if (!run) return NextResponse.json({ reviews: [] });
    await syncGenerationStatus(db, run);
    const reviews = await Promise.all(listReviews(db, run).map(async (review) => {
      const body = readFilmBody(db, run, review.entryCode);
      if (!body) return null;
      const hdReady = body.draft && readyHdPaths(db, run, body).size === sourceIdsForBody(body).length;
      const videoUrl = await getFilmPreview(db, run, body);
      return {
        ...review, entryId: body.entryId, videoUrl, draft: body.draft, hdApproved: body.hdApproved,
        undoMergeId: undoableMergeId(db, review),
        hdVideoUrl: hdReady ? await getFilmPreview(db, run, body, true) : null,
      };
    }));
    return NextResponse.json({ reviews: reviews.filter(Boolean) });
  } catch (error) {
    return jsonError(error);
  }
}

async function __teamRoutePOST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  try {
    await assertOneClickFilmApiReady();
    const { projectId } = await params;
    const db = getDb();
    const access = requireAccessContext();
    if (access.kind === 'team') access.assertAccess('project', projectId, 'write');
    const run = getRunForProject(db, projectId);
    if (!run) throw new OneClickFilmError('not_found', '项目还没有一键成片记录', 404);
    const body = await readJsonBody(request);
    const action = String(body.action ?? '');
    const jobId = String(body.jobId ?? '');

    if (action === 'split') {
      return NextResponse.json({
        shots: splitShot(db, { run, jobId, shotId: String(body.shotId ?? ''), atUs: Number(body.atUs) }),
      });
    }
    if (action === 'merge') {
      return NextResponse.json({
        shots: mergeShots(db, {
          run, jobId,
          shotIds: Array.isArray(body.shotIds) ? body.shotIds.map(String) : [],
        }),
      });
    }
    if (action === 'undo-merge') {
      return NextResponse.json({ shots: undoMerge(db, { run, jobId, mergeId: String(body.mergeId ?? '') }) });
    }
    if (action === 'mark') {
      return NextResponse.json({
        shots: markShotReview(db, { run, jobId, shotId: String(body.shotId ?? ''), mark: String(body.mark ?? '') }),
      });
    }
    if (action === 'approve') {
      approveReview(db, { run, jobId });
      return NextResponse.json({ reviews: listReviews(db, run) });
    }
    throw new OneClickFilmError('invalid_input', '不支持的审片操作');
  } catch (error) {
    return jsonError(error);
  }
}

export const GET = withTeamRoute('/api/one-click-film/[projectId]/review', 'GET', __teamRouteGET);
export const POST = withTeamRoute('/api/one-click-film/[projectId]/review', 'POST', __teamRoutePOST);
