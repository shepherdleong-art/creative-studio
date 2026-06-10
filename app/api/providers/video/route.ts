import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export async function GET() {
  try {
    const db = getDb();
    const providers = db.prepare(`
      SELECT id, name, type, defaultModel, defaultDurationSec, enabled
      FROM video_providers
      WHERE enabled = 1
    `).all();
    return NextResponse.json(providers);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
