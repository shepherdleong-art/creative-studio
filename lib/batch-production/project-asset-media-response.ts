import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import {
  matchesProjectAssetFileIdentity,
  type ProjectAssetFileIdentity,
} from './project-asset-media.ts';

export const PROJECT_ASSET_MEDIA_HEADERS = {
  'Cache-Control': 'no-store, private',
  'Accept-Ranges': 'bytes',
};

export interface ProjectAssetMediaResponseOptions {
  /** 覆盖默认 Cache-Control(no-store, private)。 */
  cacheControl?: string;
  /** 强 ETag(带双引号的完整值)。传入后启用 If-None-Match / If-Range 条件请求;Range 不接受弱验证器,不许带 `W/` 前缀。 */
  etag?: string;
  /** 返回的读流 close/error 时恰好调用一次,供调用方把资源租约活到流结束。早退分支(304/416)不经过流,不会触发。 */
  onClose?: () => void;
}

/** sha1(parts.join('\0')) → `"<hex>"`,纯函数、同输入同输出,作为媒体响应的强 ETag。NUL 作分隔符:输入项本身不可能含 NUL,避免相邻项边界串扰。 */
export function buildMediaEtag(parts: string[]): string {
  return `"${createHash('sha1').update(parts.join('\0')).digest('hex')}"`;
}

/** RFC 9110 If-None-Match 命中判断:`*` 或逗号分隔列表中存在相等项。 */
function ifNoneMatchMatches(headerValue: string, etag: string): boolean {
  if (headerValue.trim() === '*') return true;
  return headerValue.split(',').some((candidate) => candidate.trim() === etag);
}

/**
 * 缩略图响应头:URL 已按内容指纹版本化(见 prepare 的 thumbnailUrl v 参数),
 * 缓存文件确定性发布后不可变,浏览器可以放心长缓存。
 */
export const PROJECT_ASSET_THUMBNAIL_HEADERS = {
  'Cache-Control': 'public, max-age=31536000, immutable',
};

/**
 * 以 ReadableStream 流式服务项目素材，不把整段视频读入内存。
 * Range 解析只接受单一 bytes=start-end 区间，非法范围返回 416。
 */
export function projectAssetMediaResponse(
  request: Request,
  absolutePath: string,
  contentType: string,
  extraHeaders: Record<string, string> = {},
  expectedIdentity?: ProjectAssetFileIdentity,
  options: ProjectAssetMediaResponseOptions = {},
): Response {
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  const fd = fs.openSync(absolutePath, fs.constants.O_RDONLY | noFollow);
  const stat = fs.fstatSync(fd);
  if (!stat.isFile() || (expectedIdentity && !matchesProjectAssetFileIdentity(stat, expectedIdentity))) {
    fs.closeSync(fd);
    throw new Error('素材文件在最终打开时发生变化');
  }
  const size = stat.size;
  const cacheControl = options.cacheControl ?? PROJECT_ASSET_MEDIA_HEADERS['Cache-Control'];
  const etag = options.etag;
  const baseHeaders: Record<string, string> = {
    'Cache-Control': cacheControl,
    'Accept-Ranges': 'bytes',
    ...(etag ? { ETag: etag } : {}),
    'Content-Type': contentType,
    ...extraHeaders,
  };
  // 流结束(成功读完或出错)时释放调用方资源,恰好一次。
  const attachOnClose = (stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> => {
    if (!options.onClose) return stream;
    let closed = false;
    const closeOnce = () => {
      if (closed) return;
      closed = true;
      options.onClose?.();
    };
    // Readable.toWeb 产出的流:读取器 cancel 会冒泡到底层 Node 流的 close/error。
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

  // 条件请求(仅在传入 etag 时启用):If-None-Match 命中 → 304 空 body,不带 Content-Length/Content-Range。
  if (etag) {
    const ifNoneMatch = request.headers.get('if-none-match');
    if (ifNoneMatch !== null && ifNoneMatchMatches(ifNoneMatch, etag)) {
      fs.closeSync(fd);
      return new Response(null, { status: 304, headers: baseHeaders });
    }
  }

  const range = request.headers.get('range');
  // If-Range 与 etag 不等 → 忽略 Range,退回 200 全量流(不是 416)。
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
  if (!match || (!match[1] && !match[2])) {
    return rangeError();
  }
  let start = match[1] ? Number.parseInt(match[1], 10) : 0;
  let end = match[1] && match[2] ? Number.parseInt(match[2], 10) : size - 1;
  if (!match[1]) {
    const suffixLength = Number.parseInt(match[2], 10);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return rangeError();
    }
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else if (Number.isFinite(end)) {
    end = Math.min(end, size - 1);
  }
  if (
    !Number.isFinite(start)
    || !Number.isFinite(end)
    || start < 0
    || end < start
    || start >= size
    || end >= size
  ) {
    return rangeError();
  }
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
