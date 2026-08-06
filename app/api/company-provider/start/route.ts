import { NextResponse } from 'next/server';
import { isManagedDeployment } from '@/lib/managed-deployment';
import { requestCompanySidecar } from '@/lib/company-sidecar-control';

export const runtime = 'nodejs';

/** Trigger the fixed managed sidecar start script; request input is ignored. */
export async function POST() {
  if (!isManagedDeployment()) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  // The controller coalesces concurrent starts. A spawn failure is represented
  // by the sidecar state machine; it must not expose command/path diagnostics.
  void requestCompanySidecar('start').catch(() => { /* status endpoint reports failed */ });
  return NextResponse.json({ message: '正在启动公司模型服务' }, { status: 202, headers: { 'Cache-Control': 'no-store' } });
}
