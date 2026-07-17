import path from 'node:path';
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { dataRoot } from '@/lib/data-root';
import { resolveCoverCandidateFile } from '@/lib/final-edit/cover-candidates';
import { mediaResponse } from '@/lib/final-edit/media-response';

export async function GET(request: Request, { params }: { params: Promise<{ id: string; coverKey: string }> }) {
  const { id, coverKey } = await params;
  const db = getDb();
  const group = db.prepare(`SELECT id, projectId, shotSetId FROM final_edit_groups WHERE id=?`).get(id) as { id: string; projectId: string; shotSetId: string } | undefined;
  if (!group) return NextResponse.json({ error: 'cover_not_found' }, { status: 404 });
  try {
    const file = await resolveCoverCandidateFile({ db, storageRoot: path.join(dataRoot(), 'storage'), group, coverKey });
    return mediaResponse(request, file.relativePath, file.mimeType);
  } catch {
    return NextResponse.json({ error: 'cover_not_found' }, { status: 404 });
  }
}
