import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { assertScriptStudioApiReady, errorResponse } from '@/lib/script-studio/http';
import { getCatalogRevisionView } from '@/lib/script-studio/catalogs';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';


export const runtime = 'nodejs';

async function __teamRouteGET(
  _request: Request,
  { params }: { params: Promise<{ catalogId: string; revisionId: string }> },
) {
  try {
    await assertScriptStudioApiReady();
    const { catalogId, revisionId } = await params;
    const view = getCatalogRevisionView(getDb(), revisionId);
    if (!view || view.catalogId !== catalogId) {
      return NextResponse.json({ error: 'not_found', message: '目录修订不存在' }, { status: 404 });
    }
    return NextResponse.json({ revision: view });
  } catch (error) {
    const { status, body } = errorResponse(error);
    return NextResponse.json(body, { status });
  }
}
export const GET = withTeamRoute('/api/script-studio/catalogs/[catalogId]/revisions/[revisionId]', 'GET', __teamRouteGET);
