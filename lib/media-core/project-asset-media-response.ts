import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { authorizeManagedFileRead, type ManagedFileGrant } from './access-context.ts';

export const PROJECT_ASSET_MEDIA_HEADERS = {
  'Cache-Control': 'no-store, private',
  'Accept-Ranges': 'bytes',
};

export interface ProjectAssetFileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

export interface ProjectAssetMediaResponseOptions {
  cacheControl?: string;
  /** 强 ETag(带双引号)。传入后启用 If-None-Match / If-Range。 */
  etag?: string;
  onClose?: () => void;
  grant?: ManagedFileGrant;
}

export function buildMediaEtag(parts: string[]): string {
  return `"${createHash('sha1').update(parts.join('\0')).digest('hex')}"`;
}

function ifNoneMatchMatches(headerValue: string, etag: string): boolean {
  if (headerValue.trim() === '*') return true;
  return headerValue.split(',').some((candidate) => candidate.trim() === etag);
}

export const PROJECT_ASSET_THUMBNAIL_HEADERS = {
  'Cache-Control': 'public, max-age=31536000, immutable',
};

function matchesIdentity(stat: fs.Stats, expected: ProjectAssetFileIdentity): boolean {
  return stat.dev === expected.dev && stat.ino === expected.ino
    && stat.size === expected.size && stat.mtimeMs === expected.mtimeMs;
}

/** 流式完整/Range/条件响应；fd 最终打开后核验身份，避免检查与读取之间被替换。 */
export function projectAssetMediaResponse(
  request: Request,
  absolutePath: string,
  contentType: string,
  extraHeaders: Record<string, string> = {},
  expectedIdentity?: ProjectAssetFileIdentity,
  options: ProjectAssetMediaResponseOptions = {},
): Response {
  const grant = options.grant ?? authorizeManagedFileRead(absolutePath);
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  const fd = fs.openSync(absolutePath, fs.constants.O_RDONLY | noFollow);
  const stat = fs.fstatSync(fd);
  if (!stat.isFile() || (expectedIdentity && !matchesIdentity(stat, expectedIdentity))) {
    fs.closeSync(fd);
    throw new Error('素材文件在最终打开时发生变化');
  }
  const size = stat.size;
  const cacheControl = grant ? 'private, no-store' : options.cacheControl ?? PROJECT_ASSET_MEDIA_HEADERS['Cache-Control'];
  const etag = options.etag ?? (grant
    ? `"${createHash('sha256').update(`${grant.fileId}\0${grant.version}\0${grant.sha256}`).digest('hex')}"`
    : undefined);
  const baseHeaders: Record<string, string> = {
    'Cache-Control': cacheControl,
    'Accept-Ranges': 'bytes',
    ...(etag ? { ETag: etag } : {}),
    'Content-Type': contentType,
    ...extraHeaders,
  };
  const attachOnClose = (stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> => {
    if (!options.onClose) return stream;
    let closed = false;
    const closeOnce = () => {
      if (closed) return;
      closed = true;
      options.onClose?.();
    };
    return new ReadableStream<Uint8Array>({
      start(controller) {
        const pipe = stream.pipeTo(new WritableStream<Uint8Array>({
          write(chunk) { controller.enqueue(chunk); },
          close() { closeOnce(); controller.close(); },
          abort(reason) { closeOnce(); controller.error(reason); },
        }));
        pipe.catch(() => {
          closeOnce();
          controller.error(new Error('媒体流中断'));
        });
      },
      cancel(reason) {
        closeOnce();
        return stream.cancel(reason);
      },
    });
  };

  if (etag) {
    const ifNoneMatch = request.headers.get('if-none-match');
    if (ifNoneMatch !== null && ifNoneMatchMatches(ifNoneMatch, etag)) {
      fs.closeSync(fd);
      return new Response(null, { status: 304, headers: baseHeaders });
    }
  }

  const range = request.headers.get('range');
  const ifRange = etag ? request.headers.get('if-range') : null;
  const rangeEffective = range !== null && (ifRange === null || ifRange.trim() === etag);
  if (!rangeEffective) {
    const stream = Readable.toWeb(fs.createReadStream(absolutePath, { fd, autoClose: true })) as ReadableStream<Uint8Array>;
    return new Response(attachOnClose(stream), { headers: { ...baseHeaders, 'Content-Length': String(size) } });
  }

  const rangeError = (): Response => {
    fs.closeSync(fd);
    return new Response('Range Not Satisfiable', {
      status: 416,
      headers: { ...baseHeaders, 'Content-Range': `bytes */${size}` },
    });
  };
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match || (!match[1] && !match[2])) return rangeError();
  let start = match[1] ? Number.parseInt(match[1], 10) : 0;
  let end = match[1] && match[2] ? Number.parseInt(match[2], 10) : size - 1;
  if (!match[1]) {
    const suffixLength = Number.parseInt(match[2], 10);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return rangeError();
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else if (Number.isFinite(end)) {
    end = Math.min(end, size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
    || start < 0 || end < start || start >= size || end >= size) return rangeError();
  const length = end - start + 1;
  const stream = Readable.toWeb(fs.createReadStream(absolutePath, { fd, autoClose: true, start, end })) as ReadableStream<Uint8Array>;
  return new Response(attachOnClose(stream), {
    status: 206,
    headers: {
      ...baseHeaders,
      'Content-Length': String(length),
      'Content-Range': `bytes ${start}-${end}/${size}`,
    },
  });
}
