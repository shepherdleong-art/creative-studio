import { getDb } from '@/lib/db';
import { requireAccessContext } from '@/lib/media-core/access-context';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';
import { readRuntimeConfig } from '@/lib/team-service/config';
import { teamServiceError } from '@/lib/team-service/http-error';
import { inspectCompanyProviderRuntime } from '@/lib/company-provider-runtime';
import { dataRoot } from '@/lib/data-root';
import { readConsoleOverview } from '@/lib/team-service/console-overview';
import { readProductionDefaults } from '@/lib/team-service/console-defaults';

/**
 * 控制台运行总览（12 号票）：一次读取数量卡、最近任务、今天的成员、名额占用、
 * 开工前清单和只读服务器默认值。
 *
 * 只对管理员开放（策略表里归 admin）。就绪数据沿用现有检查：
 * `/api/company-provider/health` 的同一函数 `inspectCompanyProviderRuntime`，
 * 名额沿用 `readPoolAdminState`，不另开口径。
 */

async function runtimeHealth(): Promise<{ proxyAvailable: boolean | null; cosConfigured: boolean | null }> {
  try {
    const status = await inspectCompanyProviderRuntime({ root: dataRoot() });
    return { proxyAvailable: status.proxyAvailable === true, cosConfigured: status.cosConfigured === true };
  } catch {
    // 读不到就如实说「没读到状态」，不要当成已就绪。
    return { proxyAvailable: null, cosConfigured: null };
  }
}

async function __teamRouteGET(): Promise<Response> {
  if (readRuntimeConfig().mode !== 'server') return Response.json({ error: 'not_found' }, { status: 404 });
  try {
    const access = requireAccessContext();
    const viewer = { userId: access.actor.userId, role: access.actor.role };
    const runtime = await runtimeHealth();
    return Response.json(readConsoleOverview(getDb(), viewer, {
      runtime,
      productionDefaults: readProductionDefaults(),
    }), { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return teamServiceError(error, '运行总览读取失败。');
  }
}

export const GET = withTeamRoute('/api/team/console/overview', 'GET', __teamRouteGET);
