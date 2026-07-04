import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import { getDb } from '@/lib/db';
import { buildTimeline } from '@/lib/final-video/timeline';
import { findScriptDraftForShotSet } from '@/lib/final-video/draft';

export const runtime = 'nodejs';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: projectId } = await params;
    const shotSetId = request.nextUrl.searchParams.get('shotSetId');
    if (!shotSetId) return NextResponse.json({ error: 'shotSetId is required' }, { status: 400 });
    const db = getDb();

    const draft = findScriptDraftForShotSet(db, projectId, shotSetId);
    if (!draft) return NextResponse.json({ draft: null, segments: [], issues: [] });

    const clipRows = db
      .prepare(
        `SELECT shotId, id as videoJobId, localVideoPath, durationSec FROM video_jobs
         WHERE shotSetId = ? AND status = 'succeeded' AND localVideoPath IS NOT NULL
         ORDER BY createdAt DESC`
      )
      .all(shotSetId) as Array<{ shotId: string | null; videoJobId: string; localVideoPath: string; durationSec: number }>;
    const latest = new Map<string, { videoJobId: string; localVideoPath: string; durationSec: number }>();
    for (const row of clipRows) {
      if (row.shotId && !latest.has(row.shotId) && fs.existsSync(row.localVideoPath)) latest.set(row.shotId, row);
    }

    const scriptShots = (draft.output.shots ?? []).map((s) => ({
      shotId: s.shotId,
      shotIndex: s.shotIndex,
      voiceover: String(s.voiceover ?? ''),
      subtitle: String(s.subtitle ?? ''),
    }));
    // 预览用请求时长近似，正式渲染时执行器会 ffprobe 实际时长
    const { segments, issues, totalDurationSec } = buildTimeline({
      scriptShots,
      clips: [...latest.entries()].map(([shotId, c]) => ({
        shotId,
        videoJobId: c.videoJobId,
        clipPath: c.localVideoPath,
        clipDurationSec: c.durationSec,
      })),
    });
    return NextResponse.json({
      draft: { id: draft.id, title: draft.output.title ?? '' },
      segments,
      issues,
      totalDurationSec,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
