import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { mediaResponse } from '@/lib/final-edit/media-response';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const row = getDb().prepare(`SELECT status, outputJson FROM final_edit_jobs WHERE id=? AND kind='render'`).get(id) as { status: string; outputJson: string | null } | undefined;
  if (!row || row.status !== 'succeeded' || !row.outputJson) return NextResponse.json({ error: 'artifact_not_ready' }, { status: 404 });
  const output = JSON.parse(row.outputJson) as { videoRelativePath: string; publishedVideoRelativePath?: string; videoFilename?: string };
  const download = new URL(request.url).searchParams.get('download') === '1';
  return mediaResponse(request, output.publishedVideoRelativePath || output.videoRelativePath, 'video/mp4', download ? output.videoFilename || `final-edit-${id}.mp4` : undefined);
}
