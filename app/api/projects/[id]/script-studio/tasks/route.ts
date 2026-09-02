import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { ScriptStudioError } from '@/lib/script-studio/errors';
import {
  assertScriptStudioApiReady,
  errorResponse,
  jsonOrNull,
} from '@/lib/script-studio/http';
import { getCurrentLibraryRevision, getLibraryRevision } from '@/lib/script-studio/libraries';
import { getSourceSet } from '@/lib/script-studio/source-sets';
import { resolveRuntimeProviders } from '@/lib/script-studio/runtime';
import {
  createTask,
  decideTaskRequest,
  getTask,
} from '@/lib/script-studio/tasks';
import { parseScriptStudioRequestedCount, parseScriptStudioTargetDuration } from '@/lib/script-studio/generation-contract';
import { toTaskSnapshot } from '@/lib/script-studio/snapshot';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await assertScriptStudioApiReady();
    const { id: projectId } = await params;
    const body = await jsonOrNull(request);
    if (!body) throw new ScriptStudioError('invalid_input', '请求体必须是 JSON 对象');
    const db = getDb();
    const project = db.prepare(`SELECT id FROM projects WHERE id = ?`).get(projectId);
    if (!project) throw new ScriptStudioError('not_found', '项目不存在');
    const targetDurationSec = parseScriptStudioTargetDuration(body.targetDurationSec);
    const requestedCount = parseScriptStudioRequestedCount(body.requestedCount);
    const sourceSetId = typeof body.sourceSetId === 'string' ? body.sourceSetId : null;
    const libraryRevisionId = typeof body.libraryRevisionId === 'string' ? body.libraryRevisionId : null;
    const providerId = typeof body.providerId === 'string' ? body.providerId.trim() : '';
    if (sourceSetId && !getSourceSet(db, projectId, sourceSetId)) {
      throw new ScriptStudioError('not_found', '详情页来源集不存在或不属于当前项目');
    }
    let mode: 'first_extraction' | 'reuse';
    if (libraryRevisionId) {
      mode = 'reuse';
      if (!getLibraryRevision(db, projectId, libraryRevisionId)) {
        throw new ScriptStudioError('not_found', '卖点库修订不存在或不属于当前项目');
      }
    } else {
      const current = getCurrentLibraryRevision(db, projectId);
      if (current && !sourceSetId) {
        mode = 'reuse';
      } else if (sourceSetId) {
        mode = 'first_extraction';
      } else {
        throw new ScriptStudioError('invalid_input', '首次生成需要提供详情页来源集，或复用已有卖点库');
      }
    }
    // 视觉/文本供应商只在 decideTaskRequest 确认要创建时才解析（见 G5 注释）。
    const creativeBrief = typeof body.creativeBrief === 'string' ? body.creativeBrief.slice(0, 2000) : '';
    const targetScriptId = typeof body.targetScriptId === 'string' ? body.targetScriptId.trim() : '';
    const explicitRequestKey = typeof body.requestKey === 'string' ? body.requestKey.trim() : '';
    // G5：先走幂等决策，命中既有任务就按冻结身份复用，全程不解析当前供应商——
    // 丢包重试期间供应商被删/不可用不影响安全重放；只有确认要创建才解析并冻结。
    const decision = decideTaskRequest(db, {
      projectId,
      mode,
      sourceSetId,
      libraryRevisionId,
      targetDurationSec,
      requestedCount,
      creativeBrief,
      targetScriptId,
      providerId,
      explicitRequestKey,
    }, resolveRuntimeProviders);
    if (decision.existing) {
      return NextResponse.json({
        task: toTaskSnapshot(decision.existing),
        created: false,
        schedulerEnabled: process.env.CREATIVE_STUDIO_SCRIPT_STUDIO_ENABLE_SCHEDULER === '1',
      }, { status: 202 });
    }
    const { ensureScriptStudioSchedulerStarted } = await import('@/lib/script-studio/bootstrap');
    try {
      await ensureScriptStudioSchedulerStarted();
    } catch {
      // 调度器启动失败时任务仍会留作 queued，下轮 instrumentation 启动恢复。
    }
    // 全新 key：走 decideTaskRequest 冻结的 inputSnapshot，原子 get-or-create。
    const created = createTask(db, {
      projectId,
      requestKey: decision.requestKey,
      mode,
      sourceSetId,
      libraryRevisionId,
      inputSnapshot: decision.snapshot!,
      requestedCount,
    });
    return NextResponse.json({
      task: toTaskSnapshot(created.task),
      created: created.created,
      schedulerEnabled: process.env.CREATIVE_STUDIO_SCRIPT_STUDIO_ENABLE_SCHEDULER === '1',
    }, { status: 202 });
  } catch (error) {
    const result = errorResponse(error);
    return NextResponse.json(result.body, { status: result.status });
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await assertScriptStudioApiReady();
    const { id: projectId } = await params;
    const db = getDb();
    const url = new URL(request.url);
    const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit')) || 20));
    const rows = db.prepare(`
      SELECT id FROM script_studio_tasks
      WHERE projectId = ? ORDER BY createdAt DESC LIMIT ?
    `).all(projectId, limit) as Array<{ id: string }>;
    const tasks = rows.map((row) => toTaskSnapshot(getTask(db, projectId, row.id)!));
    return NextResponse.json({ tasks });
  } catch (error) {
    const result = errorResponse(error);
    return NextResponse.json(result.body, { status: result.status });
  }
}
