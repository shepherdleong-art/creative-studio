import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';
import { requireAccessContext } from '@/lib/media-core/access-context';
import { getRunForProject } from '@/lib/one-click-film/store';
import { exportZipEntries } from '@/lib/one-click-film/exports';
import { buildGenericZipStream } from '@/lib/zip-download';
import { assertOneClickFilmApiReady, jsonError } from '@/lib/one-click-film/http';

/** 把选中的交付记录打包成 ZIP：逐个探测内容，文件名可区分。 */
async function __teamRoutePOST(
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
    if (!run) return NextResponse.json({ error: 'not_found', message: '项目还没有一键成片记录' }, { status: 404 });
    const body = await request.json().catch(() => ({})) as { ids?: unknown };
    const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === 'string') : [];
    const entries = exportZipEntries(db, { run, ids });
    const stream = buildGenericZipStream(entries);
    return new NextResponse(stream, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="one-click-film-${run.id.slice(0, 8)}.zip"`,
      },
    });
  } catch (error) {
    return jsonError(error);
  }
}

export const POST = withTeamRoute('/api/one-click-film/[projectId]/exports/zip', 'POST', __teamRoutePOST);
