import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const db = getDb();
    const job = db.prepare(`
      SELECT vj.*, vp.name as providerName, vpt.name as templateName
      FROM video_jobs vj
      LEFT JOIN video_providers vp ON vp.id = vj.providerId
      LEFT JOIN video_prompt_templates vpt ON vpt.id = vj.templateId
      WHERE vj.id = ?
    `).get(id);
    if (!job) return NextResponse.json({ error: 'Video job not found' }, { status: 404 });
    return NextResponse.json(job);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
