import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';
import { requireAccessContext } from '@/lib/media-core/access-context';
import {
  confirmEntry,
  getRunForProject,
  redraftEntry,
  updateEntryDraft,
} from '@/lib/one-click-film/store';
import { assertOneClickFilmApiReady, jsonError, readJsonBody } from '@/lib/one-click-film/http';
import { OneClickFilmError } from '@/lib/one-click-film/errors';

/** 单条脚本：保存草稿、确认、重新生成本条。 */
async function __teamRoutePOST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; code: string }> },
) {
  try {
    await assertOneClickFilmApiReady();
    const { projectId, code } = await params;
    const db = getDb();
    const access = requireAccessContext();
    if (access.kind === 'team') access.assertAccess('project', projectId, 'write');
    const run = getRunForProject(db, projectId);
    if (!run) throw new OneClickFilmError('not_found', '项目还没有一键成片记录', 404);
    const body = await readJsonBody(request);
    const action = String(body.action ?? 'save');
    const patch = {
      outline: typeof body.outline === 'string' ? body.outline : undefined,
      narration: typeof body.narration === 'string' ? body.narration : undefined,
      promptText: typeof body.promptText === 'string' ? body.promptText : undefined,
    };
    if (action === 'confirm') {
      return NextResponse.json({ entry: confirmEntry(db, { run, code, ...patch }) });
    }
    if (action === 'redraft') {
      return NextResponse.json({ entry: redraftEntry(db, { run, code }) });
    }
    return NextResponse.json({ entry: updateEntryDraft(db, { run, code, ...patch }) });
  } catch (error) {
    return jsonError(error);
  }
}

export const POST = withTeamRoute('/api/one-click-film/[projectId]/scripts/[code]', 'POST', __teamRoutePOST);
