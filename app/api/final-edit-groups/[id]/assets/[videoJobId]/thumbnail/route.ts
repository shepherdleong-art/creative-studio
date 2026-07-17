import path from 'node:path';
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { dataRoot } from '@/lib/data-root';
import { mediaResponse } from '@/lib/final-edit/media-response';
import { materializeVideoFrame } from '@/lib/final-edit/video-frame';

export async function GET(request: Request, { params }: { params: Promise<{ id: string; videoJobId: string }> }) {
  const { id, videoJobId } = await params;
  const db = getDb();
  const row = db.prepare(`
    SELECT vj.localVideoPath, a.fileFingerprint, a.generatedJson
    FROM final_edit_groups g
    JOIN video_jobs vj ON vj.projectId=g.projectId AND vj.shotSetId=g.shotSetId
    LEFT JOIN final_edit_asset_analysis a ON a.videoJobId=vj.id
    WHERE g.id=? AND vj.id=? AND vj.status='succeeded'
  `).get(id, videoJobId) as { localVideoPath: string; fileFingerprint: string | null; generatedJson: string | null } | undefined;
  if (!row?.localVideoPath) return NextResponse.json({ error: 'asset_not_found' }, { status: 404 });
  try {
    const generated = JSON.parse(row.generatedJson || '{}') as { coverFrameTimesUs?: unknown[] };
    const frameUs = Math.max(100_000, Number(generated.coverFrameTimesUs?.[0] || 100_000));
    const frame = await materializeVideoFrame({
      storageRoot: path.join(dataRoot(), 'storage'),
      sourcePath: row.localVideoPath,
      cacheNamespace: `thumbnails/${id}`,
      cacheKey: `${videoJobId}:${row.fileFingerprint || ''}:${frameUs}`,
      frameUs,
    });
    return mediaResponse(request, frame.relativePath, 'image/jpeg');
  } catch (error) {
    return NextResponse.json({ error: 'thumbnail_failed', message: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
