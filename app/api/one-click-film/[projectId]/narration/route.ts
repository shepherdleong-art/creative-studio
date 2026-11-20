import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';
import { requireAccessContext } from '@/lib/media-core/access-context';
import { getRunForProject } from '@/lib/one-click-film/store';
import {
  confirmNarration, listNarrations, listTtsProviders, markNarrationListened, synthesizeNarrations,
} from '@/lib/one-click-film/tts';
import { assertOneClickFilmApiReady, jsonError, readJsonBody } from '@/lib/one-click-film/http';
import { OneClickFilmError } from '@/lib/one-click-film/errors';

/** TTS 配音：列出服务与音色、生成、试听后确认。 */
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
      providers: listTtsProviders(db),
      narrations: run ? listNarrations(db, run) : [],
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
    const action = String(body.action ?? 'synthesize');
    if (action === 'confirm') {
      return NextResponse.json({
        narrations: confirmNarration(db, {
          run,
          narrationId: String(body.narrationId ?? ''),
          listened: body.listened === true,
        }),
      });
    }
    if (action === 'listened') {
      return NextResponse.json({
        narrations: markNarrationListened(db, { run, narrationId: String(body.narrationId ?? '') }),
      });
    }
    const codes = Array.isArray(body.codes) ? body.codes.map(String) : undefined;
    return NextResponse.json({ narrations: await synthesizeNarrations({ run, codes, db }) });
  } catch (error) {
    return jsonError(error);
  }
}

export const GET = withTeamRoute('/api/one-click-film/[projectId]/narration', 'GET', __teamRouteGET);
export const POST = withTeamRoute('/api/one-click-film/[projectId]/narration', 'POST', __teamRoutePOST);
