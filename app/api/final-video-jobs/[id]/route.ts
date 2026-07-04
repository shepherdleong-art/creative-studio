import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getDb } from '@/lib/db';
import { dataRoot } from '@/lib/data-root';
import { FinalVideoJobRow } from '@/lib/final-video/types';
import { toStorageImageUrl, toStorageVideoUrl } from '@/lib/storage-url';

export const runtime = 'nodejs';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const row = getDb().prepare(`SELECT * FROM final_video_jobs WHERE id = ?`).get(id) as FinalVideoJobRow | undefined;
  if (!row) return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  return NextResponse.json({
    job: { ...row, outputUrl: toStorageVideoUrl(row.outputPath), coverUrl: toStorageImageUrl(row.coverPath) },
  });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = getDb();
  const row = db.prepare(`SELECT status FROM final_video_jobs WHERE id = ?`).get(id) as { status: string } | undefined;
  if (!row) return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  if (row.status === 'running') return NextResponse.json({ error: '任务执行中，不能删除' }, { status: 409 });

  const jobDir = path.join(dataRoot(), 'storage', 'final-videos', id);
  const storageRoot = path.resolve(path.join(dataRoot(), 'storage'));
  if (path.resolve(jobDir).startsWith(storageRoot + path.sep)) {
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
  db.prepare(`DELETE FROM final_video_jobs WHERE id = ?`).run(id);
  return NextResponse.json({ success: true });
}
