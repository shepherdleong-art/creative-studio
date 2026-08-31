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
import { createTask, getTask, getTaskByRequestKey } from '@/lib/script-studio/tasks';
import { toTaskSnapshot } from '@/lib/script-studio/snapshot';
import { createHash } from 'node:crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function requestKeyFor(input: Record<string, unknown>): string {
  if (typeof input.requestKey === 'string' && input.requestKey.trim()) return input.requestKey.trim();
  return createHash('sha256')
    .update([
      String(input.projectId || ''),
      String(input.sourceSetId || ''),
      String(input.libraryRevisionId || ''),
      String(input.targetDurationSec || ''),
      String(input.requestedCount || ''),
      String(input.creativeBrief || ''),
      String(input.providerId || ''),
    ].join('|'))
    .digest('hex');
}

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
    const targetDurationSec = Number(body.targetDurationSec);
    const requestedCount = Math.floor(Number(body.requestedCount));
    if (![15, 20, 30, 45, 60].includes(targetDurationSec)) {
      throw new ScriptStudioError('invalid_input', '目标时长仅支持 15、20、30、45 或 60 秒');
    }
    if (!Number.isInteger(requestedCount) || requestedCount < 1 || requestedCount > 5) {
      throw new ScriptStudioError('invalid_input', '生成数量必须是 1-5 的整数');
    }
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
    // 提交前确认视觉/文本供应商可用，避免进入必然失败的长任务。
    const providers = resolveRuntimeProviders(providerId);
    const requestKey = requestKeyFor({ projectId, ...body });
    const existing = getTaskByRequestKey(db, projectId, requestKey);
    if (existing) {
      return NextResponse.json({
        task: toTaskSnapshot(existing),
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
    const created = createTask(db, {
      projectId,
      requestKey,
      mode,
      sourceSetId,
      libraryRevisionId,
      inputSnapshot: {
        targetDurationSec,
        requestedCount,
        creativeBrief: typeof body.creativeBrief === 'string' ? body.creativeBrief.slice(0, 2000) : '',
        providerId: providers.vision.id,
        providerModel: providers.vision.model,
        ...(typeof body.targetScriptId === 'string' ? { targetScriptId: body.targetScriptId } : {}),
      },
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
