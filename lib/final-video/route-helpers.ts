// lib/final-video/route-helpers.ts
// Shared response shaping for the final-video-drafts API routes.
import { NextResponse } from 'next/server';

export const jsonError = (error: string, status: number) => NextResponse.json({ error }, { status });

export const stale = () => NextResponse.json(
  { error: 'stale_revision', message: '草稿已在别处更新，请刷新后重试' }, { status: 409 },
);

export function errorCode(error: unknown): string | undefined {
  return error instanceof Error ? (error as Error & { code?: string }).code : undefined;
}
