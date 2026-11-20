import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';
import { requireAccessContext } from '@/lib/media-core/access-context';
import { authorizeManagedFileRead } from '@/lib/media-core/access-context';
import { fileResponse } from '@/lib/media-core/file-response';
import { filmStoragePath } from '@/lib/one-click-film/composition';
import { getRunForProject } from '@/lib/one-click-film/store';
import {
  configureNarrations, confirmNarration, listNarrations, listTtsProviders, markNarrationListened, synthesizeNarrations,
} from '@/lib/one-click-film/tts';
import { assertOneClickFilmApiReady, jsonError, readJsonBody } from '@/lib/one-click-film/http';
import { OneClickFilmError } from '@/lib/one-click-film/errors';

/** TTS 配音：列出服务与音色、生成、试听后确认。 */
async function __teamRouteGET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  try {
    await assertOneClickFilmApiReady();
    const { projectId } = await params;
    const db = getDb();
    const access = requireAccessContext();
    if (access.kind === 'team') access.assertAccess('project', projectId, 'read');
    const run = getRunForProject(db, projectId);
    const audio = new URL(request.url).searchParams.get('audio');
    if (audio) {
      const stored = run ? db.prepare(`SELECT relativePath FROM one_click_film_narrations WHERE id=? AND runId=? AND status='ready'`).pluck().get(audio, run.id) : null;
      if (typeof stored !== 'string' || !stored) throw new OneClickFilmError('not_found', '配音不存在', 404);
      const file = filmStoragePath(stored);
      if (access.kind === 'team') authorizeManagedFileRead(file);
      return fileResponse(request, file, file.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg');
    }
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
    if (action === 'configure') {
      const affected = configureNarrations(db, {
        run, providerId: String(body.providerId ?? ''), voice: String(body.voice ?? ''), speed: Number(body.speed),
      });
      return NextResponse.json({ affected, narrations: listNarrations(db, run) });
    }
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
