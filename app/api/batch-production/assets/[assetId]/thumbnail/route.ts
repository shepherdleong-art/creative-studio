import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { assertBatchApiReady } from '@/lib/batch-production/runtime-readiness';
import {
  materializeProjectAssetThumbnail,
} from '@/lib/batch-production/project-asset-media';
import { projectAssetMediaResponse } from '@/lib/batch-production/project-asset-media-response';
import { BATCH_NO_STORE_HEADERS, batchRouteErrorResponse } from '../../../batches/response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ assetId: string }> },
) {
  const { assetId } = await context.params;
  const projectId = request.nextUrl.searchParams.get('projectId');
  if (!projectId) {
    return NextResponse.json({ error: 'missing_project_id', message: '缺少 projectId 参数' }, {
      status: 400,
      headers: BATCH_NO_STORE_HEADERS,
    });
  }
  try {
    await assertBatchApiReady();
    const media = await materializeProjectAssetThumbnail(getDb(), projectId, assetId);
    return projectAssetMediaResponse(request, media.absolutePath, 'image/jpeg');
  } catch (error) {
    return batchRouteErrorResponse(error, 'asset_thumbnail_failed', '素材缩略图生成失败');
  }
}
