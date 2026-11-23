import { NextResponse } from 'next/server';
import { getFinalEditWorkspace } from '@/lib/final-edit/runtime';
import { finalEditErrorResponse } from '@/lib/final-edit/http';
import type { FinalEditCommand } from '@/lib/final-edit/workspace';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';


async function __teamRouteGET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try { return NextResponse.json(getFinalEditWorkspace().load((await params).id)); }
  catch (error) { return finalEditErrorResponse(error); }
}
async function __teamRoutePATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await request.json() as Omit<Extract<FinalEditCommand, { scope: 'group' }>, 'scope' | 'groupId'>;
    if (body.type === 'set_packaging_config' && 'config' in body && body.config && typeof body.config === 'object') {
      // 解析缓存只能由专用布局命令在服务端写入，公开 PATCH 不接受派生更新开关。
      const config = body.config as Record<string, unknown>;
      delete config.layoutResolution;
      delete config.layoutResolutionOnly;
      delete config.expectedPackagingJson;
    }
    return NextResponse.json(getFinalEditWorkspace().apply({ ...body, scope: 'group', groupId: id } as Extract<FinalEditCommand, { scope: 'group' }>));
  } catch (error) { return finalEditErrorResponse(error); }
}
export const GET = withTeamRoute('/api/final-edit-groups/[id]', 'GET', __teamRouteGET);
export const PATCH = withTeamRoute('/api/final-edit-groups/[id]', 'PATCH', __teamRoutePATCH);
