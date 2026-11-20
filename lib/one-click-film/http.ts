import { NextResponse } from 'next/server';
import { OneClickFilmError, OneClickFilmUnavailableError } from './errors.ts';
import { getOneClickFilmReadiness, oneClickFilmReadinessUnavailable } from './runtime-readiness.ts';

/** 一键成片 API 的 readiness 闸门：迁移未通过时整体不可用，不写半套数据。 */
export async function assertOneClickFilmApiReady(): Promise<void> {
  const readiness = await getOneClickFilmReadiness();
  const unavailable = oneClickFilmReadinessUnavailable(readiness);
  if (unavailable) throw new OneClickFilmUnavailableError(unavailable.code, unavailable.message);
}

export function oneClickFilmErrorResponse(error: unknown): { status: number; body: Record<string, unknown> } {
  if (error instanceof OneClickFilmError) {
    return { status: error.status, body: { error: error.code, message: error.message } };
  }
  return {
    status: 500,
    body: { error: 'one_click_film_error', message: error instanceof Error ? error.message : String(error) },
  };
}

export function jsonError(error: unknown): NextResponse {
  const { status, body } = oneClickFilmErrorResponse(error);
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const value = await request.json();
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
