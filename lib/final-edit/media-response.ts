import fs from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { dataRoot } from '../data-root';
import { resolveStoragePath } from './storage-path';

export function resolveFinalEditMedia(relativePath: string): string {
  const storageRoot = path.resolve(dataRoot(), 'storage');
  return resolveStoragePath(storageRoot, relativePath);
}

export function mediaResponse(request: Request, relativePath: string, contentType: string, downloadName?: string): NextResponse {
  const filePath = resolveFinalEditMedia(relativePath);
  if (!fs.existsSync(filePath)) return NextResponse.json({ error: 'artifact_missing' }, { status: 404 });
  const size = fs.statSync(filePath).size;
  const range = request.headers.get('range');
  const headers: Record<string, string> = { 'Content-Type': contentType, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600' };
  if (downloadName) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`;
  if (!range) { headers['Content-Length'] = String(size); return new NextResponse(fs.readFileSync(filePath), { headers }); }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) return new NextResponse('Range Not Satisfiable', { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2] || 0));
  let end = match[2] && match[1] ? Number(match[2]) : size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= size) return new NextResponse('Range Not Satisfiable', { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  end = Math.min(end, size - 1);
  const length = end - start + 1;
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(filePath, 'r');
  try { fs.readSync(fd, buffer, 0, length, start); } finally { fs.closeSync(fd); }
  return new NextResponse(buffer, { status: 206, headers: { ...headers, 'Content-Length': String(length), 'Content-Range': `bytes ${start}-${end}/${size}` } });
}
