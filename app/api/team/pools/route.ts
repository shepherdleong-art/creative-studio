import { getDb } from '@/lib/db';
import { requireAccessContext } from '@/lib/media-core/access-context';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';
import { teamServiceError } from '@/lib/team-service/http-error';
import {
  applyPoolChanges,
  previewPoolChanges,
  readPoolAdminState,
  TeamPoolError,
  updateUnifiedImageCongestion,
} from '@/lib/team-service/pools';
import { readRuntimeConfig } from '@/lib/team-service/config';
import type { PoolChange } from '@/lib/team-service/pools';

function viewer() {
  const access = requireAccessContext();
  return { userId: access.actor.userId, role: access.actor.role };
}

async function __teamRouteGET() {
  if (readRuntimeConfig().mode !== 'server') return Response.json({ error: 'not_found' }, { status: 404 });
  try {
    return Response.json(readPoolAdminState(getDb(), viewer()), {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) {
    return teamServiceError(error, '资源池状态读取失败。');
  }
}

async function __teamRoutePOST(request: Request) {
  if (readRuntimeConfig().mode !== 'server') return Response.json({ error: 'not_found' }, { status: 404 });
  try {
    const body = await request.json() as {
      changes?: unknown;
      preview?: unknown;
      unifiedImageCongestion?: {
        imageCongestionThresholdSec?: unknown;
        expectedVersion?: unknown;
      };
    };
    if (body.unifiedImageCongestion !== undefined) {
      if (!body.unifiedImageCongestion || typeof body.unifiedImageCongestion !== 'object') {
        throw new TeamPoolError(400, 'invalid_congestion_threshold', '请提供统一图片拥堵阈值。');
      }
      if (body.changes !== undefined) {
        throw new TeamPoolError(
          400,
          'mixed_pool_changes',
          '阈值设置与名额池变更不能在同一请求中混用。',
        );
      }
      const settings = updateUnifiedImageCongestion(getDb(), viewer(), {
        imageCongestionThresholdSec: body.unifiedImageCongestion.imageCongestionThresholdSec,
        expectedVersion: body.unifiedImageCongestion.expectedVersion,
      });
      return Response.json({ unifiedImageCongestion: settings }, {
        headers: { 'Cache-Control': 'private, no-store' },
      });
    }
    if (!Array.isArray(body.changes)) {
      throw new TeamPoolError(400, 'pool_changes_required', '请求必须提供 changes 数组。');
    }
    const db = getDb();
    if (body.preview === true) {
      return Response.json({ preview: previewPoolChanges(db, viewer(), body.changes as PoolChange[]) }, {
        headers: { 'Cache-Control': 'private, no-store' },
      });
    }
    return Response.json(applyPoolChanges(db, viewer(), body.changes as PoolChange[]), {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) {
    return teamServiceError(error, '资源池配置保存失败。');
  }
}

export const GET = withTeamRoute('/api/team/pools', 'GET', __teamRouteGET);
export const POST = withTeamRoute('/api/team/pools', 'POST', __teamRoutePOST);
