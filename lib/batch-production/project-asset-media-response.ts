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
): Response {
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  const fd = fs.openSync(absolutePath, fs.constants.O_RDONLY | noFollow);
  const stat = fs.fstatSync(fd);
  if (!stat.isFile() || (expectedIdentity && !matchesProjectAssetFileIdentity(stat, expectedIdentity))) {
    fs.closeSync(fd);
    throw new Error('素材文件在最终打开时发生变化');
  }
  const size = stat.size;
  const baseHeaders: Record<string, string> = {
    ...PROJECT_ASSET_MEDIA_HEADERS,
    'Content-Type': contentType,
    ...extraHeaders,
  };
  const range = request.headers.get('range');
  if (!range) {
    return new Response(
      Readable.toWeb(fs.createReadStream(absolutePath, { fd, autoClose: true })) as ReadableStream<Uint8Array>,
      { headers: { ...baseHeaders, 'Content-Length': String(size) } },
    );
  }

  const rangeError = (): Response => {
    fs.closeSync(fd);
    return new Response('Range Not Satisfiable', {
      status: 416,
      headers: { ...PROJECT_ASSET_MEDIA_HEADERS, 'Content-Range': `bytes */${size}` },
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
  return new Response(
    Readable.toWeb(fs.createReadStream(absolutePath, { fd, autoClose: true, start, end })) as ReadableStream<Uint8Array>,
    {
      status: 206,
      headers: {
        ...baseHeaders,
        'Content-Length': String(length),
        'Content-Range': `bytes ${start}-${end}/${size}`,
      },
    },
  );
}
