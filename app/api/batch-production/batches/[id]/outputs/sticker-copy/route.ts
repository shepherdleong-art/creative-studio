import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { assertBatchApiReady } from '@/lib/batch-production/runtime-readiness';
import { BatchDomainError } from '@/lib/batch-production/errors';
import {
  copyBatchOutputStickers,
  restoreBatchOutputStickers,
  type BatchPackagingStickerSnapshot,
  type BatchStickerCopyTarget,
  type BatchStickerRestoreTarget,
} from '@/lib/batch-production/sticker-copy';
import {
  BATCH_NO_STORE_HEADERS,
  batchProjectIdFromRequest,
  batchRouteErrorResponse,
} from '../../../response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function invalidInput(message: string): never {
  throw new BatchDomainError('invalid_input', message);
}

function parseTarget(value: unknown): BatchStickerCopyTarget {
  if (!isRecord(value) || typeof value.planId !== 'string' || !value.planId.trim()
    || typeof value.expectedOutputVersionId !== 'string' || !value.expectedOutputVersionId.trim()
    || typeof value.expectedEditRevision !== 'number'
    || !Number.isSafeInteger(value.expectedEditRevision) || value.expectedEditRevision < 0) {
    invalidInput('目标成片需要有效的 planId、expectedOutputVersionId 与 expectedEditRevision');
  }
  return {
    planId: value.planId.trim(),
    expectedOutputVersionId: value.expectedOutputVersionId.trim(),
    expectedEditRevision: value.expectedEditRevision,
  };
}

function parseRestoreTarget(value: unknown): BatchStickerRestoreTarget {
  const target = parseTarget(value);
  if (!isRecord(value) || !isRecord(value.snapshot)) invalidInput('恢复目标缺少有效贴纸快照');
  return { ...target, snapshot: value.snapshot as BatchPackagingStickerSnapshot };
}

/** 批次级贴纸复制与整体撤销/重做恢复；任一目标失败时整个事务回滚。 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const projectId = batchProjectIdFromRequest(request);
  if (!projectId) {
    return NextResponse.json({
      error: 'missing_project_id',
      message: '缺少 projectId 参数',
    }, { status: 400, headers: BATCH_NO_STORE_HEADERS });
  }
  try {
    await assertBatchApiReady();
    const body = await request.json().catch(() => ({})) as unknown;
    if (!isRecord(body) || !Array.isArray(body.targets)) invalidInput('请求需要 type 与 targets 数组');
    const db = getDb();
    if (body.type === 'copy') {
      if (typeof body.sourcePlanId !== 'string' || !body.sourcePlanId.trim()) invalidInput('复制需要来源 sourcePlanId');
      const result = copyBatchOutputStickers(db, projectId, id, {
        sourcePlanId: body.sourcePlanId.trim(),
        targets: body.targets.map(parseTarget),
      });
      return NextResponse.json(result, { headers: BATCH_NO_STORE_HEADERS });
    }
    if (body.type === 'restore') {
      const result = restoreBatchOutputStickers(db, projectId, id, {
        targets: body.targets.map(parseRestoreTarget),
      });
      return NextResponse.json(result, { headers: BATCH_NO_STORE_HEADERS });
    }
    invalidInput('贴纸操作 type 必须为 copy 或 restore');
  } catch (error) {
    return batchRouteErrorResponse(error, 'batch_sticker_copy_failed', '贴纸复制或恢复失败');
  }
}
