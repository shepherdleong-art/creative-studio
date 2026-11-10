import { getDb } from '@/lib/db';
import { requireAccessContext } from '@/lib/media-core/access-context';
import { readRuntimeConfig } from '@/lib/team-service/config';
import {
  clearTeamChannelHealth,
  readTeamChannelHealth,
} from '@/lib/team-service/channel-health';
import { teamServiceError } from '@/lib/team-service/http-error';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';

function viewer() {
  const access = requireAccessContext();
  return { userId: access.actor.userId, role: access.actor.role };
}

async function __teamRouteGET() {
  if (readRuntimeConfig().mode !== 'server') {
    return Response.json({ error: 'not_found' }, { status: 404 });
  }
  try {
    return Response.json(readTeamChannelHealth(getDb(), viewer()), {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) {
    return teamServiceError(error, '通道健康状态读取失败。');
  }
}

async function __teamRoutePOST(request: Request) {
  if (readRuntimeConfig().mode !== 'server') {
    return Response.json({ error: 'not_found' }, { status: 404 });
  }
  try {
    const body = await request.json() as {
      action?: unknown;
      healthKey?: unknown;
      expectedVersion?: unknown;
    };
    if (body.action !== 'clear') {
      return Response.json({ error: 'unsupported_channel_health_action' }, { status: 400 });
    }
    return Response.json({
      item: clearTeamChannelHealth(getDb(), viewer(), {
        healthKey: String(body.healthKey ?? ''),
        expectedVersion: Number(body.expectedVersion),
      }),
    }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return teamServiceError(error, '通道健康状态保存失败。');
  }
}

export const GET = withTeamRoute('/api/team/channel-health', 'GET', __teamRouteGET);
export const POST = withTeamRoute('/api/team/channel-health', 'POST', __teamRoutePOST);
