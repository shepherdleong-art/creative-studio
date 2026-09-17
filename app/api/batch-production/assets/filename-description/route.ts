import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { extractAssetFilenameDescriptions } from '@/lib/batch-production/filename-analysis';
import { assertBatchApiReady } from '@/lib/batch-production/runtime-readiness';
import { BATCH_NO_STORE_HEADERS, batchProjectIdFromRequest, batchRouteErrorResponse } from '../../batches/response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const projectId = batchProjectIdFromRequest(request);
  const body = await request.json().catch(() => null) as { assetIds?: unknown } | null;
  if (!projectId || !Array.isArray(body?.assetIds) || body.assetIds.some((id) => typeof id !== 'string')) {
    return NextResponse.json({ code: 'invalid_input', message: '缺少项目或素材列表' }, { status: 400, headers: BATCH_NO_STORE_HEADERS });
  }
  try {
    await assertBatchApiReady();
    const result = await extractAssetFilenameDescriptions(getDb(), projectId, body.assetIds as string[], request.signal);
    return NextResponse.json(result, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) {
    return batchRouteErrorResponse(error, 'filename_analysis_failed', '文件名描述提取失败');
  }
}
