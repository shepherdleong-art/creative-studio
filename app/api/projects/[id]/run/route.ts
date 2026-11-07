import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { runQueue, cancelQueue, pauseQueue, resumeQueue, getQueueStatus } from '@/lib/queue';
import { cancelVideoQueue } from '@/lib/video-queue';
import { writeLog } from '@/lib/logger';
import { getEffectiveImageConcurrency } from '@/lib/provider-concurrency';
import { v4 as uuidv4 } from 'uuid';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';
import { readRuntimeConfig } from '@/lib/team-service/config';
import { productionParamsFor } from '@/lib/team-service/production-defaults';


async function __teamRoutePOST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const db = getDb();

    const project = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as {
      id: string;
      concurrency: number;
      maxAttempts: number;
      timeoutMs: number;
      status: string;
      providerId: string;
    } | undefined;

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    const body = await request.json().catch(() => ({}));
    const action = body.action || 'start';

    switch (action) {
      case 'start': {
        // Prevent duplicate start
        const currentStatus = getQueueStatus(id);
        if (currentStatus !== 'idle') {
          return NextResponse.json(
            { error: `队列已在运行中 (状态: ${currentStatus})` },
            { status: 409 }
          );
        }

        // ── 生产参数：server 模式一律取服务器默认值（含「已有项目新提交的任务」）；
        //    本地版沿用「请求值 > 项目已存值 > 内置默认值」的原有顺序。 ──
        const production = productionParamsFor(readRuntimeConfig(), {
          timeoutMs: body.timeoutMs ?? project.timeoutMs,
          concurrency: body.concurrency ?? project.concurrency,
        });
        const requestedConcurrency = production.projectConcurrency;
        const provider = db.prepare(`SELECT id, name, type, baseUrl FROM providers WHERE id = ?`).get(project.providerId) as {
          id?: string;
          name?: string;
          type?: string;
          baseUrl?: string;
        } | undefined;
        // 名额池 / 成员并发上限 / 公平共享保持不变，只是输入换成裁决后的值。
        const concurrency = getEffectiveImageConcurrency(provider || {}, requestedConcurrency);
        const maxAttempts = body.maxAttempts || project.maxAttempts || 2;
        const timeoutMs = production.timeoutMs;

        // Generate runId for this run
        const runId = uuidv4().slice(0, 8);

        writeLog({
          jobId: '',
          projectId: id,
          level: 'info',
          message: `队列启动 runId=${runId} (concurrency=${concurrency}, requested=${requestedConcurrency}, maxAttempts=${maxAttempts}, timeout=${timeoutMs}ms)`,
        });

        // Save runId to project
        db.prepare(`UPDATE projects SET runId = ? WHERE id = ?`).run(runId, id);

        // Fire and forget: don't await so API returns immediately
        runQueue({ projectId: id, concurrency, maxAttempts, timeoutMs }).catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[Queue] Fatal queue error for project ${id}: ${msg}`);
          writeLog({
            jobId: '',
            projectId: id,
            level: 'error',
            message: `队列致命错误: ${msg}`,
          });
        });

        return NextResponse.json({ status: 'started' });
      }
      case 'pause': {
        pauseQueue(id);
        db.prepare(`UPDATE projects SET status = 'draft' WHERE id = ?`).run(id);
        writeLog({ jobId: '', projectId: id, level: 'info', message: '队列已暂停' });
        return NextResponse.json({ status: 'paused' });
      }
      case 'resume': {
        const currentStatus = getQueueStatus(id);
        if (currentStatus !== 'paused') {
          return NextResponse.json(
            { error: `队列未处于暂停状态 (当前: ${currentStatus})` },
            { status: 409 }
          );
        }

        // 与 start 同一套裁决：server 模式丢弃请求里的并发 / 超时。
        const production = productionParamsFor(readRuntimeConfig(), {
          timeoutMs: body.timeoutMs ?? project.timeoutMs,
          concurrency: body.concurrency ?? project.concurrency,
        });
        const requestedConcurrency = production.projectConcurrency;
        const provider = db.prepare(`SELECT id, name, type, baseUrl FROM providers WHERE id = ?`).get(project.providerId) as {
          id?: string;
          name?: string;
          type?: string;
          baseUrl?: string;
        } | undefined;
        const concurrency = getEffectiveImageConcurrency(provider || {}, requestedConcurrency);
        const maxAttempts = body.maxAttempts || project.maxAttempts || 2;
        const timeoutMs = production.timeoutMs;

        resumeQueue(id, { projectId: id, concurrency, maxAttempts, timeoutMs });
        writeLog({ jobId: '', projectId: id, level: 'info', message: `队列已恢复 (concurrency=${concurrency}, requested=${requestedConcurrency})` });

        return NextResponse.json({ status: 'resumed' });
      }
      case 'cancel': {
        cancelQueue(id);
        cancelVideoQueue(id);
        writeLog({ jobId: '', projectId: id, level: 'warn', message: '队列已取消' });
        return NextResponse.json({ status: 'canceled' });
      }
      default:
        return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

async function __teamRouteGET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const status = getQueueStatus(id);
  return NextResponse.json({ queueStatus: status });
}
export const POST = withTeamRoute('/api/projects/[id]/run', 'POST', __teamRoutePOST);
export const GET = withTeamRoute('/api/projects/[id]/run', 'GET', __teamRouteGET);
