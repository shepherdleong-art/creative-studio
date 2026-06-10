import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const db = getDb();
    const job = db.prepare(`SELECT * FROM video_jobs WHERE id = ?`).get(id) as {
      id: string; status: string; projectId: string;
    } | undefined;
    if (!job) return NextResponse.json({ error: 'Video job not found' }, { status: 404 });

    if (!['failed', 'canceled'].includes(job.status)) {
      return NextResponse.json({ error: 'Only failed or canceled video jobs can be retried' }, { status: 400 });
    }

    db.prepare(`UPDATE video_jobs SET status = 'pending', errorMessage = NULL WHERE id = ?`).run(id);
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
