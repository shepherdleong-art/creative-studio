import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { mediaResponse } from '@/lib/final-edit/media-response';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const row = getDb().prepare(`SELECT relativePath, format FROM final_edit_bgm_tracks WHERE id=? AND status='ready'`).get((await params).id) as { relativePath: string; format: string } | undefined;
  if (!row) return NextResponse.json({ error: 'bgm_not_found' }, { status: 404 });
  const mime: Record<string, string> = { mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', ogg: 'audio/ogg' };
  return mediaResponse(request, row.relativePath, mime[row.format] || 'application/octet-stream');
}
