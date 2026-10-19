import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { createBatchSnapshot } from '@/lib/batch-production/batch-flow';
import { assertBatchApiReady } from '@/lib/batch-production/runtime-readiness';
import { ensureBatchSchedulerStarted } from '@/lib/batch-production/bootstrap';
import { queueBatchSemanticScoreTasks } from '@/lib/batch-production/semantic-match';
import { writeLog } from '@/lib/logger';
import {
  BATCH_NO_STORE_HEADERS,
  batchProjectIdFromRequest,
  batchRouteErrorResponse,
} from '../../response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 确认整体输入并建立可检查的 draft 快照；真正冻结发生在 start。 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const projectId = batchProjectIdFromRequest(request);
  if (!projectId) {
    return NextResponse.json({ error: 'missing_project_id', message: '缺少 projectId 参数' }, {
      status: 400,
      headers: BATCH_NO_STORE_HEADERS,
    });
  }
  const body = await request.json().catch(() => null) as {
    scriptSelections?: Array<{ scriptId: string; copyCount: number }>;
    assetSelections?: Array<{ assetId: string; analysisId: string; colorSnapshot?: unknown }>;
    defaultsJson?: unknown;
  } | null;
  if (!body?.scriptSelections || body.scriptSelections.length === 0) {
    return NextResponse.json({ error: 'invalid_input', code: 'invalid_input', message: 'scriptSelections 不能为空' }, {
      status: 400,
      headers: BATCH_NO_STORE_HEADERS,
    });
  }
  if (!body.assetSelections || body.assetSelections.length === 0) {
    return NextResponse.json({ error: 'invalid_input', code: 'invalid_input', message: 'assetSelections 不能为空' }, {
      status: 400,
      headers: BATCH_NO_STORE_HEADERS,
    });
  }
  try {
    await assertBatchApiReady();
    // colorSnapshot 原样透传:客户端可以只提交 lutId,服务端 createBatchSnapshot
    // 会按项目内受管 LUT 构建完整 ColorSnapshotV1(指纹/色彩链版本/插值/SDR 合同),
    // 空字符串指纹绕过在服务端被拒绝。
    const assetSelections = body.assetSelections.map(({ colorSnapshot, ...rest }) => ({
      ...rest,
      colorSnapshot: colorSnapshot === undefined ? undefined : colorSnapshot as { lutId: string | null } | import('@/lib/batch-production/color-pipeline').ColorSnapshotV1,
    }));
    const result = createBatchSnapshot(getDb(), projectId, id, {
      scriptSelections: body.scriptSelections,
      assetSelections,
      defaultsJson: body.defaultsJson,
    });
    // 快照确认后对该版本每个脚本快照幂等排队语义矩阵打分;失败/无供应商/
    // 无内容分析都不阻塞快照响应(分配有现成关键词+质量兜底)。
    try {
      const queued = await queueBatchSemanticScoreTasks(getDb(), projectId, id, result.batchVersionId, {});
      if (queued.created.length > 0) ensureBatchSchedulerStarted();
    } catch (error) {
      writeLog({
        projectId,
        level: 'warn',
        message: `语义匹配任务创建失败(快照不受影响): ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    return NextResponse.json({ batchId: id, ...result }, { status: 201, headers: BATCH_NO_STORE_HEADERS });
  } catch (error) {
    return batchRouteErrorResponse(error, 'batch_snapshot_failed', '批次快照建立失败');
  }
}
