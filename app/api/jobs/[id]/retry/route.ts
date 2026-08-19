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
      providerTaskId?: string | null;
    } | undefined;

    if (!job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }

    if (!['failed', 'canceled'].includes(job.status)) {
      return NextResponse.json({ error: 'Only failed or canceled jobs can be retried' }, { status: 400 });
    }

    const existingTaskId = typeof job.providerTaskId === 'string' ? job.providerTaskId.trim() : '';
    if (existingTaskId) {
      // The remote task may already be billable. Preserve its identity and
      // route the user to polling instead of creating a second task.
      const message = `已有远端图片任务 ${existingTaskId}，请点“补抓结果”继续查询。`;
      db.prepare(`
        UPDATE jobs SET status = 'needs_check', providerStatus = 'needs_check', errorMessage = ?,
          startedAt = NULL, finishedAt = NULL
        WHERE id = ?
      `).run(message, id);

      return NextResponse.json({ success: true, status: 'needs_check', resumeRequired: true });
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
