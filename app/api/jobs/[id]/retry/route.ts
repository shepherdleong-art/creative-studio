import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { writeLog } from '@/lib/logger';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';


async function __teamRoutePOST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const db = getDb();

    const job = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as {
      id: string;
      projectId: string;
      status: string;
      providerTaskId?: string | null;
      providerStatus?: string | null;
      remoteImageUrl?: string | null;
    } | undefined;

    if (!job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }

    if (!['failed', 'canceled'].includes(job.status)) {
      return NextResponse.json({ error: 'Only failed or canceled jobs can be retried' }, { status: 400 });
    }

    const existingTaskId = typeof job.providerTaskId === 'string' ? job.providerTaskId.trim() : '';
    // 远端已确认终态失败（队列的 failRemoteImageTask 会写 providerStatus='failed'）：
    // 这个远端任务不可能再有结果，继续保留 task id 只会把「重试」变成
    // 「等待补抓结果」的死路。清掉远端身份，让重试真正重新提交。
    const terminalRemoteFailure = job.status === 'failed' && job.providerStatus === 'failed';
    // 结果已生成、只差下载（同步供应商可能没有 task id）：保留远端结果走补抓，
    // 不能重新提交，否则会重复扣费。
    const downloadableResult = job.providerStatus === 'download_failed' && Boolean(job.remoteImageUrl);

    if ((existingTaskId || downloadableResult) && !terminalRemoteFailure) {
      // The remote task may already be billable. Preserve its identity and
      // route the user to polling instead of creating a second task.
      const message = existingTaskId
        ? `已有远端图片任务 ${existingTaskId}，请点“补抓结果”继续查询。`
        : '远端图片已生成但本地下载失败，请点“补抓结果”重试下载。';
      db.prepare(`
        UPDATE jobs SET status = 'needs_check',
          providerStatus = CASE WHEN providerStatus = 'download_failed' THEN 'download_failed' ELSE 'needs_check' END,
          errorMessage = ?, startedAt = NULL, finishedAt = NULL
        WHERE id = ?
      `).run(message, id);

      return NextResponse.json({ success: true, status: 'needs_check', resumeRequired: true });
    }

    if (terminalRemoteFailure && existingTaskId) {
      writeLog({
        jobId: id,
        projectId: job.projectId,
        level: 'warn',
        message: `重试清除已终态失败的远端图片任务 ${existingTaskId}，将重新提交。`,
      });
    }

    db.prepare(`
      UPDATE jobs SET status = 'pending', attempt = 0, errorMessage = NULL,
        providerTaskId = NULL, providerStatus = NULL, providerRawResponse = NULL, submittedAt = NULL,
        remoteImageUrl = NULL, startedAt = NULL, finishedAt = NULL, latencyMs = NULL, estimatedCost = NULL,
        executionRevision = COALESCE(executionRevision, 0) + 1
      WHERE id = ?
    `).run(id);

    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
export const POST = withTeamRoute('/api/jobs/[id]/retry', 'POST', __teamRoutePOST);
