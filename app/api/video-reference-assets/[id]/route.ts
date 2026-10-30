import fs from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { dataRoot } from '@/lib/data-root';
import { fileResponse } from '@/lib/media-core/file-response';
import { assertNoStorageSymlink } from '@/lib/media-core/storage-path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface VideoReferenceAssetRow {
  id: string;
  projectId: string;
  path: string;
  mimeType: string;
}

function findAsset(id: string): VideoReferenceAssetRow | undefined {
  return getDb().prepare(`
    SELECT id, projectId, path, mimeType FROM video_reference_assets WHERE id = ?
  `).get(id) as VideoReferenceAssetRow | undefined;
}

function resolveAssetPath(asset: VideoReferenceAssetRow): string {
  if (!/^[A-Za-z0-9_-]+$/.test(asset.projectId) || !path.isAbsolute(asset.path)) throw new Error('Unsafe asset path');
  const storageRoot = path.resolve(dataRoot(), 'storage');
  const projectDirectory = path.resolve(storageRoot, 'video-references', asset.projectId);
  const resolved = path.resolve(asset.path);
  const relative = path.relative(projectDirectory, resolved);
  if (
    !relative
    || relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
    || relative.includes(path.sep)
  ) throw new Error('Unsafe asset path');
  return assertNoStorageSymlink(storageRoot, resolved, { allowAbsolute: true });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const asset = findAsset(id);
  if (!asset) return NextResponse.json({ error: 'Video reference asset not found' }, { status: 404 });

  let filePath: string;
  try {
    filePath = resolveAssetPath(asset);
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  try {
    if (!fs.statSync(filePath).isFile()) {
      return NextResponse.json({ error: 'Video reference asset file not found' }, { status: 404 });
    }
    return fileResponse(request, filePath, asset.mimeType);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return NextResponse.json({ error: 'Video reference asset file not found' }, { status: 404 });
    }
    return NextResponse.json({ error: 'Failed to read video reference asset' }, { status: 500 });
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const db = getDb();
  const asset = findAsset(id);
  if (!asset) return NextResponse.json({ error: 'Video reference asset not found' }, { status: 404 });

  let filePath: string;
  try {
    filePath = resolveAssetPath(asset);
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  if (db.prepare('SELECT 1 FROM video_job_references WHERE assetId = ? LIMIT 1').get(id)) {
    return NextResponse.json({ error: 'Video reference asset is used by a video job' }, { status: 409 });
  }

  try {
    db.prepare('DELETE FROM video_reference_assets WHERE id = ?').run(id);
  } catch (error) {
    if (String((error as { code?: string })?.code ?? '').startsWith('SQLITE_CONSTRAINT')) {
      return NextResponse.json({ error: 'Video reference asset is used by a video job' }, { status: 409 });
    }
    throw error;
  }

  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.error('[DELETE /api/video-reference-assets] Failed to unlink asset file:', error);
    }
  }
  return NextResponse.json({ success: true });
}
