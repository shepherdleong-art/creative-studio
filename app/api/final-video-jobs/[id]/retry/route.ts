import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { startFinalVideoQueue } from '@/lib/final-video/render-queue';
import { parseFinalVideoJobRowSnapshot } from '@/lib/final-video/types';
import type { FinalVideoJobRow } from '@/lib/final-video/types';

export const runtime = 'nodejs';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = getDb();
  const row = db.prepare(`SELECT * FROM final_video_jobs WHERE id = ?`).get(id) as FinalVideoJobRow | undefined;
  if (!row) return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  if (row.status !== 'failed' && row.status !== 'canceled') {
    return NextResponse.json({ error: `当前状态 ${row.status} 不能重试` }, { status: 409 });
  }
  if (row.solverVersion !== 3) {
    return NextResponse.json({ error: '旧版成片任务不能重试，请新建成片草稿' }, { status: 409 });
  }
  try {
    parseFinalVideoJobRowSnapshot(row);
  } catch (error) {
    return NextResponse.json({ error: `任务快照无效，不能重试: ${error instanceof Error ? error.message : String(error)}` }, { status: 409 });
  }
  db.prepare(
    `UPDATE final_video_jobs SET status = 'pending', currentStep = 'queued', progress = 0, errorMessage = NULL WHERE id = ?`
  ).run(id);
  startFinalVideoQueue();
  return NextResponse.json({ success: true });
}
