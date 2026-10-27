// 贴纸静态资源：清单、WebP 缩略图与原始透明 PNG。
// GET /api/packaging/stickers/catalog.json
// GET /api/packaging/stickers/thumbs/<style>/<id>.webp
// GET /api/packaging/stickers/<style>/<id>.png
import fs from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { resolvePackagingDir } from '@/lib/media-core/packaging-runtime';

const MIME_BY_EXTENSION: Record<string, string> = {
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

function isSafeSegment(segment: string): boolean {
  return Boolean(segment) && segment !== '.' && segment !== '..' && !segment.includes('/') && !segment.includes('\\') && !segment.includes(':') && !segment.includes('\0');
}

function resolveWithin(root: string, segments: string[]): string | null {
  const resolved = path.resolve(root, ...segments);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return null;
  return resolved;
}

export async function GET(_request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path: segments } = await params;
  if (!segments?.length || segments.some((segment) => !isSafeSegment(segment))) {
    return NextResponse.json({ error: 'unsafe_path', message: '贴纸资源路径无效' }, { status: 400 });
  }
  const relativePath = segments.join('/');
  const extension = path.extname(relativePath).toLowerCase();
  const contentType = MIME_BY_EXTENSION[extension];
  if (!contentType || (extension === '.json' && relativePath !== 'catalog.json')) {
    return NextResponse.json({ error: 'unsupported_type', message: '不支持的贴纸资源类型' }, { status: 415 });
  }

  const stickersRoot = path.resolve(resolvePackagingDir(), 'stickers');
  const file = resolveWithin(stickersRoot, segments);
  const stat = file ? fs.statSync(file, { throwIfNoEntry: false }) : undefined;
  if (!file || !stat?.isFile()) {
    return NextResponse.json({ error: 'not_found', message: '贴纸资源不存在' }, { status: 404 });
  }
  const buffer = fs.readFileSync(file);
  return new Response(new Uint8Array(buffer), {
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(stat.size),
      'Cache-Control': extension === '.json' ? 'no-cache' : 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
