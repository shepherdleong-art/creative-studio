import { NextResponse } from 'next/server';
import { getBatchProductionReadiness } from '@/lib/batch-production/runtime-readiness';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' };

export async function GET() {
  try {
    const readiness = await getBatchProductionReadiness();
    return NextResponse.json(readiness, { headers: NO_STORE_HEADERS });
  } catch {
    return NextResponse.json({
      available: false,
      mode: 'compatibility_only',
      code: 'readiness_check_failed',
      message: '无法完成批量功能自检，旧功能仍可继续使用。',
    }, { status: 503, headers: NO_STORE_HEADERS });
  }
}
