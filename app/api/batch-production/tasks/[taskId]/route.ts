import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { assertBatchApiReady } from '@/lib/batch-production/runtime-readiness';
import { getBatchTask, listTaskAttempts } from '@/lib/batch-production/tasks';
import { BatchDomainError } from '@/lib/batch-production/errors';
import {
  BATCH_NO_STORE_HEADERS,
  batchProjectIdFromRequest,
  batchRouteErrorResponse,
} from '../../batches/response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 单任务视图(只读)。素材级代理请求(无批次,共识 2)对应的 proxy_generate
 * 任务不在任何批次的 /tasks 列表里,前端引导按钮轮询任务状态走这里;
 * 返回形状与 GET /batches/[id]/tasks 的 tasks[] 一致。
 */
export async function GET(request: NextRequest, context: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await context.params;
  const projectId = batchProjectIdFromRequest(request);
  if (!projectId) {
    return NextResponse.json({
      error: 'missing_project_id',
      message: '缺少 projectId 参数',
    }, { status: 400, headers: BATCH_NO_STORE_HEADERS });
  }
  try {
    await assertBatchApiReady();
    const db = getDb();
    const task = getBatchTask(db, projectId, taskId);
    if (!task) {
      throw new BatchDomainError('not_found', '任务不存在');
    }
    const attempts = listTaskAttempts(db, taskId).map((attempt) => ({
      id: attempt.id,
      attemptNumber: attempt.attemptNumber,
      status: attempt.status,
      progressJson: JSON.parse(attempt.progressJson),
      resultJson: attempt.resultJson ? JSON.parse(attempt.resultJson) : null,
      errorCode: attempt.errorCode,
      errorMessage: attempt.errorMessage,
      startedAt: attempt.startedAt,
      finishedAt: attempt.finishedAt,
      createdAt: attempt.createdAt,
    }));
    return NextResponse.json({ ...task, attempts }, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) {
    return batchRouteErrorResponse(error, 'task_read_failed', '任务读取失败');
  }
}
