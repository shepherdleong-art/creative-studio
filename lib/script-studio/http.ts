import type { NextResponse } from 'next/server';
import { ScriptStudioApiUnavailableError } from './errors.ts';
import {
  getScriptStudioReadiness,
  scriptStudioReadinessUnavailable,
} from './runtime-readiness.ts';

export async function assertScriptStudioApiReady(): Promise<void> {
  const readiness = await getScriptStudioReadiness();
  const unavailable = scriptStudioReadinessUnavailable(readiness);
  if (unavailable) {
    throw new ScriptStudioApiUnavailableError(unavailable.code, unavailable.message);
  }
}

export function unavailableResponse(error: unknown): { status: number; body: Record<string, unknown> } {
  if (error instanceof ScriptStudioApiUnavailableError) {
    return { status: 503, body: { error: error.code, message: error.message } };
  }
  return { status: 500, body: { error: error instanceof Error ? error.message : String(error) } };
}

export function errorResponse(error: unknown): { status: number; body: Record<string, unknown> } {
  if (error instanceof ScriptStudioApiUnavailableError) {
    return { status: 503, body: { error: error.code, message: error.message } };
  }
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as { code: unknown }).code)
    : 'script_studio_error';
  const message = error instanceof Error ? error.message : String(error);
  const status = code === 'not_found' ? 404
    : code === 'invalid_input' || code === 'resource_limit' ? 400
      : code === 'conflict' ? 409
        : code === 'provider_unavailable' || code === 'unavailable' ? 503
          : 500;
  return { status, body: { error: code, message } };
}

export async function jsonOrNull(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value = await request.json();
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}
