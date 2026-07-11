import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export const runtime = 'nodejs';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: projectId } = await params;
    const shotSetId = request.nextUrl.searchParams.get('shotSetId');
    const db = getDb();
    const draft = shotSetId
      ? db.prepare(`SELECT id, stage, revision, previewJobId, previewRevision FROM final_video_drafts
          WHERE projectId = ? AND shotSetId = ? ORDER BY createdAt DESC, rowid DESC LIMIT 1`).get(projectId, shotSetId)
      : db.prepare(`SELECT id, stage, revision, previewJobId, previewRevision FROM final_video_drafts
          WHERE projectId = ? ORDER BY createdAt DESC, rowid DESC LIMIT 1`).get(projectId);
    return NextResponse.json({
      error: 'draft_workflow_required',
      message: '预览已迁移到成片草稿工作流，请使用当前草稿创建 preview job',
      currentDraft: draft ?? null,
      // Keep the v1 panel inert during the migration without calculating a v1 timeline.
      draft: null,
      segments: [],
      issues: [],
      totalDurationSec: 0,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
