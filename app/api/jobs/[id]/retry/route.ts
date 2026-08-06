import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { guardManagedWorkbench } from '@/app/api/managed-deployment/guard';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const managedGuard = await guardManagedWorkbench();
  if (managedGuard) return managedGuard;
  try {
    const { id } = await params;
    const db = getDb();

    const job = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as {
      id: string;
      projectId: string;
      status: string;
      providerTaskId: string | null;
      remoteImageUrl: string | null;
    } | undefined;

    if (!job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }

    if (!['failed', 'canceled'].includes(job.status)) {
      return NextResponse.json({ error: 'Only failed or canceled jobs can be retried' }, { status: 400 });
    }

    const hasRemoteIdentity = Boolean(job.providerTaskId?.trim() || job.remoteImageUrl?.trim());
    if (hasRemoteIdentity) {
      const resumeClaim = db.prepare(`
        UPDATE jobs SET status = 'needs_check', errorMessage = 'resume_required',
          startedAt = NULL, finishedAt = NULL, latencyMs = NULL, estimatedCost = NULL
        WHERE id = ? AND status IN ('failed', 'canceled')
      `).run(id);
      if (resumeClaim.changes !== 1) {
        return NextResponse.json({ error: 'retry_in_progress', message: '该任务状态已变化，请稍后重试' }, { status: 409 });
      }
      return NextResponse.json({ success: true, status: 'needs_check', resumeRequired: true });
    }

    db.prepare(`
      UPDATE jobs SET status = 'pending', attempt = 0, errorMessage = NULL,
        startedAt = NULL, finishedAt = NULL, latencyMs = NULL, estimatedCost = NULL
      WHERE id = ?
    `).run(id);

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: 'retry_failed', message: '重试失败' }, { status: 500 });
  }
}
