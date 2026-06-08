import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const db = getDb();

    const job = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as {
      id: string;
      projectId: string;
      status: string;
    } | undefined;

    if (!job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }

    if (!['failed', 'canceled'].includes(job.status)) {
      return NextResponse.json({ error: 'Only failed or canceled jobs can be retried' }, { status: 400 });
    }

    db.prepare(`
      UPDATE jobs SET status = 'pending', attempt = 0, errorMessage = NULL,
        startedAt = NULL, finishedAt = NULL, latencyMs = NULL, estimatedCost = NULL
      WHERE id = ?
    `).run(id);

    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
