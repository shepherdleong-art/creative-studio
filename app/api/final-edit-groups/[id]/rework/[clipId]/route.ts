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
import { withTeamRoute } from '@/lib/team-service/route-wrapper';
import { readRuntimeConfig } from '@/lib/team-service/config';
import { requireAccessContext } from '@/lib/media-core/access-context';


type Params = { params: Promise<{ id: string; clipId: string }> };
function serverMode(): boolean {
  return readRuntimeConfig().mode === 'server';
}
function readRouteAccess(request: Request): void {
  if (!serverMode()) {
    checkLocalRequest(request);
    return;
  }
  if (requireAccessContext().kind !== 'team') {
    throw new FinalEditError('film_actor_required', '团队返工缺少已验证的成员身份', 403);
  }
}
function writeRouteActor(request: Request): 'human' | 'agent' {
  if (!serverMode()) return filmWriteActor(request);
  if (requireAccessContext().kind !== 'team') {
    throw new FinalEditError('film_actor_required', '团队返工缺少已验证的成员身份', 403);
  }
  // Server-backed team writes are explicit human workbench actions. The
  // desktop Agent token remains local-only and cannot be replayed here.
  return 'human';
}
async function __teamRouteGET(request: Request, { params }: Params) {
  try {
    readRouteAccess(request);
    const { id, clipId } = await params;
    return NextResponse.json(readFilmRework(getDb(), id, clipId));
  } catch (error) { return finalEditErrorResponse(error); }
}
async function __teamRoutePOST(request: Request, { params }: Params) {
  try {
    const actor = writeRouteActor(request);
    const { id, clipId } = await params;
    const body = await request.json();
    const db = getDb();
    const view = readFilmRework(db, id, clipId);
    if (!serverMode() && ((body.type === 'generate_image' && getQueueStatus(view.projectId) !== 'idle')
      || (body.type === 'generate_video' && getVideoQueueStatus(view.projectId) !== 'idle'))) {
      throw new FinalEditError('film_queue_busy', '当前队列忙，请等待完成后重试；本次未新建任务', 409);
    }
    const result = await applyFilmRework(
      db,
      path.join(dataRoot(), 'storage'),
      id,
      clipId,
      body,
      actor,
      { mode: serverMode() ? 'server' : 'local' },
    );
    // Local mode keeps the legacy scoped queue. Team mode uses one project queue
    // so multiple unified rework jobs can progress without a second worker.
    if (result.jobId && body.type === 'generate_image' && getQueueStatus(view.projectId) === 'idle') {
      void runQueue({
        projectId: view.projectId,
        ...(serverMode() ? {} : { jobId: result.jobId }),
        concurrency: 1,
        maxAttempts: 1,
        timeoutMs: 600000,
      }).catch(() => {});
    }
    if (result.jobId && body.type === 'generate_video' && getVideoQueueStatus(view.projectId) === 'idle') {
      void runVideoQueue({
        projectId: view.projectId,
        ...(serverMode() ? {} : { jobId: result.jobId }),
        concurrency: 1,
        timeoutMs: 600000,
      }).catch(() => {});
    }
    return NextResponse.json(result);
  } catch (error) { return finalEditErrorResponse(error); }
}
export const GET = withTeamRoute('/api/final-edit-groups/[id]/rework/[clipId]', 'GET', __teamRouteGET);
export const POST = withTeamRoute('/api/final-edit-groups/[id]/rework/[clipId]', 'POST', __teamRoutePOST);
