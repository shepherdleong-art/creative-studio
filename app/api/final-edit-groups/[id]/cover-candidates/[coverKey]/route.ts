import path from 'node:path';
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { dataRoot } from '@/lib/data-root';
import { mediaResponse } from '@/lib/final-edit/media-response';

export async function GET(request: Request, { params }: { params: Promise<{ id: string; coverKey: string }> }) {
  const { id, coverKey } = await params;
  const group = getDb().prepare(`SELECT shotSetId FROM final_edit_groups WHERE id=?`).get(id) as { shotSetId: string } | undefined;
  if (!group || !coverKey.startsWith('image:')) return NextResponse.json({ error: 'cover_not_found' }, { status: 404 });
  const imageId = coverKey.slice('image:'.length);
  const row = getDb().prepare(`SELECT ia.path, ia.mimeType FROM image_assets ia JOIN shots s ON s.latestGeneratedImageId=ia.id WHERE ia.id=? AND s.shotSetId=? LIMIT 1`).get(imageId, group.shotSetId) as { path: string; mimeType: string } | undefined;
  if (!row) return NextResponse.json({ error: 'cover_not_found' }, { status: 404 });
  const relative = path.relative(path.join(dataRoot(), 'storage'), row.path);
  return mediaResponse(request, relative, row.mimeType || 'image/png');
}
