import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { assertBatchApiReady } from '@/lib/batch-production/runtime-readiness';
import { deleteManualProjectScript, updateManualProjectScript } from '@/lib/batch-production/scripts';
import {
  BATCH_NO_STORE_HEADERS,
  batchRouteErrorResponse,
} from '../../batches/response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 编辑一条手动导入的项目脚本。只允许 manual: 命名空间的脚本——
 * AI 同步脚本每次 prepare 都会被 syncProjectScripts 按草稿内容重新覆盖,
 * 直接编辑会被静默回滚,因此这里一律按 not_found 拒绝。
 */
export async function PUT(request: NextRequest, context: { params: Promise<{ scriptId: string }> }) {
  const { scriptId } = await context.params;
  const projectId = request.nextUrl.searchParams.get('projectId');
  if (!projectId) {
    return NextResponse.json({ error: 'missing_project_id', message: '缺少 projectId 参数' }, {
      status: 400,
      headers: BATCH_NO_STORE_HEADERS,
    });
  }
  const body = await request.json().catch(() => null) as {
    title?: unknown;
    bodyText?: unknown;
    targetDurationSec?: unknown;
  } | null;
  const title = typeof body?.title === 'string' ? body.title : null;
  const bodyText = typeof body?.bodyText === 'string' ? body.bodyText : null;
  const targetDurationSec = typeof body?.targetDurationSec === 'number' ? body.targetDurationSec : null;
  if (title === null || bodyText === null || targetDurationSec === null) {
    return NextResponse.json({ error: 'invalid_input', message: '需要 title、bodyText 与 targetDurationSec' }, {
      status: 400,
      headers: BATCH_NO_STORE_HEADERS,
    });
  }
  try {
    await assertBatchApiReady();
    updateManualProjectScript(getDb(), projectId, scriptId, { title, bodyText, targetDurationSec });
    return NextResponse.json({ scriptId }, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) {
    return batchRouteErrorResponse(error, 'manual_script_update_failed', '手动脚本保存失败');
  }
}

/** 删除一条手动脚本:未被快照引用物理删,已被引用软删(历史快照保留)。 */
export async function DELETE(request: NextRequest, context: { params: Promise<{ scriptId: string }> }) {
  const { scriptId } = await context.params;
  const projectId = request.nextUrl.searchParams.get('projectId');
  if (!projectId) {
    return NextResponse.json({ error: 'missing_project_id', message: '缺少 projectId 参数' }, {
      status: 400,
      headers: BATCH_NO_STORE_HEADERS,
    });
  }
  try {
    await assertBatchApiReady();
    const result = deleteManualProjectScript(getDb(), projectId, scriptId);
    return NextResponse.json({ scriptId, mode: result.mode }, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) {
    return batchRouteErrorResponse(error, 'manual_script_delete_failed', '手动脚本删除失败');
  }
}
