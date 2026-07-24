import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { dataRoot } from '@/lib/data-root';
import { probeVideoMedia } from '@/lib/ffmpeg';
import { mediaResponse } from '@/lib/final-edit/media-response';
import { findModule4Video } from '@/lib/final-edit/module4-asset';
import { resolveStoragePath } from '@/lib/final-edit/storage-path';
import { materializeVideoFrame } from '@/lib/final-edit/video-frame';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; shotSetId: string; videoJobId: string }> },
) {
  const { id: projectId, shotSetId, videoJobId } = await params;
  const row = findModule4Video(getDb(), { projectId, shotSetId, videoJobId });
  if (!row) {
    return NextResponse.json({ error: 'asset_not_found', message: '当前分镜组中没有这个可用视频' }, { status: 404 });
  }

  try {
    const storageRoot = path.join(dataRoot(), 'storage');
    const absolutePath = resolveStoragePath(storageRoot, row.localVideoPath, { allowAbsolute: true });
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
      return NextResponse.json({ error: 'asset_missing', message: '视频文件已丢失，请返回模块 4 重新生成' }, { status: 404 });
    }
    const media = await probeVideoMedia(absolutePath);
    const frameUs = Math.max(0, Math.min(1_000_000, Math.floor(media.durationUs * 0.1)));
    const stat = fs.statSync(absolutePath);
    const scopeHash = crypto.createHash('sha256').update(`${projectId}:${shotSetId}:${videoJobId}`).digest('hex');
    const frame = await materializeVideoFrame({
      storageRoot,
      sourcePath: row.localVideoPath,
      cacheNamespace: `thumbnails/module4/${scopeHash}`,
      cacheKey: `${scopeHash}:${stat.mtimeMs}:${stat.size}:${frameUs}`,
      frameUs,
    });
    return mediaResponse(request, frame.relativePath, 'image/jpeg');
  } catch {
    return NextResponse.json({ error: 'thumbnail_failed', message: '无法生成视频缩略图' }, { status: 500 });
  }
}
