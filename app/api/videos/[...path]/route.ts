import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path: segments } = await params;

  // Path traversal protection
  const storageRoot = path.resolve(path.join(process.cwd(), 'storage'));
  const requested = path.join(storageRoot, ...segments);
  const resolved = path.resolve(requested);

  if (!resolved.startsWith(storageRoot + path.sep)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  if (!fs.existsSync(resolved)) {
    return NextResponse.json({ error: 'Video not found' }, { status: 404 });
  }

  const ext = path.extname(resolved).toLowerCase();
  if (!['.mp4', '.mov', '.webm'].includes(ext)) {
    return NextResponse.json({ error: 'Unsupported video format' }, { status: 400 });
  }

  const buffer = fs.readFileSync(resolved);
  const mimeMap: Record<string, string> = {
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.webm': 'video/webm',
  };

  return new NextResponse(buffer, {
    headers: {
      'Content-Type': mimeMap[ext] || 'video/mp4',
      'Content-Length': String(buffer.length),
      'Cache-Control': 'public, max-age=86400',
    },
  });
}
