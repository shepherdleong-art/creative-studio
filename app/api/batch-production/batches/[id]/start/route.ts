import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { startOrResumePhaseE } from '@/lib/batch-production/phase-e';
import { ensureBatchSchedulerStarted } from '@/lib/batch-production/bootstrap';
import { assertBatchApiReady } from '@/lib/batch-production/runtime-readiness';
import { prepareBatchSemanticScoreBeforeStart } from '@/lib/batch-production/semantic-match';
import {
  BATCH_NO_STORE_HEADERS,
  batchProjectIdFromRequest,
  batchRouteErrorResponse,
} from '../../response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 冻结输入、执行幂等的全批联合分配，并把每条候选接入同一持久调度器。 */
export async function PUT(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const projectId = batchProjectIdFromRequest(request);
  if (!projectId) {
    return NextResponse.json({ error: 'missing_project_id', message: '缺少 projectId 参数' }, {
      status: 400,
      headers: BATCH_NO_STORE_HEADERS,
    });
  }
  try {
    await assertBatchApiReady();
    const db = getDb();
    // 开跑前的语义匹配保证:草稿版本先幂等排队打分,仍有未完成的打分时不冻结,
    // 返回 semantic_scoring 由前端在打分完成后自动续跑;打分失败/不可用不阻塞开跑。
    const lineage = db.prepare(`
      SELECT b.currentVersionId AS versionId, v.inputState
      FROM batch_productions b
      LEFT JOIN batch_production_versions v ON v.id = b.currentVersionId
      WHERE b.id = ? AND b.projectId = ? AND b.deletedAt IS NULL
    `).get(id, projectId) as { versionId: string | null; inputState: string | null } | undefined;
    if (lineage?.inputState === 'draft' && lineage.versionId) {
      const prep = await prepareBatchSemanticScoreBeforeStart(db, projectId, id, lineage.versionId);
      if (prep.pending > 0) {
        ensureBatchSchedulerStarted();
        return NextResponse.json({
          batchId: id,
          status: 'semantic_scoring',
          semanticScorePending: prep.pending,
        }, { headers: BATCH_NO_STORE_HEADERS });
      }
    }
    const result = startOrResumePhaseE(db, projectId, id);
    ensureBatchSchedulerStarted();
    return NextResponse.json({
      batchId: id,
      status: 'running',
      batchVersionId: result.batchVersionId,
      allocationRunId: result.allocationRunId,
      allocationStatus: result.allocationStatus,
      outputCount: Object.keys(result.outputVersionIds).length,
      taskCount: Object.keys(result.taskIds).length,
    }, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) {
    return batchRouteErrorResponse(error, 'batch_start_failed', '批次启动失败');
  }
}
