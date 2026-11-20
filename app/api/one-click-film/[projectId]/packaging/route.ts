import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';
import { requireAccessContext } from '@/lib/media-core/access-context';
import { getRunForProject } from '@/lib/one-click-film/store';
import { listPackaging, preparePackaging, updatePackagingDraft, type TextCue } from '@/lib/one-click-film/packaging';
import { assertOneClickFilmApiReady, jsonError, readJsonBody } from '@/lib/one-click-film/http';
import { OneClickFilmError } from '@/lib/one-click-film/errors';

/** 一键批量包装与包装后继续编辑。 */
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
    return NextResponse.json({ packaging: run ? listPackaging(db, run) : [] });
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
    const action = String(body.action ?? 'prepare');

    if (action === 'edit') {
      return NextResponse.json({
        packaging: updatePackagingDraft(db, {
          run,
          entryCode: String(body.entryCode ?? ''),
          title: typeof body.title === 'string' ? body.title : undefined,
          template: typeof body.template === 'string' ? body.template : undefined,
          subtitleCues: Array.isArray(body.subtitleCues) ? body.subtitleCues as TextCue[] : undefined,
          pointCues: Array.isArray(body.pointCues) ? body.pointCues as TextCue[] : undefined,
          bgmVolume: typeof body.bgmVolume === 'number' ? body.bgmVolume : undefined,
        }),
      });
    }

    const codes = Array.isArray(body.codes) ? body.codes.map(String) : undefined;
    const results = preparePackaging(db, { run, options: body.options, codes });
    return NextResponse.json({ results, packaging: listPackaging(db, run) });
  } catch (error) {
    return jsonError(error);
  }
}

export const GET = withTeamRoute('/api/one-click-film/[projectId]/packaging', 'GET', __teamRouteGET);
export const POST = withTeamRoute('/api/one-click-film/[projectId]/packaging', 'POST', __teamRoutePOST);
