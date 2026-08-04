import { NextResponse } from 'next/server';
import { inspectCompanyProviderRuntime } from '@/lib/company-provider-runtime';
import { dataRoot } from '@/lib/data-root';

const FALLBACK_STATUS = {
  status: 'unavailable' as const,
  reason: '公司供应商状态暂时不可用',
  proxyAvailable: false,
  tunnelAvailable: false,
  startedAt: null,
  tunnelEngine: null,
};

/** Read-only local runtime status; it never starts a process or calls a model. */
export async function GET() {
  try {
    const status = await inspectCompanyProviderRuntime({ root: dataRoot() });
    return NextResponse.json(status, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    // Do not surface filesystem or parser diagnostics that could contain paths.
    return NextResponse.json(FALLBACK_STATUS, { headers: { 'Cache-Control': 'no-store' } });
  }
}
