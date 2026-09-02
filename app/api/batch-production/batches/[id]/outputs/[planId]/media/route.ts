import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { resolveBatchOutputMedia, resolveBatchOutputNarrationAudio } from '@/lib/batch-production/output-media';
import { assertBatchApiReady } from '@/lib/batch-production/runtime-readiness';
import {
  BATCH_NO_STORE_HEADERS,
  batchProjectIdFromRequest,
  batchRouteErrorResponse,
} from '../../../../response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function serveMedia(request: NextRequest, filePath: string, contentType: string, extra: Record<string, string>): NextResponse {
  const size = fs.statSync(filePath).size;
  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    ...extra,
  };
  const range = request.headers.get('range');
  if (!range) {
    headers['Content-Length'] = String(size);
    return new NextResponse(Readable.toWeb(fs.createReadStream(filePath)) as ReadableStream<Uint8Array>, { headers });
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match || (!match[1] && !match[2])) {
    return new NextResponse('Range Not Satisfiable', {
      status: 416,
      headers: { ...headers, 'Content-Range': `bytes */${size}` },
    });
  }
  if ((!match[1] && Number(match[2]) <= 0) || (match[1] && !Number.isSafeInteger(Number(match[1])))) {
    return new NextResponse('Range Not Satisfiable', {
      status: 416,
      headers: { ...headers, 'Content-Range': `bytes */${size}` },
    });
  }
  let start = match[1] ? Number(match[1]) : 0;
  let end = match[2] ? Number(match[2]) : size - 1;
  if (!match[1]) {
    const suffix = Number(match[2]);
    start = Math.max(0, size - suffix);
    end = size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) {
    return new NextResponse('Range Not Satisfiable', {
      status: 416,
      headers: { ...headers, 'Content-Range': `bytes */${size}` },
    });
  }
  end = Math.min(end, size - 1);
  const length = end - start + 1;
  return new NextResponse(
    Readable.toWeb(fs.createReadStream(filePath, { start, end })) as ReadableStream<Uint8Array>,
    {
      status: 206,
      headers: {
        ...headers,
        'Content-Length': String(length),
        'Content-Range': `bytes ${start}-${end}/${size}`,
      },
    },
  );
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string; planId: string }> },
) {
  const { id: batchId, planId } = await context.params;
  const projectId = batchProjectIdFromRequest(request);
  if (!projectId) {
    return NextResponse.json({ error: 'missing_project_id', message: '缺少 projectId 参数' }, {
      status: 400,
      headers: BATCH_NO_STORE_HEADERS,
    });
  }
  const kind = request.nextUrl.searchParams.get('kind') ?? 'video';
  const source = request.nextUrl.searchParams.get('source') ?? 'candidate';
  const outputVersionId = request.nextUrl.searchParams.get('outputVersionId') ?? undefined;
  const renderAttemptId = request.nextUrl.searchParams.get('renderAttemptId') ?? undefined;
  const artifactId = request.nextUrl.searchParams.get('artifactId') ?? undefined;
  if ((kind !== 'video' && kind !== 'cover' && kind !== 'narration') || (source !== 'candidate' && source !== 'artifact')) {
    return NextResponse.json({ error: 'invalid_media_query', message: 'kind 或 source 参数无效' }, {
      status: 400,
      headers: BATCH_NO_STORE_HEADERS,
    });
  }
  // 代际参数格式无效直接 400;不存在/谱系不符/非成功统一由解析器回 404。
  if ((renderAttemptId && !UUID_PATTERN.test(renderAttemptId)) || (artifactId && !UUID_PATTERN.test(artifactId))) {
    return NextResponse.json({ error: 'invalid_media_query', message: 'renderAttemptId 或 artifactId 参数格式无效' }, {
      status: 400,
      headers: BATCH_NO_STORE_HEADERS,
    });
  }
  // 口播音频只按当前候选版本 arrangement 的值解析;正式产物没有独立的口播概念。
  if (kind === 'narration' && source !== 'candidate') {
    return NextResponse.json({ error: 'invalid_media_query', message: '口播音频只支持候选来源(source=candidate)' }, {
      status: 400,
      headers: BATCH_NO_STORE_HEADERS,
    });
  }
  try {
    await assertBatchApiReady();
    if (kind === 'narration') {
      const narration = resolveBatchOutputNarrationAudio(getDb(), projectId, batchId, planId);
      return serveMedia(request, narration.absolutePath, narration.contentType, {
        'X-Batch-Media-Source': 'candidate',
      });
    }
    const media = resolveBatchOutputMedia(
      getDb(), projectId, batchId, planId, kind, source,
      undefined, outputVersionId, renderAttemptId, artifactId,
    );
    const extra: Record<string, string> = {
      'X-Batch-Media-Source': media.source,
      'X-Batch-Production-Ready': media.productionReady ? '1' : '0',
    };
    // download=1:让浏览器走「另存为」而不是内联播放,用户可自行选择保存位置。
    // candidate 是"最新渲染预览",文件名由服务端拼成可辨认的「成片-<序号>-v<版本>-预览」,
    // 不再沿用渲染目录里的通用 basename;artifact 沿用导出命名合约生成的 basename。
    // 无论哪种都只接受服务端生成的名字,绝不接受浏览器传入的文件名。
    if (request.nextUrl.searchParams.get('download') === '1') {
      let filename: string;
      if (media.source === 'candidate') {
        const suffix = kind === 'cover' ? '-封面.jpg' : '.mp4';
        filename = `成片-${String(media.planSeq).padStart(2, '0')}-v${media.outputVersionNumber}-预览${suffix}`;
      } else {
        filename = path.basename(media.absolutePath);
      }
      extra['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`;
    }
    return serveMedia(request, media.absolutePath, media.contentType, extra);
  } catch (error) {
    return batchRouteErrorResponse(error, 'batch_output_media_failed', '成片媒体读取失败');
  }
}
