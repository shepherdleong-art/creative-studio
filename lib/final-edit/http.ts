import { NextResponse } from 'next/server';
import { FinalEditError } from './errors';
import { PackagingError } from '../media-core/packaging-runtime';

export function finalEditErrorResponse(error: unknown): NextResponse {
  if (error instanceof PackagingError) return NextResponse.json({ error: error.code, message: error.message }, { status: error.status });
  if (error instanceof FinalEditError) {
    return NextResponse.json({ error: error.code, message: error.message, details: error.details }, { status: error.status });
  }
  const message = error instanceof Error ? error.message : String(error);
  return NextResponse.json({ error: 'internal_error', message }, { status: 500 });
}
