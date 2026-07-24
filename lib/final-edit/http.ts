import { NextResponse } from 'next/server';
import { FinalEditError } from './errors';

export function finalEditErrorResponse(error: unknown): NextResponse {
  if (error instanceof FinalEditError) {
    return NextResponse.json({ error: error.code, message: error.message, details: error.details }, { status: error.status });
  }
  const message = error instanceof Error ? error.message : String(error);
  return NextResponse.json({ error: 'internal_error', message }, { status: 500 });
}
