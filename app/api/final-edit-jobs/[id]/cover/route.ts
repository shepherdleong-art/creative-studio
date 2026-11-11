import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { mediaResponse } from '@/lib/final-edit/media-response';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';


async function __teamRouteGET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const row = getDb().prepare(`SELECT status, outputJson FROM final_edit_jobs WHERE id=? AND kind IN ('render','packaging')`).get(id) as { status: string; outputJson: string | null } | undefined;
  if (!row || row.status !== 'succeeded' || !row.outputJson) return NextResponse.json({ error: 'artifact_not_ready' }, { status: 404 });
  const output = JSON.parse(row.outputJson) as { coverRelativePath: string; publishedCoverRelativePath?: string; coverFilename?: string };
  const relativePath = output.publishedCoverRelativePath || output.coverRelativePath;
  if (!relativePath) return NextResponse.json({ error: 'artifact_not_ready' }, { status: 404 });
  const download = new URL(request.url).searchParams.get('download') === '1';
  const response = mediaResponse(request, relativePath, 'image/jpeg', download ? output.coverFilename || `final-edit-cover-${id}.jpg` : undefined);
  // 包装完成后此 URL 指向新封面版本，每次访问重新校验当前指针。
  response.headers.set('Cache-Control', 'no-cache');
  return response;
}
export const GET = withTeamRoute('/api/final-edit-jobs/[id]/cover', 'GET', __teamRouteGET);
