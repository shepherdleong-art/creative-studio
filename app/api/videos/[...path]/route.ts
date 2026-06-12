import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export async function GET(
  request: NextRequest,
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

  const mimeMap: Record<string, string> = {
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.webm': 'video/webm',
  };
  const mimeType = mimeMap[ext] || 'video/mp4';

  const stat = fs.statSync(resolved);
  const fileSize = stat.size;

  // ── Range request support (required for <video> playback) ──
  const rangeHeader = request.headers.get('range');
  if (rangeHeader) {
    const parts = rangeHeader.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    if (start >= fileSize || end >= fileSize) {
      return new NextResponse('Range Not Satisfiable', {
        status: 416,
        headers: { 'Content-Range': `bytes */${fileSize}` },
      });
    }

    const chunkSize = end - start + 1;
    const buffer = Buffer.alloc(chunkSize);
    const fd = fs.openSync(resolved, 'r');
    fs.readSync(fd, buffer, 0, chunkSize, start);
    fs.closeSync(fd);

    return new NextResponse(buffer, {
      status: 206,
      headers: {
        'Content-Type': mimeType,
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Content-Length': String(chunkSize),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=86400',
      },
    });
  }

  // ── Full file response (for download) ──
  const buffer = fs.readFileSync(resolved);
  return new NextResponse(buffer, {
    headers: {
      'Content-Type': mimeType,
      'Content-Length': String(fileSize),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=86400',
    },
  });
}
