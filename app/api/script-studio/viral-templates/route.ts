import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { assertScriptStudioApiReady, errorResponse } from '@/lib/script-studio/http';
import { getViralTemplateLibraryView } from '@/lib/script-studio/viral-templates';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';


export const runtime = 'nodejs';

/** 爆文模板库状态：当前修订、条目计数与历史版本。 */
async function __teamRouteGET() {
  try {
    await assertScriptStudioApiReady();
    const view = getViralTemplateLibraryView(getDb());
    return NextResponse.json(view);
  } catch (error) {
    const { status, body } = errorResponse(error);
    return NextResponse.json(body, { status });
  }
}
export const GET = withTeamRoute('/api/script-studio/viral-templates', 'GET', __teamRouteGET);
