import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' };

function authorized(request: NextRequest): boolean {
  if (process.env.CREATIVE_STUDIO_DESKTOP !== '1') return false;
  const provided = request.headers.get('x-creative-studio-desktop-secret');
  const expected = process.env.CREATIVE_STUDIO_DESKTOP_SECRET;
  if (!provided || !expected) return false;
  const providedBytes = Buffer.from(provided, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  return providedBytes.length === expectedBytes.length
    && timingSafeEqual(providedBytes, expectedBytes);
}

export function GET(request: NextRequest): NextResponse {
  if (!authorized(request)) {
    return NextResponse.json(
      { error: 'desktop_activity_denied' },
      { status: 403, headers: NO_STORE_HEADERS },
    );
  }

  try {
    const db = getDb();
    const active = [
      db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE status IN ('queued', 'running')").get() as { count: number },
      db.prepare("SELECT COUNT(*) AS count FROM video_jobs WHERE status IN ('queued', 'running', 'polling')").get() as { count: number },
      db.prepare("SELECT COUNT(*) AS count FROM batch_tasks WHERE status IN ('queued', 'running') AND expectedState = 'running'").get() as { count: number },
      db.prepare("SELECT COUNT(*) AS count FROM final_edit_jobs WHERE status IN ('queued', 'running')").get() as { count: number },
    ].some(({ count }) => count > 0);
    return NextResponse.json({ active }, { headers: NO_STORE_HEADERS });
  } catch {
    // A status read failure must not silently claim that it is safe to exit.
    return NextResponse.json({ active: true, uncertain: true }, { headers: NO_STORE_HEADERS });
  }
}
