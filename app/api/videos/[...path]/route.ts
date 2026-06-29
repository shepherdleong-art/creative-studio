import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { dataRoot } from '@/lib/data-root';

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
    let start = parseInt(parts[0], 10);
    let end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    // Guard against NaN from suffix-byte ranges (bytes=-500) or malformed headers
    if (!Number.isFinite(start)) start = 0;

    // Handle suffix-byte-range: "bytes=-500" → last 500 bytes (RFC 7233 §2.1)
    // Must run BEFORE the 416 guard so end gets recalibrated too.
    if (rangeHeader.includes('=-')) {
      const suffixLen = parseInt(parts[1], 10) || 0;
      start = Math.max(0, fileSize - suffixLen);
      end = fileSize - 1;
    }

    if (!Number.isFinite(end) || end >= fileSize) {
      return new NextResponse('Range Not Satisfiable', {
        status: 416,
        headers: { 'Content-Range': `bytes */${fileSize}` },
      });
    }
    if (start >= fileSize) {
      return new NextResponse('Range Not Satisfiable', {
        status: 416,
        headers: { 'Content-Range': `bytes */${fileSize}` },
      });
    }

    const chunkSize = end - start + 1;
    const buffer = Buffer.alloc(Math.min(chunkSize, fileSize - start));
    const fd = fs.openSync(resolved, 'r');
    try {
      fs.readSync(fd, buffer, 0, buffer.length, start);
    } finally {
      fs.closeSync(fd);
    }

    return new NextResponse(buffer, {
      status: 206,
      headers: {
        'Content-Type': mimeType,
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Content-Length': String(buffer.length),
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
