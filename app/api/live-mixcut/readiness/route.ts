import { NextResponse } from 'next/server';
import { getBatchProductionReadiness } from '@/lib/live-mixcut/runtime-readiness';
import { getFormulaCapability } from '@/lib/live-mixcut/formula/runtime-readiness';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' };

export async function GET() {
  try {
    const readiness = await getBatchProductionReadiness();
    return NextResponse.json({
      ...readiness,
      formula: readiness.available ? await getFormulaCapability()
        : { available: false, message: readiness.message },
      recovery: {
        endpoint: '/api/live-mixcut/recovery',
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
