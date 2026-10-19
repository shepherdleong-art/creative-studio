import { NextRequest, NextResponse } from 'next/server';
import { batchErrorResponse } from '@/lib/batch-production/http-errors';

export const BATCH_NO_STORE_HEADERS = { 'Cache-Control': 'no-store' };

export function batchProjectIdFromRequest(request: NextRequest): string | null {
  const projectId = request.nextUrl.searchParams.get('projectId');
  return projectId && projectId.length > 0 ? projectId : null;
}

export function batchRouteErrorResponse(
  error: unknown,
  fallbackError: string,
  fallbackMessage: string,
): NextResponse {
  const mapped = batchErrorResponse(error, { error: fallbackError, message: fallbackMessage });
  return NextResponse.json(mapped.body, { status: mapped.status, headers: BATCH_NO_STORE_HEADERS });
}
