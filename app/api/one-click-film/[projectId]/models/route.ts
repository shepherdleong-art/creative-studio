import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';
import { requireAccessContext } from '@/lib/media-core/access-context';
import { listVideoModelOptions } from '@/lib/one-click-film/video-models';
import { assertOneClickFilmApiReady, jsonError } from '@/lib/one-click-film/http';

/** 可用视频通道及其时长、画幅、生成模式能力（服务端裁决，界面不猜）。 */
async function __teamRouteGET(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  try {
    await assertOneClickFilmApiReady();
    const { projectId } = await params;
    const access = requireAccessContext();
    if (access.kind === 'team') access.assertAccess('project', projectId, 'read');
    return NextResponse.json({ models: listVideoModelOptions(getDb()) });
  } catch (error) {
    return jsonError(error);
  }
}

export const GET = withTeamRoute('/api/one-click-film/[projectId]/models', 'GET', __teamRouteGET);
