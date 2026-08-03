import fs from 'node:fs';
import { Readable } from 'node:stream';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { resolveBatchOutputMedia } from '@/lib/batch-production/output-media';
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
  if ((kind !== 'video' && kind !== 'cover') || (source !== 'candidate' && source !== 'artifact')) {
    return NextResponse.json({ error: 'invalid_media_query', message: 'kind 或 source 参数无效' }, {
      status: 400,
      headers: BATCH_NO_STORE_HEADERS,
    });
  }
  try {
    await assertBatchApiReady();
    const media = resolveBatchOutputMedia(getDb(), projectId, batchId, planId, kind, source);
    return serveMedia(request, media.absolutePath, media.contentType, {
      'X-Batch-Media-Source': media.source,
      'X-Batch-Production-Ready': media.productionReady ? '1' : '0',
    });
  } catch (error) {
    return batchRouteErrorResponse(error, 'batch_output_media_failed', '成片媒体读取失败');
  }
}
