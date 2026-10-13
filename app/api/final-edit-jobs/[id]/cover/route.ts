import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { mediaResponse } from '@/lib/final-edit/media-response';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const row = getDb().prepare(`SELECT status, outputJson FROM final_edit_jobs WHERE id=? AND kind='render'`).get(id) as { status: string; outputJson: string | null } | undefined;
  if (!row || row.status !== 'succeeded' || !row.outputJson) return NextResponse.json({ error: 'artifact_not_ready' }, { status: 404 });
  const output = JSON.parse(row.outputJson) as { coverRelativePath: string; publishedCoverRelativePath?: string; coverFilename?: string };
  const download = new URL(request.url).searchParams.get('download') === '1';
  const response = mediaResponse(request, output.publishedCoverRelativePath || output.coverRelativePath, 'image/jpeg', download ? output.coverFilename || `final-edit-cover-${id}.jpg` : undefined);
  // 包装任务会在渲染发布后原子覆盖封面文件（§C），同 URL 内容可变——禁缓存防 UI 显示旧素封面
  response.headers.set('Cache-Control', 'no-cache');
  return response;
}
