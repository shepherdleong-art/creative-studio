import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';
import { requireAccessContext } from '@/lib/media-core/access-context';
import { getRunForProject } from '@/lib/one-click-film/store';
import { exportEligibility, exportEntries, listExports } from '@/lib/one-click-film/exports';
import { assertOneClickFilmApiReady, jsonError, readJsonBody } from '@/lib/one-click-film/http';
import { OneClickFilmError } from '@/lib/one-click-film/errors';

/** 已导出成片总览与导出提交。 */
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
    return NextResponse.json({
      exports: run ? listExports(db, run) : [],
      eligibility: run ? exportEligibility(db, run) : [],
    });
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
    const codes = Array.isArray(body.codes) ? body.codes.map(String) : undefined;
    const result = exportEntries(db, { run, codes, all: body.all === true });
    return NextResponse.json({ ...result, exports: listExports(db, run) });
  } catch (error) {
    return jsonError(error);
  }
}

export const GET = withTeamRoute('/api/one-click-film/[projectId]/exports', 'GET', __teamRouteGET);
export const POST = withTeamRoute('/api/one-click-film/[projectId]/exports', 'POST', __teamRoutePOST);
