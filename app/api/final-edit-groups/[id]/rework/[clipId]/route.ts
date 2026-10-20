import path from 'node:path';
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { dataRoot } from '@/lib/data-root';
import { checkLocalRequest, filmWriteActor } from '@/lib/final-edit/reassembled/access';
import { applyFilmRework, readFilmRework } from '@/lib/final-edit/reassembled/rework';
import { finalEditErrorResponse } from '@/lib/final-edit/http';
import { getQueueStatus, runQueue } from '@/lib/queue';
import { getVideoQueueStatus, runVideoQueue } from '@/lib/video-queue';
import { FinalEditError } from '@/lib/final-edit/errors';

type Params = { params: Promise<{ id: string; clipId: string }> };
export async function GET(request: Request, { params }: Params) {
  try {
    checkLocalRequest(request);
    const { id, clipId } = await params;
    return NextResponse.json(readFilmRework(getDb(), id, clipId));
  } catch (error) { return finalEditErrorResponse(error); }
}
export async function POST(request: Request, { params }: Params) {
  try {
    const actor = filmWriteActor(request);
    const { id, clipId } = await params;
    const body = await request.json();
    const db = getDb();
    const view = readFilmRework(db, id, clipId);
    if ((body.type === 'generate_image' && getQueueStatus(view.projectId) !== 'idle') || (body.type === 'generate_video' && getVideoQueueStatus(view.projectId) !== 'idle')) {
      throw new FinalEditError('film_queue_busy', '当前队列忙，请等待完成后重试；本次未新建任务', 409);
    }
    const result = await applyFilmRework(db, path.join(dataRoot(), 'storage'), id, clipId, body, actor);
    // A scoped queue cannot claim or recover another shot's pending work.
    if (result.jobId && body.type === 'generate_image' && getQueueStatus(view.projectId) === 'idle') {
      void runQueue({ projectId: view.projectId, jobId: result.jobId, concurrency: 1, maxAttempts: 1, timeoutMs: 600000 }).catch(() => {});
    }
    if (result.jobId && body.type === 'generate_video' && getVideoQueueStatus(view.projectId) === 'idle') {
      void runVideoQueue({ projectId: view.projectId, jobId: result.jobId, concurrency: 1, timeoutMs: 600000 }).catch(() => {});
    }
    return NextResponse.json(result);
  } catch (error) { return finalEditErrorResponse(error); }
}
