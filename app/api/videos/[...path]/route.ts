import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { dataRoot } from '@/lib/data-root';
import { ensureBrowserPreview } from '@/lib/video-browser-preview';
import { fileResponse } from '@/lib/media-core/file-response';
import { assertNoStorageSymlink } from '@/lib/media-core/storage-path';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path: segments } = await params;

  // Path traversal protection
  const storageRoot = path.resolve(path.join(dataRoot(), 'storage'));
  const requested = path.join(storageRoot, ...segments);
  const resolved = path.resolve(requested);

  if (!resolved.startsWith(storageRoot + path.sep)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try { assertNoStorageSymlink(storageRoot, path.relative(storageRoot, resolved)); }
  catch { return NextResponse.json({ error: 'Forbidden' }, { status: 403 }); }

  if (!fs.existsSync(resolved)) {
    return NextResponse.json({ error: 'Video not found' }, { status: 404 });
  }

  const ext = path.extname(resolved).toLowerCase();
  if (!['.mp4', '.mov', '.webm'].includes(ext)) {
    return NextResponse.json({ error: 'Unsupported video format' }, { status: 400 });
  }

  // 浏览器播放入口（?preview=1）：HEVC/10bit 原件浏览器放不动，换成（必要时
  // 懒生成的）H.264 预览衍生物；不带参数的 GET 始终给原件，下载链路不受影响。
  // 覆盖任务视频、精剪产物和同步素材，其他目录仍按原件读取。
  let served = resolved;
  if (
    request.nextUrl.searchParams.get('preview') === '1'
    && ext === '.mp4'
    && ['videos', 'final-edits', 'outputs'].some(dir => resolved.startsWith(path.join(storageRoot, dir) + path.sep))
  ) {
    served = await ensureBrowserPreview(resolved);
  }

  const mimeMap: Record<string, string> = {
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.webm': 'video/webm',
  };
  const mimeType = mimeMap[ext] || 'video/mp4';

  return fileResponse(request, served, mimeType);
}
