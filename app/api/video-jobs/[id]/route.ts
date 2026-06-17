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

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({})) as { action?: string };
    if (body.action !== 'cancel') {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }

    const db = getDb();
    const result = db.prepare(`
      UPDATE video_jobs
      SET status = 'canceled',
          errorMessage = 'Canceled by user',
          finishedAt = datetime('now')
      WHERE id = ?
        AND status IN ('pending', 'running', 'needs_check')
    `).run(id);

    if (result.changes !== 1) {
      const job = db.prepare(`SELECT id FROM video_jobs WHERE id = ?`).get(id);
      if (!job) return NextResponse.json({ error: 'Video job not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
