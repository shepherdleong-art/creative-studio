import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { assertBatchApiReady } from '@/lib/batch-production/runtime-readiness';
import { normalizeManualScriptBatch, type ManualScriptDraftInput } from '@/lib/batch-production/manual-script-import';
import { createManualProjectScript } from '@/lib/batch-production/scripts';
import { BATCH_NO_STORE_HEADERS, batchRouteErrorResponse } from '../batches/response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 导入自定义(手动)脚本为项目级脚本。body: { projectId, scripts: [...] }。
 * 单条即长度 1 的数组;批量粘贴由前端切好再提交。整批一个事务,全成功或全失败;
 * 条数与总字符上限在服务端独立校验,不能只信前端。
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null) as {
    projectId?: unknown;
    scripts?: unknown;
  } | null;
  const projectId = typeof body?.projectId === 'string' && body.projectId ? body.projectId : null;
  const rawScripts = Array.isArray(body?.scripts) ? body.scripts : null;
  if (!projectId || !rawScripts || rawScripts.length === 0) {
    return NextResponse.json({
      error: 'invalid_input',
      message: 'projectId 与 scripts 不能为空',
    }, { status: 400, headers: BATCH_NO_STORE_HEADERS });
  }
  const scripts: ManualScriptDraftInput[] = [];
  for (const item of rawScripts) {
    const record = item && typeof item === 'object' ? item as Record<string, unknown> : null;
    const title = typeof record?.title === 'string' ? record.title : null;
    const bodyText = typeof record?.bodyText === 'string' ? record.bodyText : null;
    const targetDurationSec = typeof record?.targetDurationSec === 'number' ? record.targetDurationSec : null;
    if (title === null || bodyText === null || targetDurationSec === null) {
      return NextResponse.json({
        error: 'invalid_input',
        message: '每条脚本需要 title、bodyText 与 targetDurationSec',
      }, { status: 400, headers: BATCH_NO_STORE_HEADERS });
    }
    scripts.push({ title, bodyText, targetDurationSec });
  }
  try {
    await assertBatchApiReady();
    const db = getDb();
    const project = db.prepare(`SELECT id FROM projects WHERE id = ?`).get(projectId);
    if (!project) {
      return NextResponse.json({
        error: 'project_not_found',
        message: '项目不存在',
      }, { status: 404, headers: BATCH_NO_STORE_HEADERS });
    }
    const normalized = normalizeManualScriptBatch(scripts);
    const created = db.transaction(() => normalized.map((input) => ({
      id: createManualProjectScript(db, projectId, input),
      title: input.title,
    }))).immediate();
    return NextResponse.json({ created }, { status: 201, headers: BATCH_NO_STORE_HEADERS });
  } catch (error) {
    return batchRouteErrorResponse(error, 'manual_script_create_failed', '自定义脚本导入失败');
  }
}
