import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { assertBatchApiReady } from '@/lib/batch-production/runtime-readiness';
import {
  applyBatchOutputClipEdit,
  type BatchOutputClipEdit,
} from '@/lib/batch-production/output-arrangement';
import { scheduleRenderAfterClipEdit } from '@/lib/batch-production/phase-e';
import { ensureBatchSchedulerStarted } from '@/lib/batch-production/bootstrap';
import {
  BATCH_NO_STORE_HEADERS,
  batchProjectIdFromRequest,
  batchRouteErrorResponse,
} from '../../../../response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 片段级编辑（等长 trim/replace、变长修剪、删除、插入、分割）：就地改写当前
 * 候选版本 arrangement，只在画面变化时递增 editRevision 并重渲染同一版本。
 * 分割是纯结构操作，不递增 revision、不触发重渲染。
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string; planId: string }> }) {
  const { id, planId } = await context.params;
  const projectId = batchProjectIdFromRequest(request);
  if (!projectId) {
    return NextResponse.json({
      error: 'missing_project_id',
      message: '缺少 projectId 参数',
    }, { status: 400, headers: BATCH_NO_STORE_HEADERS });
  }
  try {
    await assertBatchApiReady();
    const body = await request.json().catch(() => ({})) as {
      type?: unknown;
      clipId?: unknown;
      sourceStartUs?: unknown;
      sourceEndUs?: unknown;
      assetId?: unknown;
      afterClipId?: unknown;
      durationUs?: unknown;
      offsetUs?: unknown;
    };
    const clipId = typeof body.clipId === 'string' ? body.clipId.trim() : '';
    let edit: BatchOutputClipEdit;

    if (body.type === 'trim' || body.type === 'trim_variable') {
      if (!clipId) {
        return NextResponse.json({
          error: 'invalid_clip_edit',
          message: '片段编辑需要 clipId',
        }, { status: 400, headers: BATCH_NO_STORE_HEADERS });
      }
      if (
        typeof body.sourceStartUs !== 'number' || !Number.isSafeInteger(body.sourceStartUs)
        || typeof body.sourceEndUs !== 'number' || !Number.isSafeInteger(body.sourceEndUs)
      ) {
        return NextResponse.json({
          error: 'invalid_clip_edit',
          message: '截取区间必须是安全整数(微秒)',
        }, { status: 400, headers: BATCH_NO_STORE_HEADERS });
      }
      edit = { type: body.type, clipId, sourceStartUs: body.sourceStartUs, sourceEndUs: body.sourceEndUs };
    } else if (body.type === 'replace') {
      const assetId = typeof body.assetId === 'string' ? body.assetId.trim() : '';
      if (!clipId || !assetId) {
        return NextResponse.json({
          error: 'invalid_clip_edit',
          message: '替换编辑需要 clipId 与 assetId',
        }, { status: 400, headers: BATCH_NO_STORE_HEADERS });
      }
      edit = { type: 'replace', clipId, assetId };
    } else if (body.type === 'delete') {
      if (!clipId) {
        return NextResponse.json({
          error: 'invalid_clip_edit',
          message: '删除编辑需要 clipId',
        }, { status: 400, headers: BATCH_NO_STORE_HEADERS });
      }
      edit = { type: 'delete', clipId };
    } else if (body.type === 'insert') {
      const assetId = typeof body.assetId === 'string' ? body.assetId.trim() : '';
      const afterClipId = typeof body.afterClipId === 'string'
        ? body.afterClipId.trim()
        : body.afterClipId === null
          ? null
          : undefined;
      if (!assetId || afterClipId === undefined || (afterClipId !== null && !afterClipId)) {
        return NextResponse.json({
          error: 'invalid_clip_edit',
          message: '插入编辑需要 assetId 与 afterClipId(null 表示插到最前)',
        }, { status: 400, headers: BATCH_NO_STORE_HEADERS });
      }
      if (
        body.durationUs !== undefined
        && (typeof body.durationUs !== 'number' || !Number.isSafeInteger(body.durationUs) || body.durationUs <= 0)
      ) {
        return NextResponse.json({
          error: 'invalid_clip_edit',
          message: '插入时长必须是正整数(微秒)',
        }, { status: 400, headers: BATCH_NO_STORE_HEADERS });
      }
      edit = { type: 'insert', assetId, afterClipId, ...(body.durationUs === undefined ? {} : { durationUs: body.durationUs }) };
    } else if (body.type === 'split') {
      if (!clipId || typeof body.offsetUs !== 'number' || !Number.isSafeInteger(body.offsetUs) || body.offsetUs < 0) {
        return NextResponse.json({
          error: 'invalid_clip_edit',
          message: '分割编辑需要 clipId 与非负安全整数 offsetUs(微秒)',
        }, { status: 400, headers: BATCH_NO_STORE_HEADERS });
      }
      edit = { type: 'split', clipId, offsetUs: body.offsetUs };
    } else {
      return NextResponse.json({
        error: 'invalid_clip_edit',
        message: '片段编辑需要 type(trim/replace/trim_variable/delete/insert/split)',
      }, { status: 400, headers: BATCH_NO_STORE_HEADERS });
    }

    const db = getDb();
    const result = applyBatchOutputClipEdit(db, projectId, id, planId, edit);
    // 视觉变化才重渲染这一条；requestKey 含 editRevision，同一次编辑重复提交
    // 不会重复排队，无变化(unchanged)与纯结构分割(split)都不排队。
    const renderTaskId = result.visualChanged ? scheduleRenderAfterClipEdit(db, projectId, id, planId) : null;
    if (renderTaskId) ensureBatchSchedulerStarted();
    return NextResponse.json({ ...result, renderTaskId }, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) {
    return batchRouteErrorResponse(error, 'batch_clip_edit_failed', '编辑成片片段失败');
  }
}
