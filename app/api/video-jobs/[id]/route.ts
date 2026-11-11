import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { requiresReassembledUpstreamRework, REASSEMBLED_REWORK_REQUIRED } from '@/lib/reassembled-shot-guard';
import { resolveVideoJobDisplayNames } from '@/lib/video-output-filenames';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';
import { applyUnifiedKlingJobCancel } from '@/lib/media-core/unified-media/cancel-intent';
import { applyLegacyVideoJobCancel } from '@/lib/legacy-media-cancel';
import {
  cancelLegacyMediaNewStage,
  legacyMediaExecutionRevision,
} from '@/lib/legacy-media-execution';
import { videoJobForClient } from '@/lib/client-media-dto';

async function __teamRouteGET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const db = getDb();
    const job = db.prepare(`
      SELECT vj.*, vp.name as providerName, vpt.name as templateName
      FROM video_jobs vj
      LEFT JOIN video_providers vp ON vp.id = vj.providerId
      LEFT JOIN video_prompt_templates vpt ON vpt.id = vj.templateId
      WHERE vj.id = ?
    `).get(id) as Record<string, unknown> | undefined;
    if (!job) return NextResponse.json({ error: 'Video job not found' }, { status: 404 });
    // videoUrl 由登记路径生成；displayName 是所有用户可见名称，
    // 旧任务为 NULL 时由共享 helper 确定性派生（不回写数据库）。
    const displayNames = resolveVideoJobDisplayNames(db, [String(job.id)]);
    return NextResponse.json({
      ...videoJobForClient(job),
      displayName: displayNames.get(String(job.id)) ?? null,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

async function __teamRoutePATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const db = getDb();
    const body = await request.json().catch(() => ({})) as {
      action?: string;
      reason?: unknown;
      rejectReason?: unknown;
    };
    if (body.action === 'reject' || body.action === 'unreject') {
      const owner = db.prepare('SELECT shotSetId FROM video_jobs WHERE id=?').get(id) as { shotSetId: string | null } | undefined;
      if (owner?.shotSetId && requiresReassembledUpstreamRework(db, owner.shotSetId)) return NextResponse.json({ error: REASSEMBLED_REWORK_REQUIRED }, { status: 409 });
      const job = db.prepare(`SELECT status FROM video_jobs WHERE id = ?`).get(id) as { status: string } | undefined;
      if (!job) return NextResponse.json({ error: 'Video job not found' }, { status: 404 });
      if (job.status !== 'succeeded') {
        return NextResponse.json({ error: '只有已完成的视频才能剔除或恢复' }, { status: 409 });
      }
      if (body.action === 'reject') {
        const rawReason = typeof body.reason === 'string' ? body.reason : body.rejectReason;
        const reason = typeof rawReason === 'string' ? rawReason.trim().slice(0, 500) : '';
        db.prepare(`UPDATE video_jobs SET rejectedAt = datetime('now'), rejectReason = ? WHERE id = ?`).run(reason || null, id);
      } else {
        db.prepare(`UPDATE video_jobs SET rejectedAt = NULL, rejectReason = NULL WHERE id = ?`).run(id);
      }
      return NextResponse.json({ success: true });
    }
    if (body.action !== 'cancel') {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }

    const unified = db.prepare('SELECT unifiedModel FROM video_jobs WHERE id = ?').pluck().get(id) as
      | string
      | null
      | undefined;
    if (unified === undefined) return NextResponse.json({ error: 'Video job not found' }, { status: 404 });
    if (!unified) {
      // 老通道与统一模型同一套取消契约：已受理只写取消意图、保持原状态，
      // 由队列继续沿原通道只读查询与补下载；未受理才立即 canceled。
      // 旧实现直接写 canceled 而不写意图，执行记录会永远停在 accepted。
      const result = applyLegacyVideoJobCancel(db, id);
      if (!result) return NextResponse.json({ error: 'Video job not found' }, { status: 404 });
      if (!result.acceptedSubmittedWork) {
        await cancelLegacyMediaNewStage({
          module: 'video',
          taskId: id,
          inputRevision: legacyMediaExecutionRevision(
            db.prepare('SELECT executionRevision FROM video_jobs WHERE id = ?').pluck().get(id),
          ),
        });
      }
      return NextResponse.json({ success: true, changed: !result.idempotent, ...result });
    }
    const result = applyUnifiedKlingJobCancel(db, id);
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
export const GET = withTeamRoute('/api/video-jobs/[id]', 'GET', __teamRouteGET);
export const PATCH = withTeamRoute('/api/video-jobs/[id]', 'PATCH', __teamRoutePATCH);
