import path from 'node:path';
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { dataRoot } from '@/lib/data-root';
import { assertScriptStudioApiReady, errorResponse } from '@/lib/script-studio/http';
import { assertNoStorageSymlink } from '@/lib/media-core/storage-path';
import { fileResponse } from '@/lib/media-core/file-response';
import { ResourceAccessError } from '@/lib/team-service/resource-scopes';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';

export const runtime = 'nodejs';

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
};

async function __teamRouteGET(
  request: Request,
  { params }: { params: Promise<{ assetId: string }> },
) {
  try {
    await assertScriptStudioApiReady();
    const { assetId } = await params;
    const row = getDb().prepare(`SELECT relativePath FROM script_studio_template_assets WHERE id = ?`).get(assetId) as { relativePath: string } | undefined;
    if (!row) return NextResponse.json({ error: 'not_found', message: '参考图不存在' }, { status: 404 });
    const storageRoot = path.resolve(path.join(dataRoot(), 'storage'));
    const absolutePath = assertNoStorageSymlink(storageRoot, row.relativePath);
    const extension = path.extname(absolutePath).replace('.', '').toLowerCase();
    return fileResponse(request, absolutePath, MIME_BY_EXT[extension] ?? 'application/octet-stream', {
      cacheControl: 'public, max-age=3600',
    });
  } catch (error) {
    if (error instanceof ResourceAccessError || (error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return NextResponse.json({ error: 'not_found', message: '参考图不存在' }, { status: 404 });
    }
    const { status, body } = errorResponse(error);
    return NextResponse.json(body, { status });
  }
}
export const GET = withTeamRoute('/api/script-studio/template-assets/[assetId]', 'GET', __teamRouteGET);
