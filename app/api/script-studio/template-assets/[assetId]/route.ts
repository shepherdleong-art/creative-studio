import fs from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { dataRoot } from '@/lib/data-root';
import { assertScriptStudioApiReady, errorResponse } from '@/lib/script-studio/http';
import { assertNoStorageSymlink } from '@/lib/media-core/storage-path';

export const runtime = 'nodejs';

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ assetId: string }> },
) {
  try {
    await assertScriptStudioApiReady();
    const { assetId } = await params;
    const row = getDb().prepare(`SELECT relativePath FROM script_studio_template_assets WHERE id = ?`).get(assetId) as { relativePath: string } | undefined;
    if (!row) {
      return NextResponse.json({ error: 'not_found', message: '参考图不存在' }, { status: 404 });
    }
    const storageRoot = path.resolve(path.join(dataRoot(), 'storage'));
    // 受控路径 + symlink 守卫：所有资产读取必须经受控路径与 symlink 守卫
    const absolutePath = assertNoStorageSymlink(storageRoot, row.relativePath);
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
      return NextResponse.json({ error: 'not_found', message: '参考图文件缺失' }, { status: 404 });
    }
    const extension = path.extname(absolutePath).replace('.', '').toLowerCase();
    const contentType = MIME_BY_EXT[extension] ?? 'application/octet-stream';
    const body = fs.readFileSync(absolutePath);
    return new NextResponse(new Uint8Array(body), {
      headers: { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=3600' },
    });
  } catch (error) {
    const { status, body } = errorResponse(error);
    return NextResponse.json(body, { status });
  }
}
