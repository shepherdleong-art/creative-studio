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
    const db = getDb();
    const body = await request.json().catch(() => ({})) as {
      action?: string;
      reason?: unknown;
      rejectReason?: unknown;
    };
    if (body.action === 'reject' || body.action === 'unreject') {
      const job = db.prepare(`SELECT status FROM video_jobs WHERE id = ?`).get(id) as { status: string } | undefined;
      if (!job) return NextResponse.json({ error: 'Video job not found' }, { status: 404 });
      if (job.status !== 'succeeded') {
        return NextResponse.json({ error: '只有已完成的视频才能剔除或恢复' }, { status: 409 });
      }
      if (body.action === 'reject') {
        const rawReason = typeof body.reason === 'string' ? body.reason : body.rejectReason;
        const reason = typeof rawReason === 'string' ? rawReason.trim().slice(0, 500) : '';
        db.prepare(`UPDATE video_jobs SET rejectedAt = datetime('now'), rejectReason = ? WHERE id = ?`).run(reason || null, id);
      } else {
        db.prepare(`UPDATE video_jobs SET rejectedAt = NULL, rejectReason = NULL WHERE id = ?`).run(id);
      }
      return NextResponse.json({ success: true });
    }
    if (body.action !== 'cancel') {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }

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
