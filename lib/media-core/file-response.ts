import fs from 'node:fs';
import { Readable } from 'node:stream';

/** Stream only the requested bytes; seeking must not allocate or read a whole film. */
export function fileResponse(request: Request, file: string, contentType: string): Response {
  const size = fs.statSync(file).size;
  const headers = { 'Content-Type': contentType, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600' };
  const range = request.headers.get('range');
  if (!size && !range) return new Response(null, { headers: { ...headers, 'Content-Length': '0' } });
  let start = 0, end = size - 1;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    const invalid = () => new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } });
    if (!match || (!match[1] && !match[2])) return invalid();
    start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
    end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return invalid();
  }
  const stream = fs.createReadStream(file, { start, end });
  return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
    status: range ? 206 : 200,
    headers: { ...headers, 'Content-Length': String(end - start + 1), ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) },
  });
}
