import { NextResponse } from 'next/server.js';
import {
  assertManagedWorkbenchReady,
  inspectManagedWorkbench,
  type InspectManagedWorkbenchOptions,
} from '../../../lib/managed-workbench.ts';

export const MANAGED_WORKBENCH_LOCKED_BODY = {
  error: '请先导入公司配置并等待 LiteLLM 就绪',
  code: 'managed_workbench_locked',
} as const;

/**
 * Shared server-side guard. A null result means the route may continue; a
 * response is the exact safe 423 payload to return from the route.
 */
export async function guardManagedWorkbench(
  options: InspectManagedWorkbenchOptions = {},
): Promise<NextResponse | null> {
  try {
    const status = await inspectManagedWorkbench(options);
    if (status.phase === 'unrestricted' || status.phase === 'ready') return null;
    return NextResponse.json({
      ...MANAGED_WORKBENCH_LOCKED_BODY,
      phase: status.phase,
    }, { status: 423, headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({
      ...MANAGED_WORKBENCH_LOCKED_BODY,
      phase: 'failed',
    }, { status: 423, headers: { 'Cache-Control': 'no-store' } });
  }
}

/** Alias for route code that prefers an imperative “require” name. */
export const requireManagedWorkbenchReady = guardManagedWorkbench;
export const managedWorkbenchGuard = guardManagedWorkbench;
export const assertManagedWorkbenchApiReady = guardManagedWorkbench;

/** Throwing helper for non-HTTP service code. */
export { assertManagedWorkbenchReady };
