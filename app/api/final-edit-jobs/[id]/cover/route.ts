import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { mediaResponse } from '@/lib/final-edit/media-response';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const row = getDb().prepare(`SELECT status, outputJson FROM final_edit_jobs WHERE id=? AND kind='render'`).get(id) as { status: string; outputJson: string | null } | undefined;
  if (!row || row.status !== 'succeeded' || !row.outputJson) return NextResponse.json({ error: 'artifact_not_ready' }, { status: 404 });
  const output = JSON.parse(row.outputJson) as { coverRelativePath: string };
  return mediaResponse(request, output.coverRelativePath, 'image/jpeg', `final-edit-cover-${id}.jpg`);
}
