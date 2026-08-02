import { NextRequest, NextResponse } from 'next/server';
import { BatchDomainError } from '@/lib/batch-production/errors';
import { BatchApiUnavailableError } from '@/lib/batch-production/runtime-readiness';

export const BATCH_NO_STORE_HEADERS = { 'Cache-Control': 'no-store' };

export function batchProjectIdFromRequest(request: NextRequest): string | null {
  const projectId = request.nextUrl.searchParams.get('projectId');
  return projectId && projectId.length > 0 ? projectId : null;
}

const DOMAIN_STATUS = {
  not_found: 404,
  invalid_input: 400,
  conflict: 409,
} as const;

export function batchRouteErrorResponse(
  error: unknown,
  fallbackError: string,
  fallbackMessage: string,
): NextResponse {
  if (error instanceof BatchApiUnavailableError) {
    return NextResponse.json({
      error: 'batch_api_unavailable',
      code: error.code,
      message: error.message,
    }, { status: 503, headers: BATCH_NO_STORE_HEADERS });
  }
  if (error instanceof BatchDomainError) {
    return NextResponse.json({
      error: fallbackError,
      code: error.code,
      message: error.message,
    }, { status: DOMAIN_STATUS[error.code], headers: BATCH_NO_STORE_HEADERS });
  }
  return NextResponse.json({
    error: fallbackError,
    message: error instanceof Error ? error.message : fallbackMessage,
  }, { status: 500, headers: BATCH_NO_STORE_HEADERS });
}
