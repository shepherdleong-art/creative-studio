import { NextResponse } from 'next/server';
import { getBatchProductionReadiness } from '@/lib/batch-production/runtime-readiness';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';


export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' };

async function __teamRouteGET() {
  try {
    const readiness = await getBatchProductionReadiness();
    return NextResponse.json({
      ...readiness,
      recovery: {
        endpoint: '/api/batch-production/recovery',
        requiresApplicationShutdown: true,
      },
    }, { headers: NO_STORE_HEADERS });
  } catch {
    return NextResponse.json({
      available: false,
      mode: 'compatibility_only',
      code: 'readiness_check_failed',
      message: '无法完成批量功能自检，旧功能仍可继续使用。',
    }, { status: 503, headers: NO_STORE_HEADERS });
  }
}
export const GET = withTeamRoute('/api/batch-production/readiness', 'GET', __teamRouteGET);
