import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { dataRoot } from '@/lib/data-root';
import { BrowserPreviewPendingError, ensureBrowserPreview } from '@/lib/video-browser-preview';
import { fileResponse } from '@/lib/media-core/file-response';
import { assertNoStorageSymlink } from '@/lib/media-core/storage-path';
import { authorizeManagedFileRead, registerManagedFile } from '@/lib/media-core/access-context';
import { ResourceAccessError } from '@/lib/team-service/resource-scopes';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';

async function __teamRouteGET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path: segments } = await params;
  const storageRoot = path.resolve(path.join(dataRoot(), 'storage'));
  const requested = path.join(storageRoot, ...segments);
  const resolved = path.resolve(requested);
  if (!resolved.startsWith(storageRoot + path.sep)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    assertNoStorageSymlink(storageRoot, path.relative(storageRoot, resolved));
    const ext = path.extname(resolved).toLowerCase();
    if (!['.mp4', '.mov', '.webm'].includes(ext)) {
      return NextResponse.json({ error: 'Unsupported video format' }, { status: 400 });
    }

    // server 必须先由登记文件反查授权实体，再 stat 或启动任何懒转码。
    const originalGrant = authorizeManagedFileRead(resolved);
    if (!fs.existsSync(resolved)) {
      return NextResponse.json({ error: 'Video not found' }, { status: 404 });
    }

    let served = resolved;
    if (
      new URL(request.url).searchParams.get('preview') === '1'
      && ext === '.mp4'
      && ['videos', 'final-edits', 'outputs'].some(dir => resolved.startsWith(path.join(storageRoot, dir) + path.sep))
    ) {
      served = await ensureBrowserPreview(resolved);
      if (originalGrant && served !== resolved) {
        // 04 只保留登记接缝；去重转码调度由 09 接管。
        registerManagedFile({
          absolutePath: served,
          mimeType: 'video/mp4',
          derivedFromFileId: originalGrant.fileId,
        });
      }
    }

    const mimeMap: Record<string, string> = {
      '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
    };
    return fileResponse(request, served, mimeMap[ext] || 'video/mp4');
  } catch (error) {
    if (error instanceof BrowserPreviewPendingError) {
      return NextResponse.json({ error: 'preview_pending', retryAfterMs: error.retryAfterMs }, { status: 202 });
    }
    if (error instanceof ResourceAccessError || (error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return NextResponse.json({ error: 'Video not found' }, { status: 404 });
    }
    return NextResponse.json({ error: 'Failed to read video' }, { status: 500 });
  }
}
export const GET = withTeamRoute('/api/videos/[...path]', 'GET', __teamRouteGET);
