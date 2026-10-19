import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { wakeFinalEditWorker } from '@/lib/final-edit/worker';
import { getFinalEditWorkspace } from '@/lib/final-edit/runtime';

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const job = getDb().prepare(`SELECT kind FROM final_edit_jobs WHERE id=? AND status='failed'`).get(id) as { kind: string } | undefined;
  if (!job) return NextResponse.json({ error: 'job_not_retryable' }, { status: 409 });
  const result = getDb().prepare(`UPDATE final_edit_jobs SET status='queued', phase='queued', progress=0, errorCode=NULL, errorMessage=NULL, attempt=attempt+1, startedAt=NULL, finishedAt=NULL WHERE id=? AND status='failed'`).run(id);
  if (!result.changes) return NextResponse.json({ error: 'job_not_retryable' }, { status: 409 });
  if (job.kind === 'prepare') void getFinalEditWorkspace().resumePrepareJob(id);
  else wakeFinalEditWorker();
  return NextResponse.json({ id, status: 'queued' }, { status: 202 });
}
