import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { mediaResponse } from '@/lib/final-edit/media-response';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const row = getDb().prepare(`SELECT narrationAudioPath FROM final_edit_groups WHERE id=?`).get((await params).id) as { narrationAudioPath: string | null } | undefined;
  if (!row?.narrationAudioPath) return NextResponse.json({ error: 'narration_not_ready' }, { status: 404 });
  return mediaResponse(request, row.narrationAudioPath, 'audio/wav');
}
