import path from 'node:path';
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { dataRoot } from '@/lib/data-root';
import { CoverFrameError, materializeCoverFrame } from '@/lib/final-edit/cover-frame';
import { mediaResponse } from '@/lib/final-edit/media-response';
import type { OutputPresetId } from '@/lib/final-edit/types';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const query = new URL(request.url).searchParams;
  const sourceKey = query.get('sourceKey') || '';
  const rawTimeUs = query.get('timeUs');
  const timeUs = rawTimeUs == null || rawTimeUs === '' ? 0 : Number(rawTimeUs);
  const preset = (query.get('preset') || '') as OutputPresetId;
  try {
    const frame = await materializeCoverFrame({
      db: getDb(),
      storageRoot: path.join(dataRoot(), 'storage'),
      groupId: id,
      sourceKey,
      timeUs,
      preset,
    });
    return mediaResponse(request, frame.relativePath, 'image/jpeg');
  } catch (error) {
    if (error instanceof CoverFrameError) {
      return NextResponse.json({ error: error.code }, { status: error.status });
    }
    return NextResponse.json({ error: 'cover_frame_failed' }, { status: 500 });
  }
}
