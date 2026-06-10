import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export async function GET() {
  try {
    const db = getDb();
    const templates = db.prepare(`SELECT * FROM video_prompt_templates ORDER BY createdAt`).all();
    return NextResponse.json(templates);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
