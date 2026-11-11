import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { mediaResponse } from '@/lib/final-edit/media-response';
import { ensurePackagedArtifactRegistered } from '@/lib/final-edit/project-artifacts';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';


async function __teamRouteGET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();
  const row = db.prepare(`SELECT projectId, kind, status, outputJson FROM final_edit_jobs WHERE id=? AND kind IN ('render','packaging')`).get(id) as { projectId: string; kind: string; status: string; outputJson: string | null } | undefined;
  if (!row || row.status !== 'succeeded' || !row.outputJson) return NextResponse.json({ error: 'artifact_not_ready' }, { status: 404 });
  const output = JSON.parse(row.outputJson) as { videoRelativePath: string; publishedVideoRelativePath?: string; videoFilename?: string };
  const relativePath = output.publishedVideoRelativePath || output.videoRelativePath;
  if (row.kind === 'packaging') ensurePackagedArtifactRegistered(db, { projectId: row.projectId, sourceJobId: id, relativePath });
  const download = new URL(request.url).searchParams.get('download') === '1';
  return mediaResponse(request, relativePath, 'video/mp4', download ? output.videoFilename || `final-edit-${id}.mp4` : undefined);
}
export const GET = withTeamRoute('/api/final-edit-jobs/[id]/video', 'GET', __teamRouteGET);
