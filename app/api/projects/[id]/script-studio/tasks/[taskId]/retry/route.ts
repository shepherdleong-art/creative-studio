import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { ScriptStudioError } from '@/lib/script-studio/errors';
import { assertScriptStudioApiReady, errorResponse } from '@/lib/script-studio/http';
import { getTask, createTask } from '@/lib/script-studio/tasks';
import { toTaskSnapshot } from '@/lib/script-studio/snapshot';
import { createHash } from 'node:crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string; taskId: string }> },
) {
  try {
    await assertScriptStudioApiReady();
    const { id: projectId, taskId } = await params;
    const db = getDb();
    const parent = getTask(db, projectId, taskId);
    if (!parent) throw new ScriptStudioError('not_found', '任务不存在或不属于当前项目');
    if (parent.status !== 'partial' && parent.status !== 'failed') {
      throw new ScriptStudioError('conflict', '只有部分成功或失败任务可以补跑');
    }
    const parentInput = JSON.parse(parent.inputSnapshotJson || '{}') as Record<string, unknown>;
    const isPain = parentInput.productionMode === 'pain_solving_15s';
    const planStage = parent.stages.find((stage) => stage.stage === 'plan' && stage.status === 'succeeded');
    const planPayload = JSON.parse(planStage?.payloadJson || '{}') as { painPlanning?: { opportunities?: unknown[] } };
    const completed = db.prepare('SELECT validationJson FROM project_script_revisions WHERE generationTaskId = ?').all(taskId) as Array<{ validationJson: string }>;
    const completedIndexes = new Set(completed.map((row) => (JSON.parse(row.validationJson) as { generationPlanIndex?: number }).generationPlanIndex));
    const remaining = isPain ? planPayload.painPlanning?.opportunities?.filter((_, index) => !completedIndexes.has(index + 1)) : undefined;
    if (remaining?.length === 0) throw new ScriptStudioError('conflict', '内容机会已处理完毕，机会不足不属于生成失败');
    const requestedCount = remaining?.length ?? Math.max(1, parent.requestedCount - parent.succeededCount);
    const requestKey = `retry:${taskId}:${createHash('sha256').update(`${projectId}|${taskId}|${requestedCount}`).digest('hex')}`;
    const existingRetry = db.prepare(`
      SELECT id FROM script_studio_tasks WHERE projectId = ? AND requestKey = ? AND parentTaskId = ?
    `).get(projectId, requestKey, taskId) as { id: string } | undefined;
    if (existingRetry) {
      return NextResponse.json({ task: toTaskSnapshot(getTask(db, projectId, existingRetry.id)!), created: false }, { status: 202 });
    }
    const savedLibraryStage = parent.stages.find((stage) => (
      stage.stage === 'save_library' && stage.status === 'succeeded'
    ));
    let savedLibraryRevisionId = '';
    if (savedLibraryStage) {
      try {
        const payload = JSON.parse(savedLibraryStage.payloadJson || '{}') as Record<string, unknown>;
        savedLibraryRevisionId = typeof payload.libraryRevisionId === 'string' ? payload.libraryRevisionId : '';
      } catch {
        // 损坏的阶段展示数据不能让补跑走错卖点库；按父任务原模式重跑。
      }
    }
    const { ensureScriptStudioSchedulerStarted } = await import('@/lib/script-studio/bootstrap');
    try {
      await ensureScriptStudioSchedulerStarted();
    } catch {
      // 调度器不可用时仍保存 queued 任务，等待下次启动恢复。
    }
    const created = createTask(db, {
      projectId,
      requestKey,
      mode: savedLibraryRevisionId ? 'reuse' : parent.mode,
      sourceSetId: parent.sourceSetId,
      libraryRevisionId: savedLibraryRevisionId || parent.libraryRevisionId,
      inputSnapshot: {
        ...parentInput,
        ...(remaining ? { painRetryOpportunities: remaining, painPriorOpportunities: [
          ...(Array.isArray(parentInput.painPriorOpportunities) ? parentInput.painPriorOpportunities : []),
          ...(planPayload.painPlanning?.opportunities?.filter((_, index) => completedIndexes.has(index + 1)) ?? []),
        ] } : {}),
        parentTaskId: taskId,
        requestedCount,
      },
      requestedCount,
      parentTaskId: taskId,
    });
    return NextResponse.json({ task: toTaskSnapshot(created.task), created: created.created }, { status: 202 });
  } catch (error) {
    const result = errorResponse(error);
    return NextResponse.json(result.body, { status: result.status });
  }
}
