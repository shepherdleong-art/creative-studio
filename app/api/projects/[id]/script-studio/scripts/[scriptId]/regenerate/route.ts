import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { getDb } from '@/lib/db';
import { ScriptStudioError } from '@/lib/script-studio/errors';
import { assertScriptStudioApiReady, errorResponse, jsonOrNull } from '@/lib/script-studio/http';
import { getCurrentLibraryRevision } from '@/lib/script-studio/libraries';
import { getProjectScript } from '@/lib/script-studio/scripts';
import { createTask, getTaskByRequestKey } from '@/lib/script-studio/tasks';
import { toTaskSnapshot } from '@/lib/script-studio/snapshot';
import { resolveRuntimeProviders } from '@/lib/script-studio/runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; scriptId: string }> },
) {
  try {
    await assertScriptStudioApiReady();
    const { id: projectId, scriptId } = await params;
    const db = getDb();
    const script = getProjectScript(db, projectId, scriptId);
    if (!script) throw new ScriptStudioError('not_found', '项目脚本不存在');
    const library = getCurrentLibraryRevision(db, projectId);
    if (!library) throw new ScriptStudioError('not_found', '当前项目没有可复用的卖点库');
    const body = await jsonOrNull(request) ?? {};
    const requestedProviderId = typeof body.providerId === 'string' ? body.providerId.trim() : '';
    const providers = resolveRuntimeProviders(requestedProviderId);
    const requestKey = `regenerate:${scriptId}:${createHash('sha256').update(`${projectId}|${library.id}|${providers.text.id}|${providers.text.model}`).digest('hex')}`;
    const existing = getTaskByRequestKey(db, projectId, requestKey);
    if (existing) return NextResponse.json({ task: toTaskSnapshot(existing), created: false }, { status: 202 });
    const { ensureScriptStudioSchedulerStarted } = await import('@/lib/script-studio/bootstrap');
    try {
      await ensureScriptStudioSchedulerStarted();
    } catch {
      // 调度器不可用时仍保存 queued 任务，等待下次启动恢复。
    }
    const currentDuration = script.currentRevision?.targetDurationSec || 15;
    const created = createTask(db, {
      projectId,
      requestKey,
      mode: 'reuse',
      libraryRevisionId: library.id,
      inputSnapshot: {
        targetDurationSec: currentDuration,
        requestedCount: 1,
        creativeBrief: '',
        targetScriptId: scriptId,
        providerId: providers.text.id,
        providerModel: providers.text.model,
      },
      requestedCount: 1,
    });
    return NextResponse.json({ task: toTaskSnapshot(created.task), created: true }, { status: 202 });
  } catch (error) {
    const result = errorResponse(error);
    return NextResponse.json(result.body, { status: result.status });
  }
}
