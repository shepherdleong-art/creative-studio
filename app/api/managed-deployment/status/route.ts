import { NextResponse } from 'next/server';
import { inspectManagedWorkbench } from '@/lib/managed-workbench';

export const runtime = 'nodejs';

/** Read-only managed deployment status; never starts a process. */
export async function GET() {
  try {
    const status = await inspectManagedWorkbench();
    return NextResponse.json(status, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch {
    return NextResponse.json({
      managed: true,
      phase: 'failed',
      configured: false,
      profileName: null,
      importedAt: null,
      configHashPrefix: null,
      proxyAvailable: false,
      reason: '公司配置状态暂时不可用，请重试',
    }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}
