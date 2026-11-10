import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { isReassembledImageJob } from '@/lib/reassembled-shot-guard';
import { filmWriteActor } from '@/lib/final-edit/reassembled/access';
import { finalEditErrorResponse } from '@/lib/final-edit/http';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';
import { applyUnifiedImageJobCancel } from '@/lib/media-core/unified-media/cancel-intent';

async function __teamRoutePATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const db = getDb();
    const body = await request.json();
    if (isReassembledImageJob(db, id) && body.action !== 'cancel') {
      try {
        if (filmWriteActor(request) === 'agent') return NextResponse.json({ error: '实拍制作的人工审核标记不能由 Agent 覆盖' }, { status: 409 });
      } catch (error) { return finalEditErrorResponse(error); }
    }

    if (body.action === 'cancel') {
      try {
        const result = applyUnifiedImageJobCancel(db, id);
        if (!result) return NextResponse.json({ error: 'Job not found' }, { status: 404 });
        return NextResponse.json({ success: true, ...result });
      } catch (error) {
        if (error instanceof Error && error.message === 'old_media_cancel_contract') {
          return NextResponse.json({ error: '旧任务的取消规则保持不变。' }, { status: 409 });
        }
        throw error;
      }
    }

    const { mark } = body; // 'available' | 'rework' | 'discard' | '' (clear)

    if (mark && !['available', 'rework', 'discard'].includes(mark)) {
      return NextResponse.json({ error: 'Invalid mark value' }, { status: 400 });
    }

    db.prepare(`UPDATE jobs SET reviewMark = ? WHERE id = ?`).run(mark || '', id);

    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
export const PATCH = withTeamRoute('/api/jobs/[id]', 'PATCH', __teamRoutePATCH);
